import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { provision, instanceSpec } from "../src/provision.js";
import { offerQuery, pickOffer, hardwareOf } from "../src/offers.js";
import { envString } from "../src/clients/vast.js";
import { createDemo, transition, getDemo } from "../src/db.js";
import { config } from "../src/config.js";
import { resetDb, makeTestDeps, fakeStep } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");

async function bootingDemo() {
  const id = await createDemo(env.DB, { email: "a@acme-industries.com", domain: "acme-industries.com" }, NOW);
  await transition(env.DB, id, "checking", {}, { now: NOW });
  await transition(env.DB, id, "booting", { booting_at: new Date(NOW).toISOString(), step: "reserving" }, { now: NOW });
  return id;
}

describe("offers", () => {
  const cfg = config({});
  const offers = [
    { id: 1, machine_id: 1, num_gpus: 1, cpu_name: "Intel Core i9-14900K", cpu_ram: 200_000, dph_total: 0.5 },
    { id: 2, machine_id: 2, num_gpus: 1, cpu_name: "AMD EPYC 7763", cpu_ram: 195_000, dph_total: 0.8 },
    { id: 3, machine_id: 3, num_gpus: 1, cpu_name: "AMD EPYC 9654", cpu_ram: 130_000, dph_total: 0.4 },
  ];
  it("query uses the documented filters, MB for cpu_ram, lowest tier server-side", () => {
    const q = offerQuery(cfg);
    expect(q).toMatchObject({ verified: { eq: true }, num_gpus: { eq: 1 }, gpu_name: { eq: "RTX 5090" }, reliability: { gt: 0.99 }, inet_down: { gte: 1000 }, cpu_ram: { gte: 128_000 } });
    expect(q.cpu_name).toBeUndefined();
  });
  it("prefers the 192 GB tier, server CPUs within it, then falls back to 128 GB", () => {
    expect(pickOffer(offers, { tiersGb: [192, 128], preferCpu: ["EPYC", "Xeon"] })).toMatchObject({ offer: { id: 2 }, tierGb: 192 });
    expect(pickOffer(offers, { tiersGb: [192, 128], exclude: [1, 2], preferCpu: ["EPYC"] })).toMatchObject({ offer: { id: 3 }, tierGb: 128 });
    expect(pickOffer(offers, { tiersGb: [192, 128], exclude: [1, 2, 3] })).toBeNull();
  });
  it("hardware line from the offer", () => {
    expect(hardwareOf({ cpu_name: "AMD EPYC 9654", cpu_ram: 262_144, num_gpus: 1, gpu_name: "RTX_5090" })).toEqual({ cpu: "AMD EPYC 9654", ram_gb: 256, gpu: "1× RTX 5090" });
  });
  it("env string carries the instance contract and quotes values with spaces", () => {
    const spec = instanceSpec(config({ VAST_IMAGE: "img", MODEL_REPO: "Qwen/X", MODEL_FILES: "a.gguf", LLAMA_ARGS: "-ngl 99 --n-cpu-moe 40", DEMO_DOMAIN: "d" }), { demoId: "ab12", apiKey: "k1", tunnelToken: "tok" });
    expect(spec).toMatchObject({ image: "img", label: "locus-demo-ab12", cancel_unavail: true, disk: 250 });
    expect(spec.env).toBe('-e MODEL_REPO=Qwen/X -e MODEL_FILES=a.gguf -e RUNTIME=ik -e LLAMA_ARGS="-ngl 99 --n-cpu-moe 40" -e LLAMA_API_KEY=k1 -e CF_TUNNEL_TOKEN=tok -e DEMO_TTL_SECONDS=10800');
    expect(() => envString({ X: 'a"b' })).toThrow();
  });
  it("VAST_NUM_GPUS sets the query and which offers are picked", () => {
    const two = config({ VAST_NUM_GPUS: "2", VAST_GPU_NAME: "RTX 3090" });
    expect(offerQuery(two)).toMatchObject({ num_gpus: { eq: 2 }, gpu_name: { eq: "RTX 3090" } });
    const mixed = [...offers, { id: 9, machine_id: 9, num_gpus: 2, cpu_name: "AMD EPYC 7B13", cpu_ram: 250_000, dph_total: 0.9 }];
    expect(pickOffer(mixed, { tiersGb: [192, 128], preferCpu: ["EPYC"] })).toMatchObject({ offer: { id: 2 } });
    expect(pickOffer(mixed, { tiersGb: [192, 128], numGpus: 2 })).toMatchObject({ offer: { id: 9 }, tierGb: 192 });
    expect(hardwareOf(mixed[3]).gpu).toBe("2× GPU");
  });
  it("tiered box: SERVERS and per-server vars replace the single-model vars", () => {
    const cfg = config({
      VAST_IMAGE: "img", MODEL_REPO: "ignored/X", MODEL_FILES: "x.gguf",
      SERVERS: " DEEP  FAST ", DEEP_REPO: "unsloth/A", DEEP_FILES: "a-00001-of-00002.gguf a-00002-of-00002.gguf", DEEP_RUNTIME: "ik",
      DEEP_ARGS: "-ncmoe 20 -t 28", DEEP_GPUS: "0", DEEP_SLOTS: "4", DEEP_CTX: "32768", DEEP_ALIAS: "Qwen3.8-Flash-Next",
      FAST_REPO: "unsloth/B", FAST_FILES: "b.gguf", FAST_RUNTIME: "mainline", FAST_GPUS: "1,0", FAST_CTX: "16384",
      ROUTER_POLICY: "difficulty+spill", ROUTER_DEFAULT: "",
    });
    const spec = instanceSpec(cfg, { demoId: "ab12", apiKey: "k1", tunnelToken: "tok" });
    expect(spec.env).toBe(
      '-e SERVERS="DEEP FAST" -e DEEP_REPO=unsloth/A -e DEEP_FILES="a-00001-of-00002.gguf a-00002-of-00002.gguf" -e DEEP_RUNTIME=ik'
      + ' -e DEEP_ARGS="-ncmoe 20 -t 28" -e DEEP_GPUS=0 -e DEEP_ALIAS=Qwen3.8-Flash-Next -e DEEP_SLOTS=4 -e DEEP_CTX=32768'
      + ' -e FAST_REPO=unsloth/B -e FAST_FILES=b.gguf -e FAST_RUNTIME=mainline -e FAST_GPUS=1,0 -e FAST_CTX=16384'
      + ' -e ROUTER_POLICY=difficulty+spill -e LLAMA_API_KEY=k1 -e CF_TUNNEL_TOKEN=tok -e DEMO_TTL_SECONDS=10800');
    expect(config({}).tieredEnv).toBeNull();
    // a lower-case name cannot become an env var: renting fails loudly instead of booting a broken box
    expect(() => instanceSpec(config({ SERVERS: "deep", deep_REPO: "x" }), { demoId: "ab12", apiKey: "k", tunnelToken: "t" })).toThrow(/bad env name/);
  });
});

describe("provisioning workflow (fake step, fake clouds)", () => {
  beforeEach(resetDb);

  it("tunnel -> rent -> poll -> ready email -> 2h window -> teardown", async () => {
    const { deps, clock } = makeTestDeps();
    const id = await bootingDemo();
    const step = fakeStep(clock);
    const t0 = clock.t;
    let readySeen;
    const origSend = deps.email.send.bind(deps.email);
    deps.email.send = async (m) => { readySeen = await getDemo(env.DB, id); return origSend(m); };
    expect(await provision(deps, id, step)).toBe("ended");

    expect(readySeen.status).toBe("ready");
    expect(readySeen.hw_cpu).toMatch(/EPYC/);
    expect(readySeen.hw_ram_gb).toBe(251);
    expect(Date.parse(readySeen.ends_at) - Date.parse(readySeen.ready_at)).toBe(120 * 60_000);
    const mail = deps.email.sent[0];
    expect(mail.to).toBe("a@acme-industries.com");
    expect(mail.text).toMatch(/\/api\/demo\/confirm\?token=/);

    const spec = deps.vast.state.created[0].spec;
    expect(spec.env).toContain("CF_TUNNEL_TOKEN=token-for-tun-1");
    expect(spec.env).toContain(`LLAMA_API_KEY=${readySeen.api_key}`);
    expect(step.names).toEqual(["tunnel", "rent-1", "poll-1-0", "ready", "window", "teardown"]);
    expect(clock.t - t0).toBe(120 * 60_000);

    const end = await getDemo(env.DB, id);
    expect(end.status).toBe("ended");
    expect(deps.vast.state.instances.size).toBe(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
    expect(deps.cf.state.dns.size).toBe(0);
  });

  it("reports reserving/downloading/loading while the machine boots", async () => {
    const { deps, clock } = makeTestDeps();
    const id = await bootingDemo();
    const seq = [530, 530, 503, 200];
    const steps = [];
    deps.fetchFn = async (url) => {
      const s = seq.shift();
      steps.push((await getDemo(env.DB, id)).step);
      return new Response("", { status: s });
    };
    await provision(deps, id, fakeStep(clock));
    expect(steps).toEqual(["reserving", "downloading", "downloading", "loading"]);
  });

  it("a host that never becomes healthy is destroyed after 45 min and a different host is tried", async () => {
    const { deps, clock } = makeTestDeps();
    const id = await bootingDemo();
    let firstHostHealthy = false;
    deps.fetchFn = async () => {
      const current = (await getDemo(env.DB, id)).machine_id;
      return new Response("", { status: current === 11 && !firstHostHealthy ? 530 : 200 });
    };
    const step = fakeStep(clock);
    expect(await provision(deps, id, step)).toBe("ended");
    expect(deps.vast.state.created.map((c) => c.offerId)).toEqual([1, 2]);
    expect(deps.vast.state.destroyed).toContain(1000);
    expect(step.names).toContain("destroy-1");
    expect(step.names.filter((n) => n.startsWith("poll-1-")).length).toBe(91); // 45 min at 30 s
    expect(JSON.parse((await getDemo(env.DB, id)).tried_machines)).toEqual([11, 22]);
  });

  it("gives up after the second host, cleans up, and emails both sides", async () => {
    const { deps, clock } = makeTestDeps();
    const id = await bootingDemo();
    deps.fetchFn = async () => new Response("", { status: 530 });
    expect(await provision(deps, id, fakeStep(clock))).toBe("failed");
    const d = await getDemo(env.DB, id);
    expect(d.status).toBe("failed");
    expect(d.failed_reason).toMatch(/2 attempts/);
    expect(deps.vast.state.instances.size).toBe(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
    expect(deps.email.sent.map((m) => m.to).sort()).toEqual(["a@acme-industries.com", "owner@locus.test"]);
  });

  it("a dead container (exited) fails the attempt without waiting 45 minutes", async () => {
    const { deps, clock } = makeTestDeps();
    const id = await bootingDemo();
    const origCreate = deps.vast.createInstance;
    let n = 0;
    deps.vast.createInstance = async (offerId, spec) => {
      const r = await origCreate(offerId, spec);
      if (n++ === 0) deps.vast.state.instances.get(r.instanceId).actual_status = "exited";
      return r;
    };
    const step = fakeStep(clock);
    expect(await provision(deps, id, step)).toBe("ended");
    expect(step.names.slice(0, 5)).toEqual(["tunnel", "rent-1", "poll-1-0", "destroy-1", "rent-2"]);
  });
});
