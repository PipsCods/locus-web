import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { sign, verify, issue, redeem } from "../src/tokens.js";
import { SECRET, resetDb } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");

describe("tokens", () => {
  beforeEach(resetDb);

  it("round-trips a signed payload for the right purpose", async () => {
    const t = await issue(SECRET, "access", "abc", 60, {}, NOW);
    expect((await verify(SECRET, t, "access", NOW)).d).toBe("abc");
  });

  it("rejects another purpose, a forged signature, a tampered payload and a wrong secret", async () => {
    const t = await issue(SECRET, "access", "abc", 60, {}, NOW);
    expect(await verify(SECRET, t, "session", NOW)).toBeNull();
    const [body, mac] = t.split(".");
    expect(await verify(SECRET, `${body}.${mac.slice(0, -2)}AA`, "access", NOW)).toBeNull();
    const forged = btoa(JSON.stringify({ p: "access", d: "other", exp: 9e9 })).replace(/=+$/, "");
    expect(await verify(SECRET, `${forged}.${mac}`, "access", NOW)).toBeNull();
    expect(await verify("another-secret-another-secret-another", t, "access", NOW)).toBeNull();
    expect(await verify(SECRET, "garbage", "access", NOW)).toBeNull();
    expect(await verify(SECRET, `${t}.extra`, "access", NOW)).toBeNull();
  });

  it("expires", async () => {
    const t = await issue(SECRET, "access", "abc", 60, {}, NOW);
    expect(await verify(SECRET, t, "access", NOW + 59_000)).not.toBeNull();
    expect(await verify(SECRET, t, "access", NOW + 60_000)).toBeNull();
  });

  it("single-use links work exactly once", async () => {
    const t = await issue(SECRET, "confirm", "abc", 3600, {}, NOW);
    expect((await redeem(SECRET, env.DB, t, "confirm", NOW)).payload.d).toBe("abc");
    expect((await redeem(SECRET, env.DB, t, "confirm", NOW)).error).toBe("used");
    const other = await issue(SECRET, "confirm", "abc", 3600, {}, NOW);
    expect((await redeem(SECRET, env.DB, other, "confirm", NOW)).payload).toBeTruthy(); // fresh nonce
  });

  it("refuses a short signing secret", async () => {
    await expect(sign("short", { p: "x" })).rejects.toThrow(/SIGNING_SECRET/);
  });
});
