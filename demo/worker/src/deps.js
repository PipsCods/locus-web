// Builds the clients the handlers use. Tests pass their own fakes instead; `wrangler dev` with
// DEV_FAKES=1 in .dev.vars swaps in the in-memory fakes from fakes.js so the routes can be
// exercised locally without any credentials or outside calls.

import { config } from "./config.js";
import { turnstileClient } from "./clients/turnstile.js";
import { resendClient } from "./clients/email.js";
import { openaiClient } from "./clients/openai.js";
import { vastClient } from "./clients/vast.js";
import { cloudflareClient } from "./clients/cloudflare.js";
import { devFakes } from "./fakes.js";

export function makeDeps(env) {
  const cfg = config(env);
  const base = {
    cfg,
    db: env.DB,
    workflows: { checks: env.CHECKS, provision: env.PROVISION },
    now: () => Date.now(),
  };
  if (env.DEV_FAKES === "1") return { ...base, ...devFakes(cfg) };
  return {
    ...base,
    fetchFn: (...args) => fetch(...args),
    turnstile: turnstileClient({ secret: cfg.turnstileSecret }),
    email: resendClient({ apiKey: cfg.resendKey, from: cfg.emailFrom }),
    openai: openaiClient({ apiKey: cfg.openaiKey, timeoutMs: cfg.agentTimeoutMs }),
    vast: vastClient({ apiKey: cfg.vastKey }),
    cf: cloudflareClient({ apiToken: cfg.cfApiToken, accountId: cfg.cfAccountId, zoneId: cfg.cfZoneId }),
  };
}
