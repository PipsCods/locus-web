// HTTP routes under /api/demo/*. Each handler takes (request, deps) and returns a Response.

import { json, fail, redirect, sessionCookie, readCookie, readJson } from "./http.js";
import { issue, verify, redeem, sign } from "./tokens.js";
import { createDemo, getDemo, transition, capCounts } from "./db.js";
import { requestCapError } from "./caps.js";
import { isDisposable, isFree } from "./checks/index.js";
import { publicStatus } from "./status.js";
import { confirmEmail } from "./emails.js";
import { startScreening, admit } from "./pipeline.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // same rule as prototype/shared/lead.js
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SESSION_DAYS = 3;

const sameSite = (request, cfg) => {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === new URL(request.url).host || host === new URL(cfg.siteUrl).host;
  } catch {
    return false;
  }
};

/** The session behind the cookie: { demoId } or { manual: true } or null. */
export async function session(request, deps) {
  const token = readCookie(request);
  if (!token) return null;
  const p = await verify(deps.cfg.secret, token, "session", deps.now());
  if (!p) return null;
  return p.d === "manual" ? { manual: true } : { demoId: p.d };
}

async function setSession(deps, demoId, ttlSeconds, location = "/demo") {
  const token = await sign(deps.cfg.secret, { p: "session", d: demoId, exp: Math.floor(deps.now() / 1000) + ttlSeconds });
  return redirect(location, { "set-cookie": sessionCookie(token, ttlSeconds) });
}

// POST /api/demo/request
export async function requestDemo(request, deps) {
  const { cfg, db } = deps;
  if (!sameSite(request, cfg)) return fail(403, "Not allowed.");
  const { body, error } = await readJson(request, 10_000);
  if (error === 413) return fail(413, "Too large.");
  if (error || !body || typeof body !== "object") return fail(400, "Something went wrong. Please try again.");
  if (body.company_website) return json({ ok: true }); // honeypot: say nothing useful to a script

  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  const domain = email.split("@")[1] ?? "";
  if (!EMAIL.test(email) || !DOMAIN.test(domain)) return fail(400, "Please enter a valid email address.");
  if (isDisposable(domain) || isFree(domain)) return fail(400, "Please use your work email address.");

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  let bot;
  try {
    bot = await deps.turnstile.verify(body.turnstile_token, ip || undefined);
  } catch (err) {
    console.error("turnstile", err);
    return fail(503, "The bot check is not available right now. Please try again later.");
  }
  if (!bot.success) return fail(400, "The bot check failed. Please try again.");

  const counts = await capCounts(db, { email, domain, ip }, cfg.caps, deps.now());
  const capError = requestCapError(counts, cfg.caps);
  if (capError) return fail(400, capError);

  const id = await createDemo(db, { email, domain, ip, country: request.cf?.country ?? "", page: String(body.page ?? "").slice(0, 160) }, deps.now());
  const token = await issue(cfg.secret, "confirm", id, 24 * 3600, {}, deps.now());
  try {
    await deps.email.send({ to: email, idempotencyKey: `confirm-${id}`, ...confirmEmail({ link: `${cfg.siteUrl}/api/demo/confirm?token=${token}` }) });
  } catch (err) {
    console.error("confirm email", err);
    return fail(503, "We could not send the email right now. Please try again later.");
  }
  return json({ ok: true });
}

// GET /api/demo/confirm?token=…  (confirmation link, and the multi-use "ready" access link)
export async function confirm(request, deps) {
  const { cfg, db } = deps;
  const token = new URL(request.url).searchParams.get("token") ?? "";

  const access = await verify(cfg.secret, token, "access", deps.now());
  if (access) {
    const demo = await getDemo(db, access.d);
    if (!demo) return redirect("/demo?link=invalid");
    const left = demo.ends_at ? Math.max(60, (Date.parse(demo.ends_at) - deps.now()) / 1000 + 3600) : SESSION_DAYS * 86400;
    return setSession(deps, demo.id, left);
  }

  const { payload, error } = await redeem(cfg.secret, db, token, "confirm", deps.now());
  if (error === "used") return redirect("/demo?link=used");
  if (error) return redirect("/demo?link=invalid");
  const demo = await getDemo(db, payload.d);
  if (!demo) return redirect("/demo?link=invalid");
  const moved = await transition(db, demo.id, "checking", { confirmed_at: new Date(deps.now()).toISOString() }, { from: ["pending_email"], now: deps.now() });
  if (moved) {
    try {
      await startScreening(deps, demo.id);
    } catch (err) {
      console.error("screening not started", demo.id, err); // the demo stays in checking; visible in D1
    }
  }
  return setSession(deps, demo.id, SESSION_DAYS * 86400);
}

// GET /api/demo/status
export async function status(request, deps) {
  const s = await session(request, deps);
  if (!s) return json({ ok: true, status: "none" });
  if (s.manual) return json(manualStatus(deps));
  const demo = await getDemo(deps.db, s.demoId);
  return json(withModels(publicStatus(demo && { ...demo, model: deps.cfg.modelLabel }, deps.now()), deps.cfg));
}

/** A ready tiered box also lists the models the visitor can pick from. */
function withModels(st, cfg) {
  if (st.status !== "ready" || !cfg.chatModels.length) return st;
  return { ...st, models: cfg.chatModels.map(({ id, label }) => ({ id, label })) };
}

function manualStatus(deps) {
  const m = deps.cfg.manual;
  if (!m) return { ok: true, status: "none" };
  const endsAt = m.endsAt && !Number.isNaN(Date.parse(m.endsAt)) ? new Date(m.endsAt).toISOString() : null;
  const ended = endsAt && Date.parse(endsAt) <= deps.now();
  return withModels({
    ok: true,
    status: ended ? "ended" : "ready",
    ...(endsAt ? { ends_at: endsAt } : {}),
    hardware: { cpu: m.cpu, ram_gb: m.ramGb, gpu: m.gpu },
    model: m.model,
  }, deps.cfg);
}

/** Where chat goes for this session: { url, key } or an error Response. */
async function upstreamFor(request, deps) {
  const s = await session(request, deps);
  if (!s) return { error: fail(401, "Your demo session has expired. Please use the link from your email.") };
  if (s.manual) {
    const st = manualStatus(deps);
    if (st.status !== "ready") return { error: fail(409, "This demo has ended.") };
    return { url: deps.cfg.manual.url, key: deps.cfg.manual.key };
  }
  const demo = await getDemo(deps.db, s.demoId);
  const st = publicStatus(demo, deps.now());
  if (st.status !== "ready" || !demo.hostname || !demo.api_key) return { error: fail(409, st.status === "ended" ? "This demo has ended." : "The demo machine is not ready yet.") };
  return { url: `https://${demo.hostname}`, key: demo.api_key };
}

// POST /api/demo/chat
export async function chat(request, deps) {
  const { cfg } = deps;
  if (!sameSite(request, cfg)) return fail(403, "Not allowed.");
  const up = await upstreamFor(request, deps);
  if (up.error) return up.error;

  const { body, error } = await readJson(request, cfg.chatMaxBodyBytes);
  if (error === 413) return fail(413, "That is too much text for the demo. Please shorten the document.");
  if (error) return fail(400, "Bad request.");
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length || messages.length > cfg.chatMaxMessages) return fail(400, "Bad request: messages.");
  for (const m of messages) {
    if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") return fail(400, "Bad request: messages.");
  }
  // a tiered box takes a model pick; a single-model box ignores the field
  const models = cfg.chatModels;
  const model = models.length && body.model !== undefined && body.model !== null ? body.model : undefined;
  if (model !== undefined && !models.some((m) => m.id === model)) return fail(400, "Bad request: model.");
  const requested = Number(body.max_tokens);
  const upstreamBody = {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    max_tokens: Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), cfg.chatMaxTokens) : cfg.chatMaxTokens,
    chat_template_kwargs: { [cfg.thinkingKwarg]: body.thinking === true },
    ...(model !== undefined ? { model } : {}),
  };

  // time out only while waiting for the first byte, never mid-stream
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.upstreamTimeoutMs);
  let res;
  try {
    res = await deps.fetchFn(`${up.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${up.key}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    console.error("chat upstream", err?.name ?? err);
    return fail(502, "The demo machine did not answer. Please try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => {});
    console.error("chat upstream status", res.status);
    return fail(502, "The demo machine returned an error. Please try again in a moment.");
  }
  return new Response(res.body, {
    status: 200,
    headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

const page = (title, text, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;margin:3rem auto;max-width:36rem;padding:0 1rem"><h1>${title}</h1><p>${text}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

// GET /api/demo/decide?token=…&action=approve|reject  (owner's one-click links)
export async function ownerDecide(request, deps) {
  const { cfg, db } = deps;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const p0 = await verify(cfg.secret, url.searchParams.get("token") ?? "", "decide", deps.now());
  if (!p0 || (action && action !== p0.a)) return page("Link not valid", "This link is invalid or has expired.", 400);
  const demo = await getDemo(db, p0.d);
  if (!demo || demo.status !== "review") return page("Already decided", `This request is now: ${demo?.status ?? "unknown"}.`);
  const { error } = await redeem(cfg.secret, db, url.searchParams.get("token"), "decide", deps.now());
  if (error) return page("Link already used", "This link was used before.", 400);
  if (p0.a === "reject") {
    await transition(db, demo.id, "rejected", { verdict: "reject", decided_by: "owner" }, { from: ["review"], now: deps.now() });
    return page("Rejected", `${demo.email} will not get a demo.`);
  }
  const result = await admit(deps, demo.id, { decidedBy: "owner" });
  return page("Approved", result === "booting" ? `A machine is being prepared for ${demo.email}.` : `${demo.email} is queued; the machine starts when a slot frees up.`);
}

const sameSecret = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// GET /api/demo/manual?key=…  (Phase 2: session against one hand-started machine)
export async function manual(request, deps) {
  const m = deps.cfg.manual;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!m || m.accessKey.length < 16 || !sameSecret(key, m.accessKey)) return fail(404, "Not found.");
  const endsAt = Date.parse(m.endsAt);
  const ttl = Number.isNaN(endsAt) ? 86400 : Math.max(60, (endsAt - deps.now()) / 1000 + 3600);
  return setSession(deps, "manual", ttl);
}
