import { beforeEach, describe, expect, it } from "vitest";
import { getDemo } from "../src/db.js";
import { RECORDING_EPYC_OFFER, RECORDING_OFFER, RECORDING_TIERED_OFFER, fakeVast } from "../src/fakes.js";
import { handle } from "../src/index.js";
import { provision, rentStep, tunnelStep } from "../src/provision.js";
import { runSweep } from "../src/sweep.js";
import { cookieFrom, fakeStep, makeTestDeps, resetDb } from "./helpers.js";

const ROOT = "http://127.0.0.1:8787/api/demo";
const KEY = crypto.randomUUID();
const EXPIRES_AT = "2026-11-16T12:20:00.000Z";
const payload = { profile: "threadripper", users: "1", key: KEY };

function fixture(vars = {}, offers = [RECORDING_OFFER]) {
  const test = makeTestDeps({ vars: {
    DEV_FAKES: "1", RECORDING_TAKE_ID: "november-1", RECORDING_ACCESS_KEY: KEY,
    RECORDING_EXPIRES_AT: EXPIRES_AT, RECORDING_MAX_DPH: "0.6", RECORDING_OFFER_ID: "3",
    ...vars,
  } });
  test.deps.vast = fakeVast({ offers });
  const workflowIds = new Set();
  test.deps.workflows.provision.create = async (options) => {
    if (workflowIds.has(options.id)) throw new Error("Workflow already exists");
    workflowIds.add(options.id);
    test.created.provision.push(options);
  };
  return test;
}

function call(deps, path, body, headers = {}) {
  return handle(body ? new Request(ROOT + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }) : new Request(ROOT + path, { headers }), deps);
}

const start = (deps, body = payload) => call(deps, "/recording/start", body);
const status = (deps, cookie) => call(deps, "/status", null, { cookie }).then((response) => response.json());

describe("private recording", () => {
  beforeEach(resetDb);

  it("keeps the routes on loopback and validates the key before searching", async () => {
    const { deps } = fixture();
    const publicRequest = new Request("https://site.test/api/demo/recording/catalog");
    expect((await handle(publicRequest, deps)).status).toBe(404);
    expect((await call(makeTestDeps().deps, "/recording/catalog")).status).toBe(404);
    deps.vast.searchOffers = () => { throw new Error("should not search"); };
    expect((await start(deps, { ...payload, key: "wrong" })).status).toBe(401);
    expect((await call(deps, "/recording/start", payload, { origin: "https://other.test" })).status).toBe(403);
    const { deps: unarmed } = fixture({ RECORDING_EXPIRES_AT: "" });
    expect((await start(unarmed)).status).toBe(503);
    expect((await call(deps, "/recording/catalog")).status).toBe(200);
    expect((await call(deps, "/request", {})).status).toBe(404);
  });

  it("refuses wrong hardware and offers above the armed ceiling", async () => {
    const { deps } = fixture({}, [{ ...RECORDING_OFFER, dph_total: 0.61 }]);
    const response = await call(deps, "/recording/recommendation", payload);
    expect(await response.json()).toMatchObject({ available: false, recommendation: { gpu: "1× RTX 3090" } });
    expect((await start(deps)).status).toBe(409);
    const { deps: matching } = fixture();
    expect((await start(matching, { ...payload, profile: "epyc" })).status).toBe(409);
    expect(matching.vast.state.created).toHaveLength(0);
  });

  it("gives simultaneous starts and refreshes one session with a reserved deadline", async () => {
    const { deps, created, clock } = fixture();
    const [a, b] = await Promise.all([start(deps), start(deps)]);
    const { session: id } = await a.json();
    expect(await b.json()).toMatchObject({ session: id });
    expect(created.provision).toHaveLength(1);
    const cookie = cookieFrom(a);
    expect(await status(deps, cookie)).toMatchObject({ status: "booting", step: "reserving", recording: "preview" });

    let ready;
    const step = fakeStep(clock);
    const sleep = step.sleep;
    step.sleep = async (name, ms) => {
      if (name === "window") ready = await status(deps, cookie);
      await sleep(name, ms);
    };
    expect(await provision(deps, id, step)).toBe("ended");
    expect(ready).toMatchObject({
      status: "ready", ends_at: EXPIRES_AT,
      hardware: { cpu: RECORDING_OFFER.cpu_name, ram_gb: 256, gpu: "1× RTX 3090" },
    });
    expect(deps.vast.state.created).toHaveLength(1);
    expect(deps.vast.state.created[0].spec).toMatchObject({ label: `locus-recording-${id}` });
    expect(deps.vast.state.created[0].spec.env).toContain(`DEMO_EXPIRES_AT=${Date.parse(EXPIRES_AT) / 1000}`);
    expect(deps.vast.state.instances.size).toBe(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
    expect(deps.cf.state.dns.size).toBe(0);
    expect(deps.email.sent).toHaveLength(0);
  });

  it("reserves the PCIe 4.0 EPYC fallback and keeps both models on that session", async () => {
    const { deps, clock, llama } = fixture({
      RECORDING_OFFER_ID: "5", RECORDING_MAX_DPH: "1",
      SERVERS: "DEEP FAST", DEEP_REPO: "unsloth/Qwen3.8-Flash-Next-GGUF", FAST_REPO: "unsloth/Qwen3.8-27B-GGUF",
    }, [RECORDING_OFFER, RECORDING_TIERED_OFFER, RECORDING_EPYC_OFFER]);
    const smaller = { ...payload, profile: "epyc-7742" };
    const larger = { ...smaller, users: "8" };
    const search = deps.vast.searchOffers;
    deps.vast.searchOffers = async () => [{ ...RECORDING_EPYC_OFFER, pci_gen: 3 }];
    expect((await start(deps, larger)).status).toBe(409);
    deps.vast.searchOffers = search;
    expect(await (await call(deps, "/recording/recommendation", smaller)).json()).toMatchObject({
      available: false, recommendation: { gpu: "1× RTX 3090" },
    });
    expect(await (await call(deps, "/recording/recommendation", larger)).json()).toMatchObject({
      available: true, recommendation: { gpu: "2× RTX 3090", model: "Qwen3.8-Flash-Next + Qwen3.8-27B" },
    });
    const response = await start(deps, larger);
    const { session: id } = await response.json();
    expect((await start(deps, smaller)).status).toBe(409);
    expect((await getDemo(deps.db, id)).recording_users).toBe(8);

    const cookie = cookieFrom(response);
    const step = fakeStep(clock);
    const sleep = step.sleep;
    step.sleep = async (name, ms) => {
      if (name === "window") {
        expect(await status(deps, cookie)).toMatchObject({
          status: "ready", hardware: { cpu: RECORDING_EPYC_OFFER.cpu_name, gpu: "2× RTX 3090" },
          models: [{ id: "fast", label: "Qwen3.8-27B" }, { id: "deep", label: "Qwen3.8-Flash-Next" }],
        });
        const chat = await call(deps, "/chat", {
          model: "deep", messages: [{ role: "user", content: "Review this invoice" }],
        }, { cookie });
        expect(chat.status).toBe(200);
        await chat.text();
        expect(llama.calls.at(-1).body.model).toBe("deep");
      }
      await sleep(name, ms);
    };
    expect(await provision(deps, id, step)).toBe("ended");
    expect(deps.vast.state.created).toHaveLength(1);
    expect(deps.vast.state.created[0].offerId).toBe(5);
    expect(deps.vast.state.created[0].spec.env).toContain('SERVERS="DEEP FAST"');
  });

  it("returns the same take after a failed workflow start", async () => {
    const { deps } = fixture();
    const binding = deps.workflows.provision;
    deps.workflows.provision = { create: async () => { throw new Error("offline"); }, get: async () => { throw new Error("missing"); } };
    expect((await start(deps)).status).toBe(503);
    deps.workflows.provision = binding;
    expect((await start(deps)).status).toBe(200);
    expect(deps.vast.state.created).toHaveLength(0);
  });

  it("does not book an offer that disappears after start preflight", async () => {
    const { deps, clock } = fixture();
    const { session: id } = await (await start(deps)).json();
    deps.vast.searchOffers = async () => [];
    expect(await provision(deps, id, fakeStep(clock))).toBe("failed");
    expect((await getDemo(deps.db, id)).failed_reason).toMatch(/offer is no longer available/);
    expect(deps.vast.state.created).toHaveLength(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
  });

  it("reconciles a lost Vast reply by label without booking twice", async () => {
    const { deps } = fixture();
    const { session: id } = await (await start(deps)).json();
    const { tunnelId } = await tunnelStep(deps, id);
    const create = deps.vast.createInstance;
    deps.vast.createInstance = async (...args) => {
      await create(...args);
      throw new Error("Lost reply");
    };
    await expect(rentStep(deps, id, tunnelId)).rejects.toThrow("Lost reply");
    const matches = await deps.vast.listInstances();
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe(`locus-recording-${id}`);
    expect(await rentStep(deps, id, tunnelId)).toMatchObject({ instanceId: matches[0].id });
    expect(deps.vast.state.created).toHaveLength(1);
  });

  it("sweeps an expired booking whose contract ID was never recorded", async () => {
    const { deps, clock } = fixture();
    const response = await start(deps);
    const { session: id } = await response.json();
    const { tunnelId } = await tunnelStep(deps, id);
    const create = deps.vast.createInstance;
    deps.vast.createInstance = async (...args) => {
      await create(...args);
      throw new Error("Lost reply");
    };
    await expect(rentStep(deps, id, tunnelId)).rejects.toThrow("Lost reply");
    clock.t = Date.parse(EXPIRES_AT);
    expect(await status(deps, cookieFrom(response))).toMatchObject({ status: "ended" });
    await runSweep(deps);
    expect((await getDemo(deps.db, id)).status).toBe("ended");
    expect(deps.vast.state.instances.size).toBe(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
    expect(deps.cf.state.dns.size).toBe(0);
  });
});
