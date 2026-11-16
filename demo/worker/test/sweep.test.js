import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { planSweep, runSweep } from "../src/sweep.js";
import { config } from "../src/config.js";
import { createDemo, transition, updateDemo, getDemo } from "../src/db.js";
import { resetDb, makeTestDeps } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const MIN = 60_000;
const cfg = config({});
const ago = (m) => new Date(NOW - m * MIN).toISOString();
const secAgo = (m) => (NOW - m * MIN) / 1000;
const demo = (id, o = {}) => ({ id, status: "ready", ends_at: new Date(NOW + 60 * MIN).toISOString(), booting_at: ago(30), updated_at: ago(30), vast_instance_id: 1, tunnel_id: `t-${id}`, ...o });
const inst = (id, demoId, ageMin = 60) => ({ id, label: `locus-demo-${demoId}`, start_date: secAgo(ageMin) });
const plan = (p) => planSweep({ instances: [], tunnels: [], dns: [], demos: {}, workflows: {}, now: NOW, cfg, ...p });
const destroyed = (p) => p.destroyInstances.map((x) => x.id);

describe("sweep decisions", () => {
  it("leaves a healthy running demo alone", () => {
    const p = plan({ instances: [inst(1, "aa")], demos: { aa: demo("aa") }, workflows: { aa: "running" } });
    expect(p).toEqual({ destroyInstances: [], deleteTunnels: [], deleteDns: [], endDemos: [], failDemos: [] });
  });

  it("destroys instances unknown to D1, but ignores ones that are not ours", () => {
    const p = plan({ instances: [inst(7, "ffff"), { id: 8, label: "my-own-box", start_date: secAgo(500) }] });
    expect(destroyed(p)).toEqual([7]);
    expect(p.destroyInstances[0].reason).toMatch(/unknown/);
  });

  it("ends a demo past its window (+grace) and destroys its machine", () => {
    const d = demo("aa", { ends_at: ago(cfg.sweepGraceMinutes + 1) });
    const p = plan({ instances: [inst(1, "aa")], demos: { aa: d }, workflows: { aa: "running" } });
    expect(p.endDemos).toEqual(["aa"]);
    expect(destroyed(p)).toEqual([1]);
  });

  it("does not end a demo inside the grace period", () => {
    const p = plan({ instances: [inst(1, "aa")], demos: { aa: demo("aa", { ends_at: ago(2) }) } });
    expect(p.endDemos).toEqual([]);
  });

  it("fails a boot that overran the whole boot budget", () => {
    const d = demo("aa", { status: "booting", booting_at: ago(cfg.bootTimeoutMinutes * cfg.bootAttempts + 31) });
    const p = plan({ instances: [inst(1, "aa")], demos: { aa: d }, workflows: { aa: "running" } });
    expect(p.failDemos).toEqual(["aa"]);
    expect(destroyed(p)).toEqual([1]);
  });

  it("closes a demo whose Workflow was killed (errored/terminated/missing)", () => {
    for (const wf of ["errored", "terminated", "missing"]) {
      const p = plan({ instances: [inst(1, "aa")], demos: { aa: demo("aa", { status: "booting" }) }, workflows: { aa: wf } });
      expect(p.failDemos, wf).toEqual(["aa"]);
      expect(destroyed(p), wf).toEqual([1]);
    }
  });

  it("destroys instances of terminal demos and stale instances from an earlier attempt", () => {
    expect(destroyed(plan({ instances: [inst(1, "aa")], demos: { aa: demo("aa", { status: "ended" }) } }))).toEqual([1]);
    const p = plan({ instances: [inst(1, "aa", 30), inst(2, "aa", 5)], demos: { aa: demo("aa", { status: "booting", vast_instance_id: 2 }) }, workflows: { aa: "running" } });
    expect(destroyed(p)).toEqual([1]);
  });

  it("gives a just-created instance time to be recorded in D1", () => {
    const p = plan({ instances: [inst(2, "aa", 2)], demos: { aa: demo("aa", { status: "booting", vast_instance_id: null }) }, workflows: { aa: "running" } });
    expect(destroyed(p)).toEqual([]);
  });

  it("removes orphan tunnels and DNS records, not live or brand-new ones", () => {
    const tunnels = [
      { id: "t-aa", name: "locus-demo-aa", created_at: ago(60) },
      { id: "t-bb", name: "locus-demo-bb", created_at: ago(60) },
      { id: "t-cc", name: "locus-demo-cc", created_at: ago(1) },
      { id: "t-x", name: "other-tunnel", created_at: ago(600) },
    ];
    const dns = [
      { id: "d-aa", name: "locus-demo-aa.demo.example.com", content: "t-aa.cfargotunnel.com", created_on: ago(60) },
      { id: "d-bb", name: "locus-demo-bb.demo.example.com", content: "t-bb.cfargotunnel.com", created_on: ago(60) },
    ];
    const p = plan({ tunnels, dns, demos: { aa: demo("aa"), bb: demo("bb", { status: "failed" }) }, workflows: { aa: "running" } });
    expect(p.deleteTunnels.map((t) => t.id)).toEqual(["t-bb"]);
    expect(p.deleteDns.map((d) => d.id)).toEqual(["d-bb"]);
  });

  it("expires demos queued for too long", () => {
    const p = plan({ demos: { aa: demo("aa", { status: "queued", queued_at: ago(cfg.caps.queueMaxHours * 60 + 1) }) } });
    expect(p.failDemos).toEqual(["aa"]);
  });
});

describe("runSweep against fakes + D1", () => {
  beforeEach(resetDb);

  it("kills the machine of a demo whose Workflow died, cleans the tunnel, admits the queue", async () => {
    const { deps, clock, created } = makeTestDeps();
    const id = await createDemo(env.DB, { email: "a@acme-industries.com", domain: "acme-industries.com" }, NOW - 60 * MIN);
    await transition(env.DB, id, "checking", { confirmed_at: ago(60) }, { now: NOW - 60 * MIN });
    await transition(env.DB, id, "booting", { booting_at: ago(60) }, { now: NOW - 60 * MIN });
    const t = await deps.cf.createTunnel(`locus-demo-${id}`);
    t.created_at = ago(60);
    const { instanceId } = await deps.vast.createInstance(1, { label: `locus-demo-${id}` });
    await updateDemo(env.DB, id, { vast_instance_id: instanceId, tunnel_id: t.id }, NOW - 60 * MIN);
    const q = await createDemo(env.DB, { email: "q@other.com", domain: "other.com" }, NOW);
    await transition(env.DB, q, "checking", { confirmed_at: ago(1) }, { now: NOW });
    await transition(env.DB, q, "queued", { queued_at: ago(1) }, { now: NOW });

    deps.workflows.provision.get = async () => { throw new Error("instance not found"); };
    const { plan: p, admitted } = await runSweep(deps);
    expect(p.failDemos).toEqual([id]);
    expect(deps.vast.state.instances.size).toBe(0);
    expect(deps.cf.state.tunnels.size).toBe(0);
    expect((await getDemo(env.DB, id)).status).toBe("failed");
    expect(admitted).toEqual([q]);
    expect(created.provision.map((x) => x.params.demoId)).toEqual([q]);
  });
});
