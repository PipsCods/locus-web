// Cron sweep (every 5 minutes): the safety net under the Workflow and the container's own timer.
//
// planSweep() is pure: given what exists at Vast and Cloudflare and what D1 knows, it returns
// what to destroy and which demos to close. runSweep() gathers the inputs, applies the plan
// (bounded per run to stay under the free plan's 50 subrequests), and admits queued demos.

import { TERMINAL, ACTIVE } from "./status.js";
import { transition, listByStatus } from "./db.js";
import { teardown } from "./provision.js";
import { admit } from "./pipeline.js";

const MIN = 60_000;
const ts = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v ?? "")); // Vast start_date is unix seconds
const DEAD_WORKFLOW = new Set(["errored", "terminated", "complete", "unknown", "missing"]);

/**
 * @param {object} p
 * @param {Array} p.instances  Vast instances ({id, label, start_date})
 * @param {Array} p.tunnels    CF tunnels ({id, name, created_at})
 * @param {Array} p.dns        CF DNS records ({id, name, content, created_on})
 * @param {Object} p.demos     demo rows by id (every id referenced by a resource, plus active/queued rows)
 * @param {Object} p.workflows provisioning workflow status by demo id
 */
export function planSweep({ instances, tunnels, dns, demos, workflows = {}, now, cfg }) {
  const grace = cfg.sweepGraceMinutes * MIN;
  const bootBudget = (cfg.bootTimeoutMinutes * cfg.bootAttempts + 30) * MIN;
  const prefix = cfg.resourcePrefix;
  const plan = { destroyInstances: [], deleteTunnels: [], deleteDns: [], endDemos: [], failDemos: [] };
  const closing = new Map(); // demo id -> "ended" | "failed"

  // 1. demos whose time is up, whatever happened to their Workflow
  for (const d of Object.values(demos)) {
    if (ACTIVE.includes(d.status) && Date.parse(d.recording_expires_at) <= now) closing.set(d.id, "ended");
    else if (d.status === "ready" && d.ends_at && now > Date.parse(d.ends_at) + grace) closing.set(d.id, "ended");
    else if (d.status === "booting" && now > Date.parse(d.booting_at ?? d.updated_at) + bootBudget) closing.set(d.id, "failed");
    else if (ACTIVE.includes(d.status) && DEAD_WORKFLOW.has(workflows[d.id]) && now > Date.parse(d.updated_at) + grace) closing.set(d.id, d.status === "ready" ? "ended" : "failed");
    else if (d.status === "queued" && now > Date.parse(d.queued_at ?? d.updated_at) + cfg.caps.queueMaxHours * 3600_000) closing.set(d.id, "failed");
  }
  for (const [id, to] of closing) (to === "ended" ? plan.endDemos : plan.failDemos).push(id);

  const owner = (name) => (name?.startsWith(prefix) ? name.slice(prefix.length).split(".")[0] : null);
  const gone = (d) => !d || TERMINAL.includes(d.status) || closing.has(d.id);

  // 2. machines
  for (const inst of instances) {
    const id = owner(inst.label);
    if (!id) continue; // not ours
    const d = demos[id];
    const age = now - ts(inst.start_date);
    let reason = null;
    if (!d) reason = "unknown to D1";
    else if (gone(d)) reason = `demo ${closing.get(id) ?? d.status}`;
    else if (!ACTIVE.includes(d.status) && age > grace) reason = `demo is ${d.status}`;
    else if (Number(d.vast_instance_id) !== Number(inst.id) && age > grace) reason = "stale instance from an earlier attempt";
    if (reason) plan.destroyInstances.push({ id: inst.id, demoId: id, reason });
  }

  // 3. tunnels and DNS records (only once they are older than the grace period: creation is not atomic)
  for (const t of tunnels) {
    const id = owner(t.name);
    if (!id || now - ts(t.created_at) < grace) continue;
    const d = demos[id];
    if (gone(d) || (d.tunnel_id && d.tunnel_id !== t.id)) plan.deleteTunnels.push({ id: t.id, demoId: id });
  }
  for (const r of dns) {
    const id = owner(r.name);
    if (!id || now - ts(r.created_on) < grace) continue;
    const d = demos[id];
    if (gone(d) || (d.tunnel_id && r.content !== `${d.tunnel_id}.cfargotunnel.com`)) plan.deleteDns.push({ id: r.id, demoId: id });
  }
  return plan;
}

async function workflowStatus(binding, demoId) {
  try {
    const inst = await binding.get(`prov-${demoId}`);
    return (await inst.status())?.status ?? "unknown";
  } catch {
    return "missing";
  }
}

export async function runSweep(deps, { maxActions = 12 } = {}) {
  const { db, cfg, vast, cf } = deps;
  // Manual mode (one hand-started machine) runs without Vast: nothing was rented, so nothing to sweep.
  if (!cfg.vastKey) return { skipped: "VAST_API_KEY not set" };
  const now = deps.now();
  const prefix = cfg.resourcePrefix;
  const [instances, tunnels, dns] = await Promise.all([
    vast.listInstances().catch((e) => (console.error("sweep: vast list failed", e), [])),
    cf.listTunnels(prefix).catch((e) => (console.error("sweep: tunnel list failed", e), [])),
    cf.listDns(prefix).catch((e) => (console.error("sweep: dns list failed", e), [])),
  ]);
  const ids = new Set();
  for (const x of instances) if (x.label?.startsWith(prefix)) ids.add(x.label.slice(prefix.length));
  for (const x of tunnels) if (x.name?.startsWith(prefix)) ids.add(x.name.slice(prefix.length));
  for (const x of dns) if (x.name?.startsWith(prefix)) ids.add(x.name.slice(prefix.length).split(".")[0]);
  const demos = {};
  for (const row of await listByStatus(db, ["booting", "ready", "queued"])) {
    if (Boolean(row.recording_profile) === Boolean(cfg.recording)) demos[row.id] = row;
  }
  const missing = [...ids].filter((id) => !demos[id] && /^[0-9a-f]{20}$/.test(id));
  if (missing.length) {
    const rows = await db.prepare(`SELECT * FROM demos WHERE id IN (${missing.map(() => "?").join(",")})`).bind(...missing).all();
    for (const row of rows.results ?? []) {
      if (Boolean(row.recording_profile) === Boolean(cfg.recording)) demos[row.id] = row;
    }
  }
  const workflows = {};
  for (const d of Object.values(demos)) if (ACTIVE.includes(d.status) && deps.workflows?.provision) workflows[d.id] = await workflowStatus(deps.workflows.provision, d.id);

  const plan = planSweep({ instances, tunnels, dns, demos, workflows, now, cfg });
  let budget = maxActions;
  const act = async (label, fn) => {
    if (budget-- <= 0) return;
    try { await fn(); } catch (err) { console.error(`sweep: ${label} failed`, err); }
  };
  for (const id of plan.endDemos) await act(`end ${id}`, async () => {
    await transition(db, id, "ended", { ended_at: new Date(now).toISOString() }, { from: ["ready", "booting"], now });
    await teardown(deps, id);
  });
  for (const id of plan.failDemos) await act(`fail ${id}`, async () => {
    await transition(db, id, "failed", { failed_reason: "closed by sweep" }, { from: ["booting", "ready", "queued"], now });
    await teardown(deps, id);
  });
  for (const i of plan.destroyInstances) await act(`destroy ${i.id}`, () => vast.destroyInstance(i.id));
  for (const t of plan.deleteTunnels) await act(`tunnel ${t.id}`, () => cf.deleteTunnel(t.id));
  for (const r of plan.deleteDns) await act(`dns ${r.id}`, () => cf.deleteDns(r.id));

  // admit queued demos while there is room (admitToBooting re-checks the caps atomically)
  const admitted = [];
  for (const d of Object.values(demos).filter((d) => d.status === "queued" && !plan.failDemos.includes(d.id)).sort((a, b) => (a.queued_at < b.queued_at ? -1 : 1))) {
    if ((await admit(deps, d.id)) !== "booting") break;
    admitted.push(d.id);
  }
  return { plan, admitted };
}
