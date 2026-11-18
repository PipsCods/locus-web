# locus-demo Worker

Backend of the live demo: serves every `/api/demo/*` route of the site, screens requests,
rents a GPU server on Vast.ai per approved visitor, proxies the chat to it, and deletes everything
after the window. The Pages site forwards `/api/demo/*` to this Worker through a service binding
named `DEMO`; the Worker is never called from the browser directly.

```
request ─▶ Turnstile + caps ─▶ confirmation email ─▶ confirm link (cookie)
        ─▶ ChecksWorkflow: blocklists, MX, RDAP age, website ─▶ approval agent ─▶ code rules
              reject ─▶ rejected          review / agent error ─▶ owner email (approve | reject)
              approve ─▶ admit (caps) ─▶ booting  or  queued (cron admits later)
        ─▶ ProvisionWorkflow: tunnel + DNS ─▶ Vast offer (tiers) ─▶ instance ─▶ /health via tunnel
              (45 min, then destroy + one retry on another host) ─▶ ready email ─▶ 2 h ─▶ teardown
cron */5: sweep Vast instances, tunnels and DNS records named locus-demo-*; admit the queue
```

## Routes

| Route | What it does |
|---|---|
| `POST /api/demo/request` | `{email, company_website (honeypot), turnstile_token, page}` → `200 {ok:true}` / `400 {ok:false,error}` (also `403` cross-site, `413`, `503` if Turnstile or email is down). Free and disposable mailboxes are refused here already. |
| `GET /api/demo/confirm?token=…` | Single-use confirmation link (24 h): marks the email confirmed, sets the `locus_demo` cookie (HttpOnly, Secure, SameSite=Lax), starts the checks, redirects to `/demo`. A used or bad link redirects to `/demo?link=used` / `/demo?link=invalid`. The same route accepts the "ready" email's access link, which may be used repeatedly until the window ends (for opening the demo on another device). |
| `GET /api/demo/status` | `{ok, status, step?, eta_minutes?, ends_at?, hardware?: {cpu, ram_gb, gpu}, model?, models?: [{id, label}]}`; no cookie → `none`. `models` is only there when `status` is `ready` and `CHAT_MODELS` is set. |
| `POST /api/demo/chat` | `{messages, thinking, model?}` → llama-server SSE passed through unchanged. Adds the machine's API key, sets `chat_template_kwargs.enable_thinking` from `thinking`, caps `max_tokens` (`CHAT_MAX_TOKENS`) and body size (`CHAT_MAX_BODY_BYTES`). With `CHAT_MODELS` set, `model` must be one of its ids (else `400 Bad request: model.`) and is forwarded as `model`; left out, nothing is forwarded and the box uses its default. Without `CHAT_MODELS`, `model` is ignored. Errors `401`, `409`, `413`, `502`, `400`. |
| `GET /api/demo/decide?token=…&action=approve\|reject` | Owner's one-click links from the review email (single use, 3 days). Approving still goes through the caps. |
| `GET /api/demo/manual?key=…` | Phase 2 manual mode, see below. |

## Safety rules (enforced in code)

- **Hard gates first.** Free/disposable mailbox or no MX → rejected, model not called. Domain younger
  than `MIN_DOMAIN_AGE_DAYS`, website unreachable, or any check erroring → review, model not called.
  Unknown domain age (TLD without RDAP dates) is informational only.
- **Approval agent** (OpenAI Responses API, `AGENT_MODEL`=`gpt-6.1-terra`, `AGENT_REASONING_EFFORT`=`medium`):
  one call, no tools, `store: false`, strict JSON schema `{decision: approve|review|reject, reason}`.
  The homepage text is capped (`HOMEPAGE_MAX_CHARS`), stripped of our delimiter strings and
  control/bidi characters, and passed between `<<<UNTRUSTED_HOMEPAGE_TEXT>>>` markers. If the page
  contains instruction-like text aimed at an AI, an `approve` is downgraded to `review` by code.
  Errors, timeouts, refusals → review (owner email).
- **Spend caps**: `CAP_MAX_CONCURRENT` (2) machines at once, one demo per email per
  `CAP_PER_EMAIL_DAYS` (7), one per domain per `CAP_PER_DOMAIN_HOURS` (24), `CAP_DAILY_TOTAL` machines
  per 24 h, `CAP_REQUESTS_PER_IP_HOUR` requests per IP. Admission to `booting` is one conditional
  `UPDATE`, so racing approvals cannot exceed the caps. Keep the Vast account on prepaid credit with
  no auto top-up as the outer limit.
- **Three shutdown layers**: the container's own timer (`DEMO_TTL_SECONDS`, = boot budget + window
  + 15 min), the Workflow's teardown, and the 5-minute sweep (destroys `locus-demo-*` instances
  that are unknown to D1, past their window, from a dead Workflow, or stale; deletes orphan tunnels
  and DNS records).

## Setup

Prerequisites: a domain on Cloudflare (for `locus-demo-<id>.<DEMO_DOMAIN>` tunnel hostnames and for
sending email), a Resend account with that domain verified, a Turnstile widget, an OpenAI API key, a
Vast.ai account with prepaid credit, and the machine image from `demo/instance/` pushed to a registry.

```sh
cd demo/worker
npm install
npx wrangler login

# 1. tables (same database as the leads)
npm run db:migrate

# 2. secrets
npx wrangler secret put SIGNING_SECRET        # openssl rand -base64 48
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put VAST_API_KEY          # permissions: instance_read, instance_write, user_read, misc
npx wrangler secret put CF_API_TOKEN          # Account › Cloudflare Tunnel › Edit; Zone › DNS › Edit

# 3. vars: edit wrangler.jsonc (see the table below), then
npm test
npm run deploy
```

Then, in the Pages project (`prototype/wrangler.jsonc`), bind the Worker and forward the routes:

```jsonc
"services": [{ "binding": "DEMO", "service": "locus-demo" }]
```

```js
// prototype/functions/api/demo/[[path]].js
export const onRequest = ({ request, env }) => env.DEMO.fetch(request);
```

### Secrets

| Name | Needed for |
|---|---|
| `SIGNING_SECRET` | ≥ 32 characters; signs links and the session cookie. Rotating it logs everyone out and voids open links. |
| `TURNSTILE_SECRET_KEY` | server-side Turnstile check |
| `RESEND_API_KEY` | all email |
| `OPENAI_API_KEY` | approval agent |
| `VAST_API_KEY` | renting and destroying machines |
| `CF_API_TOKEN` | per-demo tunnels and DNS records |
| `MANUAL_UPSTREAM_KEY` | manual mode only: the hand-started llama-server's `--api-key` |
| `MANUAL_ACCESS_KEY` | manual mode only: ≥ 16 characters, the secret in the access link |

### Vars (`wrangler.jsonc`)

| Name | Default | Meaning |
|---|---|---|
| `SITE_URL` | `https://locus-ai.tech` | base of links in emails |
| `OWNER_EMAIL` | | receives review and failure emails |
| `EMAIL_FROM` | | sender, on the Resend-verified domain |
| `CAP_*`, `QUEUE_MAX_HOURS` | see above | spend caps; queued demos expire after `QUEUE_MAX_HOURS` |
| `MIN_DOMAIN_AGE_DAYS` | 90 | RDAP gate |
| `HOMEPAGE_MAX_CHARS` | 6000 | untrusted text passed to the model |
| `AGENT_MODEL`, `AGENT_REASONING_EFFORT` | `gpt-6.1-terra`, `medium` | approval agent |
| `DEMO_WINDOW_MINUTES` | 120 | counted from "ready" |
| `BOOT_TIMEOUT_MINUTES`, `BOOT_ATTEMPTS` | 45, 2 | per host, then one retry elsewhere |
| `VAST_IMAGE` | | machine image (from `demo/instance/`) |
| `VAST_DISK_GB` | 250 | |
| `VAST_RUNTYPE` | `args` | keeps the image's own entrypoint (the start script) |
| `VAST_GPU_NAME` | `RTX 5090` | offer filter |
| `VAST_RAM_TIERS_GB` | `192,128` | tried in order |
| `VAST_MIN_RELIABILITY`, `VAST_MIN_INET_DOWN`, `VAST_MAX_DPH` | 0.99, 1000, 3 | offer filters |
| `VAST_PREFER_CPU` | `EPYC,Xeon` | preferred within a tier (not a server-side filter) |
| `MODEL_REPO`, `MODEL_FILES`, `RUNTIME`, `LLAMA_ARGS` | | passed to the start script; set after the benchmark |
| `MODEL_LABEL` | `Qwen3.8-Flash-Next` | shown on the status page |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `DEMO_DOMAIN` | | where tunnels and their CNAMEs live. Keep `DEMO_DOMAIN` the zone apex (`locus-ai.tech`): Cloudflare's free certificate covers one level of subdomain, so `locus-demo-<id>.demo.locus-ai.tech` would have no valid HTTPS certificate |
| `CHAT_MAX_BODY_BYTES`, `CHAT_MAX_TOKENS`, `CHAT_THINKING_KWARG` | 400000, 4096, `enable_thinking` | chat proxy |
| `CHAT_MODELS` | (empty) | tiered box only: `id:label,…`, e.g. `auto:Auto,deep:Qwen3.8-Flash-Next,fast:Qwen3.8-27B`. Lists the models the page offers and the ids `chat` accepts. Empty: one model, no picker |
| `MANUAL_*` | | manual mode, below |

Less common knobs (`CHECK_TIMEOUT_MS`, `AGENT_TIMEOUT_MS`, `AGENT_MAX_OUTPUT_TOKENS`,
`HEALTH_POLL_SECONDS`, `INSTANCE_TTL_SECONDS`, `SWEEP_GRACE_MINUTES`, `CHAT_MAX_MESSAGES`,
`UPSTREAM_TIMEOUT_MS`, `VAST_ONSTART`) have defaults in `src/config.js`.

## Manual mode (Phase 2: recording the video)

No Vast, email or agent: one machine started by hand, one secret link.

1. Start the machine (see `demo/instance/`) with a tunnel, and note its public URL and `--api-key`.
2. Set vars `MANUAL_UPSTREAM_URL` (e.g. `https://box.example.com`), `MANUAL_ENDS_AT` (ISO 8601,
   optional), `MANUAL_HW_CPU`, `MANUAL_HW_RAM_GB`, `MANUAL_HW_GPU`; set secrets
   `MANUAL_UPSTREAM_KEY` and `MANUAL_ACCESS_KEY`; deploy.
3. Open `https://<site>/api/demo/manual?key=<MANUAL_ACCESS_KEY>`. The session is `ready` straight
   away against that machine until `MANUAL_ENDS_AT` (or 24 h).

Unset `MANUAL_UPSTREAM_URL` to switch manual mode off; existing manual sessions then get `none`.

## Local development and tests

```sh
npm test               # vitest inside workerd, local D1 with the migrations applied, all outside services faked
npm run check          # wrangler deploy --dry-run: bundles the Worker
cp dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev            # wrangler dev with DEV_FAKES=1: every route, both Workflows and the cron run locally
```

With `DEV_FAKES=1` emails are printed to the log; the fake world is described at the top of
`src/fakes.js` (`jane@acme-industries.com` is approved, `@injection-corp.com` lands in review,
`@brandnew-startup.com` is too young, Turnstile token `pass`). Trigger the sweep with
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"` (needs `wrangler dev --test-scheduled`).

`npm run lists:update` refreshes the vendored mailbox blocklists in `src/checks/lists/`
([disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains), CC0;
[free-email-domains](https://github.com/Kikobeats/free-email-domains), MIT; licenses alongside).

## Things to verify with real credentials

- Vast: the exact `gpu_name` value for the 5090 in REST (`RTX 5090` assumed), whether `env` values
  with spaces must be double-quoted as done here (`LLAMA_ARGS`), and `runtype: "args"` with the image's entrypoint.
- Cloudflare: `include_prefix` on the tunnel list and `name.startswith` on the DNS list (used by the sweep).
- Email link scanners (e.g. Microsoft Defender) may open the single-use confirmation link before
  the visitor does; the visitor then sees `?link=used`, but the "ready" email's link still works.
- Workflows on the free plan: 10 ms CPU and 50 subrequests per step; every step here makes at most
  about six subrequests.
