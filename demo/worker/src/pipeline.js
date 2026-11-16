// What happens after an email is confirmed: checks -> decision -> admission (or queue/review).
// screen() runs inside the Checks Workflow, one step per network-heavy part.

import { getDemo, transition, admitToBooting, updateDemo } from "./db.js";
import { runChecks } from "./checks/index.js";
import { decide } from "./decide.js";
import { issue } from "./tokens.js";
import { ownerReviewEmail } from "./emails.js";

/** Kicks off screening for a freshly confirmed demo. */
export async function startScreening(deps, demoId) {
  await deps.workflows.checks.create({ id: `checks-${demoId}`, params: { demoId } });
}

/**
 * Approved demo: boot now if the caps allow it, otherwise wait in the queue (the sweep retries).
 * Returns "booting" | "queued" | "skipped".
 */
export async function admit(deps, demoId, { decidedBy } = {}) {
  const { db, cfg } = deps;
  const now = deps.now();
  if (await admitToBooting(db, demoId, cfg.caps, now)) {
    if (decidedBy) await updateDemo(db, demoId, { decided_by: decidedBy }, now);
    try {
      await deps.workflows.provision.create({ id: `prov-${demoId}`, params: { demoId } });
    } catch (err) {
      // the sweep fails a booting demo that has no workflow
      console.error("provision workflow not started", demoId, err);
    }
    return "booting";
  }
  const queued = await transition(db, demoId, "queued", { approved_at: new Date(now).toISOString(), queued_at: new Date(now).toISOString(), ...(decidedBy ? { decided_by: decidedBy } : {}) }, { from: ["checking", "review"], now });
  return queued ? "queued" : "skipped";
}

/** Step 1: the hard-gate checks (network). Returns plain data so a Workflow can persist it. */
export async function checkStep(deps, demoId) {
  const demo = await getDemo(deps.db, demoId);
  if (!demo || demo.status !== "checking") return null;
  const { gates, homepage } = await runChecks(demo.domain, {
    fetchFn: deps.fetchFn,
    timeoutMs: deps.cfg.checkTimeoutMs,
    minDays: deps.cfg.minDomainAgeDays,
    maxChars: deps.cfg.homepageMaxChars,
    now: deps.now(),
  });
  await updateDemo(deps.db, demoId, { checks_json: JSON.stringify(gates), checked_at: new Date(deps.now()).toISOString() }, deps.now());
  return { gates, homepage };
}

/** Step 2: the decision (one model call at most). */
export async function decideStep(deps, demoId, { gates, homepage }) {
  const demo = await getDemo(deps.db, demoId);
  const d = await decide({ email: demo.email, domain: demo.domain, gates, homepage }, deps);
  return { decision: d.decision, reason: d.reason, decided_by: d.decided_by, agent_verdict: d.agent?.decision ?? (d.agent?.error ? "error" : null) };
}

/** Step 3: act on the decision. */
export async function applyStep(deps, demoId, d, gates) {
  const { db, cfg } = deps;
  const now = deps.now();
  await updateDemo(db, demoId, { verdict: d.decision, verdict_reason: d.reason, decided_by: d.decided_by, agent_verdict: d.agent_verdict }, now);
  if (d.decision === "reject") {
    await transition(db, demoId, "rejected", {}, { from: ["checking"], now });
    return "rejected";
  }
  if (d.decision === "approve") return admit(deps, demoId);
  // review: the owner decides by one-click links
  if (!(await transition(db, demoId, "review", {}, { from: ["checking"], now }))) return "skipped";
  await notifyOwner(deps, demoId, { ...d, gates });
  return "review";
}

export async function notifyOwner(deps, demoId, decision) {
  const { cfg } = deps;
  const demo = await getDemo(deps.db, demoId);
  const ttl = 3 * 24 * 3600;
  const link = async (action) => `${cfg.siteUrl}/api/demo/decide?token=${await issue(cfg.secret, "decide", demoId, ttl, { a: action }, deps.now())}&action=${action}`;
  if (!cfg.ownerEmail) return console.error("OWNER_EMAIL not set; review needed for", demoId);
  await deps.email.send({ to: cfg.ownerEmail, idempotencyKey: `review-${demoId}`, ...ownerReviewEmail({ demo, decision, approveLink: await link("approve"), rejectLink: await link("reject") }) });
}

/** The whole screening in one go (tests, and the Workflow wraps each call in a step). */
export async function screen(deps, demoId, step = { do: (_n, a, b) => (b ?? a)() }) {
  const checked = await step.do("checks", { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, () => checkStep(deps, demoId));
  if (!checked) return "skipped";
  const d = await step.do("decide", { retries: { limit: 1, delay: "30 seconds" }, timeout: "3 minutes" }, () => decideStep(deps, demoId, checked));
  return step.do("apply", () => applyStep(deps, demoId, d, checked.gates));
}
