// Shared test wiring: real local D1 + in-memory fakes for every outside service.
import { env } from "cloudflare:workers";
import { config } from "../src/config.js";
import { fakeNetFetch, fakeLlama, fakeEmail, fakeTurnstile, fakeOpenAI, fakeVast, fakeCloudflare } from "../src/fakes.js";

export const SECRET = "test-secret-test-secret-test-secret-0123";

export function makeTestDeps({ vars = {}, openai, llama, now } = {}) {
  const clock = { t: now ?? Date.parse("2026-11-16T12:00:00Z") };
  const cfg = config({ SIGNING_SECRET: SECRET, OWNER_EMAIL: "owner@locus.test", DEMO_DOMAIN: "demo.locus.test", VAST_IMAGE: "ghcr.io/x/locus-demo:1", SITE_URL: "https://site.test", ...vars });
  const l = llama ?? fakeLlama();
  const created = { checks: [], provision: [] };
  const deps = {
    cfg,
    db: env.DB,
    now: () => clock.t,
    fetchFn: fakeNetFetch({ now: () => clock.t, upstream: l.handler }),
    turnstile: fakeTurnstile(),
    email: fakeEmail(),
    openai: openai ?? fakeOpenAI(),
    vast: fakeVast(),
    cf: fakeCloudflare(),
    workflows: {
      checks: { create: async (o) => created.checks.push(o) },
      provision: { create: async (o) => created.provision.push(o), get: async () => ({ status: async () => ({ status: "running" }) }) },
    },
  };
  return { deps, clock, llama: l, created };
}

/** A Workflows `step` stand-in that runs steps inline and advances the fake clock on sleep. */
export function fakeStep(clock) {
  const names = [];
  return {
    names,
    async do(name, a, b) { names.push(name); return (b ?? a)(); },
    async sleep(name, ms) { names.push(name); clock.t += typeof ms === "number" ? ms : 0; },
  };
}

export async function resetDb() {
  await env.DB.exec("DELETE FROM demos; DELETE FROM used_tokens;");
}

export const req = (path, init = {}) => new Request(`https://site.test${path}`, init);
export const postJson = (path, body, headers = {}) => req(path, { method: "POST", headers: { "content-type": "application/json", origin: "https://site.test", ...headers }, body: JSON.stringify(body) });
export const cookieFrom = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
