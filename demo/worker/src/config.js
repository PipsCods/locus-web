// Every tunable in one place, read from Worker vars (wrangler.jsonc) and secrets.
// Numbers fall back to the defaults below when a var is missing or not a number.

const num = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value === "" || !Number.isFinite(n) ? fallback : n;
};
const str = (value, fallback = "") => (value === undefined || value === null || value === "" ? fallback : String(value));
const list = (value, fallback = []) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : fallback);
// "id:label,id:label" -> [{id, label}]; a missing label falls back to the id
const models = (value) =>
  list(value).map((item) => {
    const at = item.indexOf(":");
    const id = (at < 0 ? item : item.slice(0, at)).trim();
    return { id, label: (at < 0 ? "" : item.slice(at + 1).trim()) || id };
  }).filter((m) => m.id);

// Tiered box: several model servers behind router.py on the machine (demo/instance/README.md).
// SERVERS empty -> null: one server from MODEL_REPO/MODEL_FILES/RUNTIME/LLAMA_ARGS. Otherwise the
// env vars for the machine: SERVERS, then for each name N in it the set N_* vars below, then the
// set ROUTER_* vars, passed through as they are (onstart.sh validates them and has the defaults).
const SERVER_FIELDS = ["REPO", "FILES", "RUNTIME", "ARGS", "GPUS", "CPUS", "ALIAS", "SLOTS", "CTX"];
const ROUTER_VARS = ["ROUTER_POLICY", "ROUTER_DEFAULT", "ROUTER_JUDGE"];
export function tieredEnv(env) {
  const names = str(env.SERVERS).split(/\s+/).filter(Boolean);
  if (!names.length) return null;
  const out = { SERVERS: names.join(" ") };
  for (const n of names) for (const f of SERVER_FIELDS) out[`${n}_${f}`] = str(env[`${n}_${f}`]);
  for (const k of ROUTER_VARS) out[k] = str(env[k]);
  return out;
}

export function config(env) {
  const windowMinutes = num(env.DEMO_WINDOW_MINUTES, 120);
  const bootTimeoutMinutes = num(env.BOOT_TIMEOUT_MINUTES, 45);
  const recording = env.RECORDING_TAKE_ID ? {
    take: str(env.RECORDING_TAKE_ID),
    key: str(env.RECORDING_ACCESS_KEY),
    expiresAt: str(env.RECORDING_EXPIRES_AT),
    maxDph: num(env.RECORDING_MAX_DPH, 0),
    offerId: num(env.RECORDING_OFFER_ID, 0),
  } : null;
  return {
    siteUrl: str(env.SITE_URL, "https://locus-ai.tech").replace(/\/$/, ""),
    secret: str(env.SIGNING_SECRET),
    devFakes: env.DEV_FAKES === "1",
    recording,
    ownerEmail: str(env.OWNER_EMAIL),
    emailFrom: str(env.EMAIL_FROM, "locus <demo@example.com>"),
    resendKey: str(env.RESEND_API_KEY),
    turnstileSecret: str(env.TURNSTILE_SECRET_KEY),

    // spend caps, enforced in code
    caps: {
      maxConcurrent: num(env.CAP_MAX_CONCURRENT, 2),
      perEmailDays: num(env.CAP_PER_EMAIL_DAYS, 7),
      perDomainHours: num(env.CAP_PER_DOMAIN_HOURS, 24),
      dailyTotal: num(env.CAP_DAILY_TOTAL, 6),
      requestsPerIpHour: num(env.CAP_REQUESTS_PER_IP_HOUR, 5),
      queueMaxHours: num(env.QUEUE_MAX_HOURS, 24),
    },

    // checks
    minDomainAgeDays: num(env.MIN_DOMAIN_AGE_DAYS, 90),
    homepageMaxChars: num(env.HOMEPAGE_MAX_CHARS, 6000),
    checkTimeoutMs: num(env.CHECK_TIMEOUT_MS, 8000),

    // approval agent (OpenAI Responses API)
    openaiKey: str(env.OPENAI_API_KEY),
    agentModel: str(env.AGENT_MODEL, "gpt-6.1-terra"),
    agentEffort: str(env.AGENT_REASONING_EFFORT, "medium"),
    agentTimeoutMs: num(env.AGENT_TIMEOUT_MS, 90_000),
    agentMaxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS, 4000),

    // demo window and boot
    windowMinutes,
    bootTimeoutMinutes,
    bootAttempts: num(env.BOOT_ATTEMPTS, 2),
    healthPollSeconds: num(env.HEALTH_POLL_SECONDS, 30),
    // the container's own self-destruct: whole boot budget + window + margin
    instanceTtlSeconds: num(env.INSTANCE_TTL_SECONDS, (bootTimeoutMinutes + windowMinutes + 15) * 60),
    sweepGraceMinutes: num(env.SWEEP_GRACE_MINUTES, 10),

    // Vast
    vastKey: str(env.VAST_API_KEY),
    vastImage: str(env.VAST_IMAGE),
    vastDiskGb: num(env.VAST_DISK_GB, 250),
    vastRuntype: str(env.VAST_RUNTYPE, "args"),
    vastOnstart: str(env.VAST_ONSTART),
    vastGpuName: str(env.VAST_GPU_NAME, "RTX 5090"),
    vastNumGpus: num(env.VAST_NUM_GPUS, 1),
    vastRamTiersGb: list(env.VAST_RAM_TIERS_GB, ["192", "128"]).map(Number),
    vastMinReliability: num(env.VAST_MIN_RELIABILITY, 0.99),
    vastMinInetDown: num(env.VAST_MIN_INET_DOWN, 1000),
    vastMaxDph: num(env.VAST_MAX_DPH, 3),
    vastPreferCpu: list(env.VAST_PREFER_CPU, ["EPYC", "Xeon"]),

    // what runs on the machine (decided after the benchmark)
    modelRepo: str(env.MODEL_REPO),
    modelFiles: str(env.MODEL_FILES),
    runtime: str(env.RUNTIME, "ik"),
    llamaArgs: str(env.LLAMA_ARGS),
    modelLabel: str(env.MODEL_LABEL, "Qwen3.8-Flash-Next"),
    tieredEnv: tieredEnv(env), // null, or the SERVERS/<N>_*/ROUTER_* vars for a tiered box

    // Cloudflare (tunnel + DNS)
    cfAccountId: str(env.CF_ACCOUNT_ID),
    cfZoneId: str(env.CF_ZONE_ID),
    cfApiToken: str(env.CF_API_TOKEN),
    demoDomain: str(env.DEMO_DOMAIN), // e.g. demo.example.com -> locus-demo-<id>.demo.example.com
    resourcePrefix: recording ? "locus-recording-" : "locus-demo-",

    // chat proxy
    chatMaxBodyBytes: num(env.CHAT_MAX_BODY_BYTES, 400_000),
    chatMaxTokens: num(env.CHAT_MAX_TOKENS, 4096),
    chatMaxMessages: num(env.CHAT_MAX_MESSAGES, 60),
    thinkingKwarg: str(env.CHAT_THINKING_KWARG, "enable_thinking"),
    // models the visitor may pick (a tiered box); empty = one model, no picker
    chatModels: models(env.CHAT_MODELS),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 30_000),

    // Phase 2 manual mode: one machine started by hand
    manual: env.MANUAL_UPSTREAM_URL && env.MANUAL_UPSTREAM_KEY
      ? {
          url: str(env.MANUAL_UPSTREAM_URL).replace(/\/$/, ""),
          key: str(env.MANUAL_UPSTREAM_KEY),
          accessKey: str(env.MANUAL_ACCESS_KEY),
          endsAt: str(env.MANUAL_ENDS_AT),
          cpu: str(env.MANUAL_HW_CPU),
          ramGb: num(env.MANUAL_HW_RAM_GB, 0),
          gpu: str(env.MANUAL_HW_GPU, "1× RTX 5090"),
          model: str(env.MANUAL_MODEL, str(env.MODEL_LABEL, "Qwen3.8-Flash-Next")),
        }
      : null,
  };
}
