import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { canTransition, publicStatus, TRANSITIONS, sourcesOf } from "../src/status.js";
import { createDemo, getDemo, transition } from "../src/db.js";
import { resetDb } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");

describe("status machine", () => {
  beforeEach(resetDb);

  it("allows the happy path and nothing out of terminal states", () => {
    const path = ["pending_email", "checking", "queued", "booting", "ready", "ended"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    for (const t of ["rejected", "ended", "failed"]) expect(TRANSITIONS[t]).toEqual([]);
    expect(canTransition("pending_email", "booting")).toBe(false); // no skipping the checks
    expect(canTransition("rejected", "booting")).toBe(false);
    expect(canTransition("review", "ready")).toBe(false);
    expect(sourcesOf("booting").sort()).toEqual(["checking", "queued", "review"]);
  });

  it("transition() is conditional on the current status in D1", async () => {
    const id = await createDemo(env.DB, { email: "a@acme-industries.com", domain: "acme-industries.com" }, NOW);
    expect(await transition(env.DB, id, "booting", {}, { now: NOW })).toBe(false); // pending_email cannot boot
    expect(await transition(env.DB, id, "checking", { confirmed_at: "x" }, { now: NOW })).toBe(true);
    expect(await transition(env.DB, id, "checking", {}, { now: NOW })).toBe(false); // second confirm is a no-op
    expect(await transition(env.DB, id, "rejected", {}, { now: NOW })).toBe(true);
    expect(await transition(env.DB, id, "booting", {}, { now: NOW })).toBe(false);
    expect((await getDemo(env.DB, id)).status).toBe("rejected");
  });

  it("public view: none for unconfirmed, booting step + eta, ready with hardware, ended after the window, no secrets", () => {
    expect(publicStatus(null)).toEqual({ ok: true, status: "none" });
    expect(publicStatus({ status: "pending_email" }).status).toBe("none");
    const b = publicStatus({ status: "booting", step: "downloading", hw_cpu: "AMD EPYC 9654", hw_ram_gb: 251, hw_gpu: "1× RTX 5090" });
    expect(b).toMatchObject({ status: "booting", step: "downloading", eta_minutes: 25, hardware: { cpu: "AMD EPYC 9654", ram_gb: 251, gpu: "1× RTX 5090" } });
    const row = { status: "ready", ends_at: new Date(NOW + 3600_000).toISOString(), hw_cpu: "c", hw_ram_gb: 128, hw_gpu: "g", model: "Qwen", api_key: "SECRET", hostname: "h.example" };
    const r = publicStatus(row, NOW);
    expect(r).toMatchObject({ status: "ready", ends_at: row.ends_at, model: "Qwen" });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|h\.example/);
    expect(publicStatus(row, NOW + 2 * 3600_000).status).toBe("ended");
  });
});
