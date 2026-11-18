import { PROFILES, RECOMMENDATION, WORKLOAD } from "../../../prototype/shared/recording.js";
import { getDemo } from "./db.js";
import { fail, json, readJson, sessionCookie } from "./http.js";
import { offerQuery } from "./offers.js";
import { sign } from "./tokens.js";

const CPU = {
  threadripper: /\bThreadripper\s+PRO\s+9995WX\b/i,
  epyc: /\bEPYC\s+9[0-9A-Z]{2}[45][A-Z]?\b/i,
};
const MIN_RAM_MB = 256_000;
const MIN = 60_000;

export const isLoopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function recordingCatalog(_request, deps) {
  return json({ ok: true, recording: deps.cfg.devFakes ? "preview" : "private", profiles: PROFILES, workload: WORKLOAD });
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
        !cfg.cfAccountId || !cfg.cfZoneId || !cfg.modelRepo || !cfg.modelFiles || !cfg.llamaArgs))) {
    return { error: fail(503, "This recording take is not armed.") };
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && origin !== cfg.siteUrl) {
    return { error: fail(403, "Not allowed.") };
  }

  const { body, error } = await readJson(request, 2000);
  if (error) return { error: fail(error, "Bad request.") };
  if (!matchesKey(body?.key, key)) return { error: fail(401, "The validation key is incorrect.") };
  if (!PROFILES.some(({ id }) => id === body.profile) || body.workload !== WORKLOAD.id) {
    return { error: fail(400, "Choose a server and workload.") };
  }
  return { profile: body.profile, demoId: await takeDemoId(take) };
}

export async function recordingOffer(deps, profile, deadline, offerId = deps.cfg.recording.offerId) {
  const cpu = Object.hasOwn(CPU, profile) && CPU[profile];
  if (!cpu) return null;
  const { cfg, vast } = deps;
  const maxDph = Math.min(cfg.vastMaxDph, cfg.recording.maxDph);
  const query = {
    ...offerQuery({ ...cfg, vastNumGpus: 1, vastGpuName: "RTX 3090", vastRamTiersGb: [256], vastMaxDph: maxDph }),
    type: "on-demand",
    ...(offerId ? { id: { eq: offerId } } : {}),
    allocated_storage: cfg.vastDiskGb,
    cuda_max_good: { gte: 13.0 },
    duration: { gte: Math.ceil((deadline - deps.now()) / 1000) },
  };
  const offers = await vast.searchOffers(query);
  return offers.filter((o) => o && Number.isSafeInteger(o.id) && (!offerId || o.id === offerId) && o.num_gpus === 1 &&
    /^RTX[ _]3090$/.test(o.gpu_name) && (o.verification === "verified" || o.verified === true) &&
    o.rentable === true && o.rented === false &&
    Number(o.cpu_ram) >= MIN_RAM_MB && cpu.test(o.cpu_name) && Number(o.cuda_max_good) >= 13 &&
    Number(o.reliability) > cfg.vastMinReliability && Number(o.inet_down) >= cfg.vastMinInetDown &&
    Number(o.disk_space) >= cfg.vastDiskGb && Number(o.end_date) * 1000 >= deadline &&
    Number(o.dph_total) > 0 && Number(o.dph_total) <= maxDph)
    .sort((a, b) => a.dph_total - b.dph_total)[0] ?? null;
}

export async function recommendRecording(request, deps) {
  const { error, profile, demoId } = await input(request, deps);
  if (error) return error;
  const existing = await getDemo(deps.db, demoId);
  const available = existing
    ? existing.recording_profile === profile
    : Boolean(await recordingOffer(deps, profile, Date.parse(deps.cfg.recording.expiresAt)));
  return json({ ok: true, available, recommendation: RECOMMENDATION });
}

export async function startRecording(request, deps) {
  const { error, profile, demoId } = await input(request, deps);
  if (error) return error;
  const { cfg, db, workflows } = deps;
  const deadline = Date.parse(cfg.recording.expiresAt);
  let demo = await getDemo(db, demoId);
  if (!demo) {
    if (deadline - deps.now() < MIN) return fail(409, "This recording take is about to expire.");
    const offer = await recordingOffer(deps, profile, deadline);
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
          (id, email, domain, page, status, step, created_at, updated_at, booting_at, recording_profile, recording_expires_at, vast_offer_id)
        SELECT ?, '', '', '/demo?recording=1', 'booting', 'reserving', ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM demos WHERE recording_profile IS NOT NULL AND status IN ('booting','ready'))
      `).bind(demoId, now, now, now, profile, new Date(deadline).toISOString(), offer.id).run();
      demo = await getDemo(db, demoId);
      if (!demo) return fail(409, "Another recording reservation is in progress.");
    }
  }

  if (demo.recording_profile !== profile) return fail(409, "This take already has a server profile.");
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
