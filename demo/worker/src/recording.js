import { PROFILES, setupForUsers, userOptions } from "../../../prototype/shared/recording.js";
import { getDemo } from "./db.js";
import { fail, json, readJson, sessionCookie } from "./http.js";
import { offerQuery } from "./offers.js";
import { sign } from "./tokens.js";

const HOST_REQUIREMENTS = {
  threadripper: { cpu: /\bThreadripper\s+PRO\s+9995WX\b/i, ramGb: 256 },
  epyc: { cpu: /\bEPYC\s+9[0-9A-Z]{2}[45][A-Z]?\b/i, ramGb: 256 },
  "epyc-7742": { cpu: /\bEPYC\s+7742\b/i, ramGb: 128, pciGen: 4 },
};
const MIN = 60_000;

export const isLoopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function recordingCatalog(_request, deps) {
  return json({ ok: true, recording: deps.cfg.devFakes ? "preview" : "private", profiles: PROFILES, users: userOptions });
}

export async function takeDemoId(take) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`locus-recording:${take}`)));
  return Array.from(bytes.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
}

function matchesKey(key, expected) {
  if (typeof key !== "string" || key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function input(request, deps) {
  const { cfg } = deps;
  const { take, key, expiresAt, maxDph, offerId } = cfg.recording;
  const duration = Date.parse(expiresAt) - deps.now();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(take) || key.length < 16 || !(duration > 0) ||
      !(maxDph > 0 && cfg.vastMaxDph > 0) || !cfg.vastImage || !cfg.demoDomain ||
      (!cfg.devFakes && (!Number.isSafeInteger(offerId) || offerId < 1 || !cfg.vastKey || !cfg.cfApiToken ||
        !cfg.cfAccountId || !cfg.cfZoneId))) {
    return { error: fail(503, "This recording take is not armed.") };
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && origin !== cfg.siteUrl) {
    return { error: fail(403, "Not allowed.") };
  }

  const { body, error } = await readJson(request, 2000);
  if (error) return { error: fail(error, "Bad request.") };
  if (!matchesKey(body?.key, key)) return { error: fail(401, "The validation key is incorrect.") };
  const setup = setupForUsers(body?.users);
  if (!PROFILES.some(({ id }) => id === body?.profile) || !setup) {
    return { error: fail(400, "Choose a server and number of users.") };
  }
  return { profile: body.profile, setup, demoId: await takeDemoId(take) };
}

function runtimeConfigured(cfg, gpuCount) {
  if (cfg.devFakes) return true;
  if (gpuCount === 1) return Boolean(cfg.modelRepo && cfg.modelFiles && cfg.llamaArgs);
  const env = cfg.tieredEnv;
  return Boolean(env && env.SERVERS.split(" ").sort().join(" ") === "DEEP FAST" &&
    ["DEEP", "FAST"].every((tier) => ["REPO", "FILES", "RUNTIME", "CTX"].every((field) => env[`${tier}_${field}`])));
}

export async function recordingOffer(deps, profile, gpuCount, deadline, offerId = deps.cfg.recording.offerId) {
  const { cfg, vast } = deps;
  if (!Object.hasOwn(HOST_REQUIREMENTS, profile) || !runtimeConfigured(cfg, gpuCount)) return null;
  const { cpu, ramGb, pciGen } = HOST_REQUIREMENTS[profile];
  const maxDph = Math.min(cfg.vastMaxDph, cfg.recording.maxDph);
  const query = {
    ...offerQuery({ ...cfg, vastNumGpus: gpuCount, vastGpuName: "RTX 3090", vastRamTiersGb: [ramGb], vastMaxDph: maxDph }),
    type: "on-demand",
    ...(offerId ? { id: { eq: offerId } } : {}),
    ...(pciGen ? { pci_gen: { gte: pciGen } } : {}),
    allocated_storage: cfg.vastDiskGb,
    cuda_max_good: { gte: 13.0 },
    duration: { gte: Math.ceil((deadline - deps.now()) / 1000) },
  };
  const offers = await vast.searchOffers(query);
  return offers.filter((o) => o && Number.isSafeInteger(o.id) && (!offerId || o.id === offerId) && o.num_gpus === gpuCount &&
    /^RTX[ _]3090$/.test(o.gpu_name) && (o.verification === "verified" || o.verified === true) &&
    o.rentable === true && o.rented === false &&
    Number(o.cpu_ram) >= ramGb * 1000 && cpu.test(o.cpu_name) && Number(o.cuda_max_good) >= 13 &&
    (!pciGen || Number(o.pci_gen) >= pciGen) &&
    Number(o.reliability) > cfg.vastMinReliability && Number(o.inet_down) >= cfg.vastMinInetDown &&
    Number(o.disk_space) >= cfg.vastDiskGb && Number(o.end_date) * 1000 >= deadline &&
    Number(o.dph_total) > 0 && Number(o.dph_total) <= maxDph)
    .sort((a, b) => a.dph_total - b.dph_total)[0] ?? null;
}

export async function recommendRecording(request, deps) {
  const { error, profile, setup, demoId } = await input(request, deps);
  if (error) return error;
  const existing = await getDemo(deps.db, demoId);
  const available = existing
    ? existing.recording_profile === profile && setupForUsers(existing.recording_users) === setup
    : Boolean(await recordingOffer(deps, profile, setup.gpuCount, Date.parse(deps.cfg.recording.expiresAt)));
  return json({ ok: true, available, recommendation: { gpu: setup.gpu, model: setup.model } });
}

export async function startRecording(request, deps) {
  const { error, profile, setup, demoId } = await input(request, deps);
  if (error) return error;
  const { cfg, db, workflows } = deps;
  const deadline = Date.parse(cfg.recording.expiresAt);
  let demo = await getDemo(db, demoId);
  if (!demo) {
    if (deadline - deps.now() < MIN) return fail(409, "This recording take is about to expire.");
    const offer = await recordingOffer(deps, profile, setup.gpuCount, deadline);
    if (!offer) return fail(409, "A matching offer is no longer available.");
    if ((await deps.vast.listInstances()).some((instance) => instance.label?.startsWith(cfg.resourcePrefix))) {
      // A previous take may have ended in D1 before Vast confirmed teardown.
      demo = await getDemo(db, demoId);
      if (!demo) return fail(409, "A previous recording reservation is still on Vast.");
    }

    if (!demo) {
      const now = new Date(deps.now()).toISOString();
      await db.prepare(`
        INSERT OR IGNORE INTO demos
          (id, email, domain, page, status, step, created_at, updated_at, booting_at, recording_profile, recording_expires_at, vast_offer_id, recording_users)
        SELECT ?, '', '', '/demo?recording=1', 'booting', 'reserving', ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM demos WHERE recording_profile IS NOT NULL AND status IN ('booting','ready'))
      `).bind(demoId, now, now, now, profile, new Date(deadline).toISOString(), offer.id, Number(setup.id)).run();
      demo = await getDemo(db, demoId);
      if (!demo) return fail(409, "Another recording reservation is in progress.");
    }
  }

  if (demo.recording_profile !== profile || setupForUsers(demo.recording_users) !== setup) {
    return fail(409, "This take already has a server setup.");
  }
  if (demo.status === "booting") {
    const id = `prov-${demoId}`;
    try { await workflows.provision.create({ id, params: { demoId } }); }
    catch {
      try {
        const workflow = await workflows.provision.get(id);
        if (!(await workflow.status())?.status) throw new Error("Workflow missing");
      } catch {
        return fail(503, "The reservation could not start. Please try again.");
      }
    }
  }
  const ttl = Math.max(60, Math.ceil((Date.parse(demo.recording_expires_at) - deps.now()) / 1000) + 600);
  const token = await sign(cfg.secret, { p: "session", d: demoId, exp: Math.floor(deps.now() / 1000) + ttl });
  return json({ ok: true, session: demoId }, 200, { "set-cookie": sessionCookie(token, ttl) });
}
