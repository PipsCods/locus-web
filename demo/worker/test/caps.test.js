import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { requestCapError, canAdmit } from "../src/caps.js";
import { createDemo, transition, admitToBooting, capCounts, getDemo } from "../src/db.js";
import { admit } from "../src/pipeline.js";
import { config } from "../src/config.js";
import { resetDb, makeTestDeps } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const caps = config({}).caps;
const zero = { ipRecent: 0, pendingForEmail: 0, emailRecent: 0, domainRecent: 0, dailyTotal: 0 };

async function confirmed(email, at = NOW) {
  const id = await createDemo(env.DB, { email, domain: email.split("@")[1], ip: "1.2.3.4" }, at);
  await transition(env.DB, id, "checking", { confirmed_at: new Date(at).toISOString() }, { now: at });
  return id;
}

describe("caps (pure)", () => {
  it("defaults match the plan", () => expect(caps).toMatchObject({ maxConcurrent: 2, perEmailDays: 7, perDomainHours: 24 }));
  it("each limit refuses on its own", () => {
    expect(requestCapError(zero, caps)).toBeNull();
    for (const k of ["ipRecent", "emailRecent", "domainRecent"]) expect(requestCapError({ ...zero, [k]: k === "ipRecent" ? 5 : 1 }, caps), k).toBeTruthy();
    expect(requestCapError({ ...zero, dailyTotal: caps.dailyTotal }, caps)).toMatch(/Today/);
    expect(requestCapError({ ...zero, pendingForEmail: 3 }, caps)).toMatch(/inbox/);
  });
  it("canAdmit", () => {
    expect(canAdmit({ active: 1, startedToday: 0 }, caps)).toBe(true);
    expect(canAdmit({ active: 2, startedToday: 0 }, caps)).toBe(false);
    expect(canAdmit({ active: 0, startedToday: caps.dailyTotal }, caps)).toBe(false);
  });
  it("is configurable", () => expect(config({ CAP_MAX_CONCURRENT: "5", CAP_DAILY_TOTAL: "1" }).caps).toMatchObject({ maxConcurrent: 5, dailyTotal: 1 }));
});

describe("caps (D1)", () => {
  beforeEach(resetDb);

  it("one per email per 7 days, one per domain per day", async () => {
    await confirmed("jane@acme-industries.com", NOW - 3 * 86400_000);
    let c = await capCounts(env.DB, { email: "jane@acme-industries.com", domain: "acme-industries.com", ip: "9.9.9.9" }, caps, NOW);
    expect(c.emailRecent).toBe(1);
    expect(c.domainRecent).toBe(0); // 3 days ago: outside the 24h domain window
    c = await capCounts(env.DB, { email: "jane@acme-industries.com", domain: "acme-industries.com", ip: "9.9.9.9" }, caps, NOW + 5 * 86400_000);
    expect(c.emailRecent).toBe(0);
    await confirmed("bob@acme-industries.com", NOW - 3600_000);
    c = await capCounts(env.DB, { email: "carol@acme-industries.com", domain: "acme-industries.com", ip: "9.9.9.9" }, caps, NOW);
    expect(c.domainRecent).toBe(1);
  });

  it("a rejected or unconfirmed request does not use up the email's allowance", async () => {
    const id = await confirmed("jane@acme-industries.com");
    await transition(env.DB, id, "rejected", {}, { now: NOW });
    await createDemo(env.DB, { email: "jane@acme-industries.com", domain: "acme-industries.com" }, NOW);
    const c = await capCounts(env.DB, { email: "jane@acme-industries.com", domain: "acme-industries.com", ip: "" }, caps, NOW);
    expect(c.emailRecent).toBe(0);
    expect(c.pendingForEmail).toBe(1);
  });

  it("third concurrent demo is queued, then admitted when a slot frees", async () => {
    const { deps, created } = makeTestDeps();
    const a = await confirmed("a@one.com"), b = await confirmed("b@two.com"), c = await confirmed("c@three.com");
    expect(await admit(deps, a)).toBe("booting");
    expect(await admit(deps, b)).toBe("booting");
    expect(await admit(deps, c)).toBe("queued");
    expect(created.provision.map((p) => p.params.demoId)).toEqual([a, b]);
    await transition(env.DB, a, "failed", {}, { now: NOW });
    expect(await admitToBooting(env.DB, c, caps, NOW)).toBe(true);
    expect((await getDemo(env.DB, c)).status).toBe("booting");
  });

  it("the daily total holds even with free slots", async () => {
    const { deps } = makeTestDeps({ vars: { CAP_DAILY_TOTAL: "1", CAP_MAX_CONCURRENT: "5" } });
    const a = await confirmed("a@one.com"), b = await confirmed("b@two.com");
    expect(await admit(deps, a)).toBe("booting");
    await transition(env.DB, a, "ended", {}, { now: NOW });
    expect(await admit(deps, b)).toBe("queued");
  });

  it("concurrent admissions cannot exceed the cap", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await confirmed(`u${i}@d${i}.com`));
    const results = await Promise.all(ids.map((id) => admitToBooting(env.DB, id, caps, NOW)));
    expect(results.filter(Boolean)).toHaveLength(2);
  });
});
