// A stand-in for /api/demo/* on the local dev server (used by vite.config.js), so the "Try it live"
// page works with no Worker, no machine and no network. The real API is the locus-demo Worker.
//
// Pick the status to show, first match wins:
//   1. ?demo=<status> on the page address (the dev bar at the bottom of /demo sets it),
//      plus &step=reserving|downloading|loading for "booting", &left=<minutes> for "ready",
//      and &chat=401|409|413|502 to make the chat fail that way
//   2. the cookie set by /api/demo/confirm?token=<status> (any other token means "ready")
//   3. DEMO_STATUS=<status> in the environment:  DEMO_STATUS=ready npm run dev
//   4. "none"
// Status "unreachable" answers 503, like the site with no Worker bound.

import { cleanLead } from "../shared/lead.js";

const STATUSES = ["none", "checking", "review", "queued", "booting", "ready", "rejected", "failed", "ended", "unreachable"];
const COOKIE = "locus_demo_dev";
const started = Date.now();

const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
};

const readBody = (req, max) => new Promise((resolve) => {
  let raw = "", tooBig = false;
  req.on("data", (chunk) => { raw += chunk; if (raw.length > max) tooBig = true; });
  req.on("end", () => {
    if (tooBig) return resolve({ tooBig: true });
    try { resolve({ body: JSON.parse(raw) }); } catch { resolve({ body: null }); }
  });
});

// the page's own query string travels in the Referer header of every fetch it makes
function pick(req) {
  let page = new URLSearchParams();
  try { page = new URL(req.headers.referer).searchParams; } catch { /* no referer */ }
  const cookie = /(?:^|;\s*)locus_demo_dev=([a-z]+)/.exec(req.headers.cookie ?? "")?.[1];
  const status = [page.get("demo"), cookie, process.env.DEMO_STATUS].find((s) => STATUSES.includes(s)) ?? "none";
  return { status, step: page.get("step"), left: page.get("left"), chat: page.get("chat") };
}

function status(req, res) {
  const p = pick(req);
  if (p.status === "unreachable") return send(res, 503, { ok: false, error: "The live demo is not set up yet." });
  const out = { ok: true, status: p.status };
  if (p.status === "booting") {
    // without &step, walk through the three steps, 20 seconds each, so the polling can be watched
    const steps = ["reserving", "downloading", "loading"];
    out.step = steps.includes(p.step) ? p.step : steps[Math.floor((Date.now() - started) / 20_000) % 3];
    out.eta_minutes = { reserving: 28, downloading: 19, loading: 4 }[out.step];
  }
  if (p.status === "queued") out.eta_minutes = 45;
  if (p.status === "ready") {
    const left = Number(p.left) > 0 ? Number(p.left) : 107;
    out.ends_at = new Date(Date.now() + left * 60_000).toISOString();
    out.hardware = { cpu: "AMD EPYC 9654", ram_gb: 128, gpu: "RTX 5090" };
    out.model = "Qwen3.8-Flash-Next";
  }
  send(res, 200, out);
}

async function request(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
  const { body, tooBig } = await readBody(req, 10_000);
  if (tooBig || !body) return send(res, 400, { ok: false, error: "Something went wrong. Please try again." });
  const { lead, error, spam } = cleanLead(body);
  if (spam) return send(res, 200, { ok: true });
  if (error) return send(res, 400, { ok: false, error });
  if (!body.turnstile_token) return send(res, 400, { ok: false, error: "Please complete the security check." });
  // the real Worker runs many more checks; this one is enough to see the error path
  if (/@(gmail|yahoo|hotmail|outlook|icloud|proton)\./.test(lead.email)) return send(res, 400, { ok: false, error: "Please use your work email address." });
  console.log(`[demo dev] request from ${lead.email}; confirm with /api/demo/confirm?token=checking`);
  send(res, 200, { ok: true });
}

function confirm(req, res) {
  const token = new URL(req.url, "http://dev").searchParams.get("token") ?? "";
  const value = STATUSES.includes(token) ? token : "ready";
  res.statusCode = 302;
  res.setHeader("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`);
  res.setHeader("location", "/demo");
  res.end();
}

// ── a fake model ──

const ANSWERS = {
  risks: `Here are the main risks, most serious first.

1. **Customer concentration (Vessmann Automotive).** Vessmann is 14% of group revenue, about **EUR 100 million a year** at the guided revenue, and is qualifying a second supplier for 2027 with no minimum purchase commitment. Losing a third of that volume would cost roughly EUR 33 million of revenue. *Watch:* how much volume Vessmann moves, and when.
2. **Teklund firmware defect.** About 2,400 installed inverters need a fix. Only **EUR 2.2 million** is provided against an estimate of **EUR 2–7 million**, so up to EUR 4.8 million could still hit profit. *Watch:* the share of units that need a site visit.
3. **Refinancing and liquidity.** The **EUR 80 million bridge loan** matures in June 2027 while operating cash flow fell from EUR 24.6 to **9.8 million**. Leverage is 1.8× against a 2.5× covenant, so headroom is about EUR 83 million of net debt. *Watch:* progress on the long-term loan.
4. **Price pressure in Industrial Sensors.** List prices were already cut about 4%; each further 1% costs about **EUR 4 million** of EBIT a year.
5. **Working capital.** Receivables rose to EUR 96.0 million, about **48 days of sales against 42** a year ago.
6. **Currency and supply chain.** A further 5% fall of the dollar costs about EUR 3 million of EBIT; the August supplier outage cost EUR 1.4 million.`,
  kpis: `| Figure (EUR million) | Q3 2026 | Q3 2025 | Change |
|---|---:|---:|---:|
| Revenue | 184.6 | 171.2 | +7.8% |
| Organic revenue¹ | 164.8 | 171.2 | **−3.7%** |
| Gross margin | 35.6% | 38.0% | −2.4 pts |
| Adjusted EBIT | 23.3 | 25.1 | −7.2% |
| Adjusted EBIT margin | 12.6% | 14.7% | −2.1 pts |
| Net profit | 16.3 | 17.5 | −6.9% |
| Operating cash flow | 9.8 | 24.6 | −60% |
| Net debt | 212.4 | 72.6 | ×2.9 |
| Net debt / adj. EBITDA² | 1.8× | – | covenant 2.5× |

¹ Revenue minus Teklund's EUR 19.8 million: 184.6 − 19.8 = 164.8.

² 212.4 / 118.0 = 1.80×. The covenant allows 2.5 × 118.0 = EUR 295 million, so headroom is about **EUR 83 million**.

The headline growth comes entirely from the acquisition. Without Teklund, the business shrank, and margins and cash flow both weakened.`,
  board: `**To the Board — Q3 2026 in brief**

Revenue grew 7.8% to EUR 184.6 million, but only because of Teklund. Organically we shrank 3.7%, and adjusted EBIT margin fell from 14.7% to 12.6%. Reported profit looks steady only thanks to the EUR 5.9 million Ostrava gain.

*What went well:* Medical Devices grew 7.3% and improved its margin despite a nine-day outage.

*What worries me:* Vessmann (14% of revenue) is dual-sourcing from 2027; the Teklund defect may cost up to EUR 4.8 million more than provided; operating cash flow fell 60% while the EUR 80 million bridge loan falls due in June.

**Decisions before year end**
1. Approve launching the long-term refinancing now, rather than in 2027.
2. Mandate a plan to protect the Vessmann volume, including a price and service offer, by the January board.`,
  other: `Happy to help. A few things worth knowing about this demo:

- It runs a **large mixture-of-experts model** on one server: the experts sit in the server's memory, and one graphics card does the rest.
- You can ask in any language, paste text, or attach a PDF or text file.
- Try the sample report on the side to see it work through numbers.

What would you like to look at?`,
};

const THOUGHTS = {
  risks: "The user wants the risks ranked by severity. Let me go through section 6 and check each against the numbers. Vessmann is 14% of revenue; 14% of nine-month revenue 532.9 is 74.6; on the full-year guidance of 720-740 that is about EUR 100 million a year. The Teklund provision is 2.2 against 2-7, so the gap is up to 4.8. Leverage: 212.4 / 118.0 = 1.8x, covenant 2.5x means max net debt 295, headroom about 83. DSO: 96.0 / 184.6 × 92 ≈ 48 days versus 78.5 / 171.2 × 92 ≈ 42. I should rank customer concentration first because it is the largest revenue exposure.",
  kpis: "I need a table with both quarters. Organic growth is not stated: remove Teklund's 19.8 from 184.6 to get 164.8, versus 171.2, which is -3.7%. Gross margin: 65.7 / 184.6 = 35.6%, 65.1 / 171.2 = 38.0%. Adjusted EBIT margin 23.3 / 184.6 = 12.6%, 25.1 / 171.2 = 14.7%. Leverage 212.4 / 118 = 1.8x. Show the working in footnotes.",
  board: "A board note under 200 words: lead with the honest picture (growth is acquired, margins down), one positive, the main worries, and two concrete decisions. Refinancing early and protecting Vessmann are the most actionable.",
  other: "The user wrote something general. Give a short, friendly answer and point to what the demo can do.",
};

function topic(text) {
  if (/risks/i.test(text)) return "risks";
  if (/key figures|table/i.test(text)) return "kpis";
  if (/board/i.test(text)) return "board";
  return "other";
}

// roughly one token per word piece, as a model would stream them
const pieces = (text) => text.match(/\s*[\w€.,%×−–'’]+|\s*[^\s\w]|\s+/g) ?? [];

async function chat(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
  const p = pick(req);
  const { body, tooBig } = await readBody(req, 200_000);
  if (tooBig || p.chat === "413") return send(res, 413, { ok: false, error: "Too large." });
  if (p.chat === "401" || p.status === "none") return send(res, 401, { ok: false, error: "No demo session." });
  if (p.chat === "409" || p.status !== "ready") return send(res, 409, { ok: false, error: "Your demo has ended." });
  if (p.chat === "502") return send(res, 502, { ok: false, error: "The machine is not answering." });
  if (!Array.isArray(body?.messages) || !body.messages.length) return send(res, 400, { ok: false, error: "No messages." });

  const last = String(body.messages.at(-1)?.content ?? "");
  const kind = topic(last.split("</document>").at(-1));
  const think = body.thinking ? pieces(THOUGHTS[kind]) : [];
  // "echo: <text>" streams the text back as the answer: handy to check what the page does with hostile markdown
  const echo = /^echo:\s?([\s\S]*)$/.exec(last)?.[1];
  const words = pieces(echo ?? ANSWERS[kind]);
  const promptN = Math.round(body.messages.reduce((n, m) => n + String(m.content ?? "").length, 0) / 3.8);
  const speed = 38 + Math.random() * 8; // tokens a second, about what the benchmark aims for

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  const id = `chatcmpl-dev${Date.now()}`, created = Math.floor(Date.now() / 1000), model = "Qwen3.8-Flash-Next";
  const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, system_fingerprint: "dev", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);

  let closed = false;
  res.on("close", () => { closed = true; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(350 + promptN / 6); // reading the prompt
  chunk({ role: "assistant", content: null });
  const t0 = Date.now();
  for (const w of think) { if (closed) return; chunk({ reasoning_content: w }); await sleep(1000 / speed); }
  for (const w of words) { if (closed) return; chunk({ content: w }); await sleep(1000 / speed); }
  if (closed) return;
  const n = think.length + words.length, ms = Date.now() - t0;
  const timings = { prompt_n: promptN, prompt_ms: promptN / 0.9, prompt_per_second: 900 + Math.random() * 150, predicted_n: n, predicted_ms: ms, predicted_per_second: n / (ms / 1000) };
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

export function demoApi(req, res, next) {
  const path = req.url.split("?")[0];
  if (path === "/status") return status(req, res);
  if (path === "/request") return request(req, res);
  if (path === "/confirm") return confirm(req, res);
  if (path === "/chat") return chat(req, res);
  next();
}
