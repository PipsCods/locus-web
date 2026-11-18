// The provisioning run for one approved demo. Written against the Workflows `step` API
// (step.do / step.sleep) so it runs as a Cloudflare Workflow in production and with a tiny
// fake `step` in tests. Every step does a handful of subrequests at most (free plan: 50 per
// invocation, 10 ms CPU), and code outside steps is deterministic because Workflows replay it.
//
//   tunnel  -> rent-1 -> poll-1-k … (45 min) -> [destroy-1 -> rent-2 -> poll-2-k …] -> ready
//           -> sleep(window) -> teardown
// Any unrecoverable error -> abort step: destroy what exists, mark failed, email both sides.

import { getDemo, updateDemo, transition } from "./db.js";
import { offerQuery, pickOffer, hardwareOf } from "./offers.js";
import { envString } from "./clients/vast.js";
import { issue, randomId } from "./tokens.js";
import { readyEmail, failedEmail, ownerFailedEmail } from "./emails.js";

const DEAD = new Set(["exited", "unknown", "offline"]);

export const resourceName = (cfg, demoId) => `${cfg.resourcePrefix}${demoId}`; // ids are lowercase hex
export const hostnameFor = (cfg, demoId) => `${resourceName(cfg, demoId)}.${cfg.demoDomain}`;

export async function tunnelStep(deps, demoId) {
  const { cf, cfg, db } = deps;
  if (!cfg.demoDomain) throw new Error("DEMO_DOMAIN is not set");
  const name = resourceName(cfg, demoId);
  const hostname = hostnameFor(cfg, demoId);
  const tunnel = (await cf.findTunnel(name)) ?? (await cf.createTunnel(name)); // idempotent on retry
  await cf.configureIngress(tunnel.id, hostname, "http://localhost:8080");
  const dns = (await cf.findDns(hostname)) ?? (await cf.createDns(hostname, tunnel.id));
  const demo = await getDemo(db, demoId);
  await updateDemo(db, demoId, { tunnel_id: tunnel.id, hostname, dns_record_id: dns.id, api_key: demo.api_key ?? randomId(24) }, deps.now());
  return { tunnelId: tunnel.id, hostname };
}

export function instanceSpec(cfg, { demoId, apiKey, tunnelToken }) {
  const spec = {
    image: cfg.vastImage,
    label: resourceName(cfg, demoId),
    disk: cfg.vastDiskGb,
    runtype: cfg.vastRuntype,
    cancel_unavail: true,
    env: envString({
      // one server, or a tiered box (SERVERS + per-server vars; onstart.sh ignores MODEL_* then)
      ...(cfg.tieredEnv ?? {
        MODEL_REPO: cfg.modelRepo,
        MODEL_FILES: cfg.modelFiles,
        RUNTIME: cfg.runtime,
        LLAMA_ARGS: cfg.llamaArgs,
      }),
      LLAMA_API_KEY: apiKey,
      CF_TUNNEL_TOKEN: tunnelToken,
      DEMO_TTL_SECONDS: cfg.instanceTtlSeconds,
    }),
  };
  if (cfg.vastOnstart) spec.onstart = cfg.vastOnstart;
  return spec;
}

/** Search, pick and rent one machine. Retried by the Workflow; never rents twice for one attempt. */
export async function rentStep(deps, demoId, tunnelId) {
  const { vast, cf, cfg, db } = deps;
  if (!cfg.vastImage) throw new Error("VAST_IMAGE is not set");
  const demo = await getDemo(db, demoId);
  const now = deps.now();
  if (demo.vast_instance_id) return { instanceId: demo.vast_instance_id, createdAt: Date.parse(demo.updated_at) || now };
  const tried = JSON.parse(demo.tried_machines ?? "[]");
  const offers = await vast.searchOffers(offerQuery(cfg));
  const token = await cf.tunnelToken(tunnelId);
  let lastErr = "no offer matched";
  for (let i = 0; i < 3; i++) {
    const pick = pickOffer(offers, { tiersGb: cfg.vastRamTiersGb, exclude: tried, preferCpu: cfg.vastPreferCpu, numGpus: cfg.vastNumGpus });
    if (!pick) break;
    const { offer } = pick;
    tried.push(offer.machine_id);
    try {
      const { instanceId } = await vast.createInstance(offer.id, instanceSpec(cfg, { demoId, apiKey: demo.api_key, tunnelToken: token }));
      const hw = hardwareOf(offer);
      await updateDemo(db, demoId, {
        vast_instance_id: instanceId, vast_offer_id: offer.id, machine_id: offer.machine_id, tried_machines: JSON.stringify(tried),
        hw_cpu: hw.cpu, hw_ram_gb: hw.ram_gb, hw_gpu: hw.gpu, step: "reserving",
      }, now);
      return { instanceId, createdAt: now };
    } catch (err) {
      lastErr = String(err?.message ?? err); // offer taken in the meantime (cancel_unavail): try the next one
    }
  }
  await updateDemo(db, demoId, { tried_machines: JSON.stringify(tried) }, now);
  throw new Error(`could not rent a machine: ${lastErr}`);
}

/** One poll: where is the boot? reserving (container not running) / downloading / loading / ready / dead. */
export async function pollStep(deps, demoId, { instanceId, hostname }) {
  const { vast, db } = deps;
  const demo = await getDemo(db, demoId);
  let state;
  if (demo.step === "reserving" || !demo.step) {
    const inst = await vast.getInstance(instanceId);
    if (!inst || DEAD.has(inst.actual_status)) state = "dead";
    else if (inst.actual_status !== "running") state = "reserving";
  }
  if (!state) {
    try {
      const res = await deps.fetchFn(`https://${hostname}/health`, { signal: AbortSignal.timeout(10_000) });
      res.body?.cancel().catch(() => {});
      // llama-server answers 503 while loading the model; before that the tunnel has no origin (530/502)
      state = res.status === 200 ? "ready" : res.status === 503 ? "loading" : "downloading";
    } catch {
      state = "downloading";
    }
  }
  if (state !== "ready" && state !== "dead" && state !== demo.step) await updateDemo(db, demoId, { step: state }, deps.now());
  return { state, at: deps.now() };
}

export async function destroyInstanceStep(deps, demoId, instanceId) {
  await deps.vast.destroyInstance(instanceId);
  await updateDemo(deps.db, demoId, { vast_instance_id: null, step: "reserving" }, deps.now());
}

export async function teardown(deps, demoId) {
  const demo = await getDemo(deps.db, demoId);
  if (demo?.vast_instance_id) await deps.vast.destroyInstance(demo.vast_instance_id);
  if (demo?.dns_record_id) await deps.cf.deleteDns(demo.dns_record_id);
  if (demo?.tunnel_id) await deps.cf.deleteTunnel(demo.tunnel_id);
  await updateDemo(deps.db, demoId, { vast_instance_id: null }, deps.now());
}

export async function readyStep(deps, demoId) {
  const { cfg, db } = deps;
  const now = deps.now();
  const endsAt = new Date(now + cfg.windowMinutes * 60_000).toISOString();
  await transition(db, demoId, "ready", { ready_at: new Date(now).toISOString(), ends_at: endsAt, step: null }, { from: ["booting"], now });
  const demo = await getDemo(db, demoId);
  const token = await issue(cfg.secret, "access", demoId, cfg.windowMinutes * 60 + 600, {}, now);
  await deps.email.send({ to: demo.email, idempotencyKey: `ready-${demoId}`, ...readyEmail({ link: `${cfg.siteUrl}/api/demo/confirm?token=${token}`, windowMinutes: cfg.windowMinutes }) });
  return { endsAt };
}

export async function provision(deps, demoId, step) {
  const { cfg } = deps;
  const retry = (limit, delay = "30 seconds") => ({ retries: { limit, delay, backoff: "exponential" }, timeout: "2 minutes" });
  try {
    const { tunnelId, hostname } = await step.do("tunnel", retry(5), () => tunnelStep(deps, demoId));
    let ready = false;
    for (let attempt = 1; attempt <= cfg.bootAttempts && !ready; attempt++) {
      const { instanceId, createdAt } = await step.do(`rent-${attempt}`, retry(4, "1 minute"), () => rentStep(deps, demoId, tunnelId));
      const deadline = createdAt + cfg.bootTimeoutMinutes * 60_000;
      for (let k = 0; ; k++) {
        const { state, at } = await step.do(`poll-${attempt}-${k}`, retry(3, "10 seconds"), () => pollStep(deps, demoId, { instanceId, hostname }));
        if (state === "ready") { ready = true; break; }
        if (state === "dead" || at >= deadline) {
          await step.do(`destroy-${attempt}`, retry(5), () => destroyInstanceStep(deps, demoId, instanceId));
          break;
        }
        await step.sleep(`wait-${attempt}-${k}`, cfg.healthPollSeconds * 1000);
      }
    }
    if (!ready) throw new Error(`no machine became ready after ${cfg.bootAttempts} attempts`);
    await step.do("ready", retry(5), () => readyStep(deps, demoId));
    await step.sleep("window", cfg.windowMinutes * 60_000);
    await step.do("teardown", retry(10), async () => {
      await teardown(deps, demoId);
      await transition(deps.db, demoId, "ended", { ended_at: new Date(deps.now()).toISOString() }, { from: ["ready", "booting"], now: deps.now() });
    });
    return "ended";
  } catch (err) {
    const reason = String(err?.message ?? err).slice(0, 300);
    await step.do("abort", retry(10), async () => {
      await teardown(deps, demoId);
      const changed = await transition(deps.db, demoId, "failed", { failed_reason: reason }, { from: ["booting", "ready"], now: deps.now() });
      if (!changed) return;
      const demo = await getDemo(deps.db, demoId);
      await deps.email.send({ to: demo.email, idempotencyKey: `failed-${demoId}`, ...failedEmail() }).catch(() => {});
      if (cfg.ownerEmail) await deps.email.send({ to: cfg.ownerEmail, idempotencyKey: `failed-owner-${demoId}`, ...ownerFailedEmail({ demo, reason }) }).catch(() => {});
    });
    return "failed";
  }
}
