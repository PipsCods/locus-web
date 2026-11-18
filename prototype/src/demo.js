// "Try it live": one page that follows a visitor's demo from request to chat.
// GET /api/demo/status says where the visitor stands; each status has its own section in demo.html.
// The API is answered by the locus-demo Worker (functions/api/demo/ forwards to it); while
// developing, vite.config.js stands in for it.

import { cleanLead } from "../shared/lead.js";
import { EXTRACT_INVOICE, CHECK_RECORDS, invoiceText } from "../shared/invoice.js";
import { bindRecording, loadRecording } from "./recording.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Cloudflare's public test key always passes; the real one is set at build time (VITE_TURNSTILE_SITE_KEY)
const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000AA";
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL || "";
const POLL_WAIT = 15_000;      // while the server gets ready
const POLL_READY = 60_000;     // during the chat, to notice the end
const MAX_FILE = 10 * 1024 * 1024;
const MAX_DOC_CHARS = 40_000;  // about 10,000 tokens: leaves room for the answer and a few follow-ups
const SAMPLE = { name: "sample-report.txt", url: "/demo/sample-report.txt" };

const EXAMPLES = {
  risks: "Summarize the main risks in this report, most serious first. For each one, say what it could cost and what the board should watch.",
  kpis: "Extract the key figures for Q3 2026 and Q3 2025 into a table: revenue, organic revenue growth, gross margin, adjusted EBIT and its margin, net profit, operating cash flow, net debt, and leverage against the covenant. Work out anything the report does not state directly, and show how.",
  board: "Draft a short note to the board, under 200 words, on this quarter: what went well, what worries you, and two decisions to take before the end of the year.",
};

const recordingView = import.meta.env.DEV ? new URLSearchParams(location.search).get("recording") : null;
const isRecording = () => Boolean(recordingView && status?.recording);
const views = [...document.querySelectorAll("[data-view]")];
const show = (name) => { for (const v of views) v.hidden = v.dataset.view !== name; };

let status = null;     // the last answer from /api/demo/status
let pollTimer = 0;

// ── status ──────────────────────────────────────────────────────

async function fetchStatus() {
  const res = await fetch("/api/demo/status", { cache: "no-store", credentials: "same-origin" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || `status ${res.status}`);
  return data;
}

async function refresh() {
  clearTimeout(pollTimer);
  let next;
  try { next = await fetchStatus(); }
  catch (err) {
    console.warn("locus: demo status not available", err);
    if (status?.status === "ready") { pollTimer = setTimeout(refresh, POLL_READY); return; } // keep the chat; try again later
    stop("unavailable");
    pollTimer = setTimeout(refresh, POLL_READY);
    return;
  }
  status = next;
  const mode = $("[data-recording-mode]");
  mode.hidden = !isRecording();
  mode.textContent = next.recording === "preview" ? "Local preview · sample data" : "Private recording";
  await draw();
}

async function draw() {
  const s = status.status;
  if (chat.started && s !== "ready") { chatOver(s === "failed" ? "failed" : "ended"); return; } // keep the conversation on screen
  if (s === "none") {
    if (recordingView === "1") {
      try { await loadRecording(); show("recording"); }
      catch { stop("unavailable"); }
    } else request();
    return;
  }
  if (["checking", "review", "queued", "booting"].includes(s)) { wait(status); pollTimer = setTimeout(refresh, isRecording() && status.recording === "preview" ? 1000 : POLL_WAIT); return; }
  if (s === "ready") { await ready(status); pollTimer = setTimeout(refresh, POLL_READY); return; }
  stop(["rejected", "failed", "ended"].includes(s) ? s : "unavailable");
}

// poll right away when the visitor comes back to the tab
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && status && status.status !== "none") refresh();
});

// ── none: the request form ──────────────────────────────────────

const form = $("#request-form"), email = $("#email"), emailError = $("#email-error");
const go = $("[data-go]"), formStatus = $("[data-status]"), turnstileEl = $("[data-turnstile]");
let turnstileId = null, turnstileToken = "";

function request() {
  show("request");
  if (turnstileId === null) startTurnstile();
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    window.onLocusTurnstile = () => resolve(window.turnstile);
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onLocusTurnstile";
    s.async = true;
    s.onerror = reject;
    document.head.append(s);
  });
}

async function startTurnstile() {
  turnstileId = "loading";
  try {
    const ts = await loadTurnstile();
    turnstileId = ts.render(turnstileEl, {
      sitekey: TURNSTILE_KEY,
      theme: "dark",
      callback: (t) => { turnstileToken = t; if (formStatus.dataset.waiting) { formStatus.textContent = ""; delete formStatus.dataset.waiting; } },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
    });
  } catch (err) {
    console.warn("locus: Turnstile did not load", err);
    turnstileId = null;
    formStatus.textContent = "The security check could not load. If you use a content blocker, allow this page and reload.";
  }
}

const resetTurnstile = () => { turnstileToken = ""; if (window.turnstile && typeof turnstileId === "string" && turnstileId !== "loading") window.turnstile.reset(turnstileId); };

function emailWrong(message) {
  emailError.textContent = message;
  emailError.hidden = false;
  email.setAttribute("aria-invalid", "true");
  email.focus();
}
email.addEventListener("input", () => { emailError.hidden = true; email.removeAttribute("aria-invalid"); });

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { lead, error } = cleanLead({ email: email.value }); // the same check the server runs on /check
  if (error) return emailWrong(error);
  if (!turnstileToken) {
    formStatus.textContent = "One moment, the security check is still running.";
    formStatus.dataset.waiting = "1";
    return;
  }
  go.disabled = true;
  formStatus.textContent = "Sending…";
  let res, data;
  try {
    res = await fetch("/api/demo/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: lead.email, company_website: form.elements.company_website.value, turnstile_token: turnstileToken, page: location.pathname }),
    });
    data = await res.json().catch(() => ({}));
  } catch { data = {}; }
  go.disabled = false;
  if (res?.ok && data.ok) {
    $("[data-sent-to]").textContent = lead.email;
    formStatus.textContent = "";
    show("sent");
    window.scrollTo({ top: 0 });
    return;
  }
  resetTurnstile(); // a token is good for one try only
  formStatus.textContent = "";
  if (res?.status === 400 && data.error) return emailWrong(data.error);
  formStatus.textContent = data.error || "Something went wrong. Please try again.";
});

$("[data-again]").addEventListener("click", (ev) => { ev.preventDefault(); resetTurnstile(); show("request"); email.focus(); });

// ── checking / review / queued / booting: the wait ──────────────

const TRACK = [
  ["check", "Checking your request"],
  ["reserving", "Reserving a server for you"],
  ["downloading", "Downloading the model, about 100 GB"],
  ["loading", "Loading it into memory"],
  ["ready", "Ready to use"],
];

const WAIT = {
  checking: ["Email confirmed", "We are checking your request.", "A few automatic checks run now. This usually takes a minute or two."],
  review: ["Email confirmed", "A person is looking at your request.", "The automatic checks could not decide, so one of us will. We email you either way, usually within one working day."],
  queued: ["Approved", "You are next in line for a server.", "Every demo server is in use right now. Yours starts as soon as one is free."],
  booting: ["Approved", "Your server is getting ready.", "We are setting up a server with one graphics card, just for you. The model is large, so this takes a while."],
};

function wait(st) {
  const [label, title, lead] = WAIT[st.status];
  $("[data-wait-label]").textContent = isRecording() ? "Demo server" : label;
  $("[data-wait-title]").textContent = title;
  $("[data-wait-lead]").textContent = lead;
  const at = st.status === "booting" ? Math.max(1, TRACK.findIndex(([id]) => id === st.step)) : st.status === "queued" ? 1 : 0;
  $("[data-wait-note]").textContent = isRecording()
    ? (hardwareLine(st.hardware) || "Keep this page open to follow the reservation.")
    : "You can close this tab. We will email you a link as soon as your server is ready, and your two hours start only then.";
  $("[data-track]").innerHTML = TRACK.map(([id, text], i) =>
    `<li class="${i < at ? "is-done" : i === at ? "is-now" : ""}"${i === at ? ' aria-current="step"' : ""}><span class="track__mark" aria-hidden="true"></span>${esc(isRecording() && id === "check" ? "Matching server found" : text)}</li>`).join("");
  const eta = $("[data-eta]"), m = Number(st.eta_minutes);
  eta.hidden = !(st.eta_minutes != null && m >= 0);
  eta.textContent = m <= 1 ? "Almost there." : `About ${Math.round(m)} minutes to go.`;
  show("wait");
}

// ── rejected / failed / ended / unavailable ─────────────────────

const contact = (text) => CONTACT
  ? `<a class="btn" href="mailto:${esc(CONTACT)}?subject=${encodeURIComponent("locus live demo")}">${esc(text)}</a>`
  : `<a class="btn" href="/check">${esc(text)}</a>`; // no address yet: the /check form reaches us too

const STOP = {
  rejected: ["Your request", "We cannot start a demo for this request.", "Our checks could not confirm a company behind this email address. If we got that wrong, tell us and we will look again.", "Get in touch"],
  failed: ["Your demo", "Something went wrong with your server.", "The server we rented for you did not start properly. It has been shut down, with nothing kept on it. Tell us and we will set up a new one.", "Get in touch"],
  ended: ["Your demo", "Your demo has ended.", "Your two hours are up. The server has been shut down, with everything on it. Want to see it on hardware like yours?", "Talk to us"],
  unavailable: ["Try it live", "The live demo is not available right now.", "Please try again in a few minutes.", "Get in touch"],
};

function stop(kind) {
  const [label, title, lead, cta] = STOP[kind];
  if (recordingView) {
    $("[data-stop-label]").textContent = "Private recording";
    $("[data-stop-title]").textContent = kind === "ended" ? "This recording session has ended." : "The demo server could not start.";
    $("[data-stop-lead]").textContent = kind === "unavailable" ? "Check the local demo connection and reload." : "Check the reservation in the recording backend.";
    $("[data-stop-actions]").replaceChildren();
    show("stop");
    return;
  }
  $("[data-stop-label]").textContent = label;
  $("[data-stop-title]").textContent = title;
  $("[data-stop-lead]").textContent = lead;
  $("[data-stop-actions]").innerHTML = contact(cta) + (kind === "ended" ? `<a class="link" href="/check">Check your server</a>` : "");
  show("stop");
}

// ── ready: the chat ─────────────────────────────────────────────

const msgsEl = $("[data-msgs]"), emptyEl = $("[data-empty]"), composer = $("[data-composer]"), promptEl = $("[data-prompt]");
const sendBtn = $("[data-send]"), stopBtn = $("[data-stop]"), newBtn = $("[data-new]"), thinkEl = $("[data-think]");
const docEl = $("[data-doc]"), docError = $("[data-doc-error]"), attachEl = $("[data-attach]"), noticeEl = $("[data-notice]");
const pickEl = $("[data-pick]"), pickInputs = [...pickEl.querySelectorAll("input")];

// the conversation, in memory only: { role, content (what the model gets), text (what the visitor typed), doc, reasoning, timings, end, el }
const chat = { started: false, msgs: [], busy: null, doc: null, over: false, md: null };
let leftTimer = 0;

async function ready(st) {
  if (!chat.md) chat.md = await loadMarkdown();
  const tiers = showPicker(st.models);
  $("[data-model]").textContent = tiers.length > 1 ? tiers.map((m) => m.label).join(" + ") : st.model || "Live model";
  $("[data-hardware]").textContent = hardwareLine(st.hardware);
  startCountdown(st.ends_at);
  if (recordingView) {
    $("[data-machine-label]").textContent = st.recording === "preview" ? "Preview" : "Live";
    $("[data-report-example]").hidden = true;
    $("[data-attach-panel]").hidden = true;
    $("[data-invoice-example]").hidden = false;
    $("[data-invoice-text]").textContent = invoiceText;
    $("[data-example=invoice]").hidden = recordingView === "tiered";
    $("[data-example=records]").hidden = recordingView !== "tiered";
    $("[data-empty] p").textContent = "Start with the sample invoice.";
    const next = $("[data-recording-next]");
    next.hidden = st.recording !== "preview";
    next.href = recordingView === "tiered" ? "/recording/finance" : "/demo?recording=tiered";
    next.textContent = recordingView === "tiered" ? "Open Invoice Review preview" : "Try the two-model server";
  }
  if (!chat.started) { chat.started = true; show("chat"); }
}

// a tiered box offers Auto / Deep / Fast; a single-model box shows no picker and sends no model
function showPicker(models) {
  const ids = new Set(Array.isArray(models) ? models.map((m) => m?.id) : []);
  for (const input of pickInputs) input.closest("label").hidden = !ids.has(input.value);
  const offered = pickInputs.filter((i) => ids.has(i.value));
  pickEl.hidden = offered.length < 2;
  if (!pickEl.hidden && !offered.some((i) => i.checked)) {
    const preferred = offered.find((i) => i.value === models[0]?.id);
    (preferred ?? offered[0]).checked = true;
  }
  // the models behind the choice, for the header: every one except "auto"
  return pickEl.hidden ? [] : models.filter((m) => m.id !== "auto" && offered.some((i) => i.value === m.id));
}

const pickedModel = () => (pickEl.hidden ? undefined : pickInputs.find((i) => i.checked && !i.closest("label").hidden)?.value);

function hardwareLine(h) {
  if (!h) return "";
  const gpu = h.gpu && (/^\d+\s*[×x]\s/.test(h.gpu) ? h.gpu : `1× ${h.gpu}`);
  return [h.cpu, h.ram_gb && `${h.ram_gb} GB RAM`, gpu].filter(Boolean).join(" · ");
}

function startCountdown(endsAt) {
  clearInterval(leftTimer);
  const el = $("[data-left]"), end = Date.parse(endsAt ?? "");
  el.hidden = !end;
  if (!end) return;
  const tick = () => {
    const ms = end - Date.now();
    if (ms <= 0) { el.textContent = "Time is up"; clearInterval(leftTimer); refresh(); return; }
    const min = Math.ceil(ms / 60_000), h = Math.floor(min / 60);
    el.textContent = min < 2 ? "Less than 2 minutes left" : h ? `${h} h ${String(min % 60).padStart(2, "0")} min left` : `${min} min left`;
    el.classList.toggle("is-low", min <= 10);
  };
  tick();
  leftTimer = setInterval(tick, 15_000);
}

function chatOver(s) {
  if (chat.over) return;
  chat.over = true;
  clearInterval(leftTimer);
  chat.busy?.abort();
  $("[data-left]").textContent = s === "ended" ? "Ended" : "Stopped";
  noticeEl.innerHTML = (s === "ended"
    ? "Your two hours are up, and the server has been shut down. Your conversation stays on this page until you close it. "
    : "The server stopped answering and has been shut down. Your conversation stays on this page until you close it. ")
    + (CONTACT ? `<a class="link" href="mailto:${esc(CONTACT)}">Talk to us</a>` : `<a class="link" href="/check">Get in touch</a>`);
  if (recordingView) noticeEl.textContent = "This recording session has ended. Your conversation stays on this page.";
  noticeEl.hidden = false;
  composer.classList.add("is-off");
  for (const el of composer.querySelectorAll("textarea, button, input")) el.disabled = true;
  for (const el of document.querySelectorAll(".chat__side button, .chat__side input")) el.disabled = true;
  syncButtons();
}

// markdown from the model, made safe: the model's output is untrusted (a document can carry instructions)
async function loadMarkdown() {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer nofollow"); }
  });
  const config = {
    // no images, forms, styles or frames: a picture could carry data out of the page the moment it loads
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "code", "pre", "blockquote",
      "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "sup", "sub", "input", "span", "div"],
    ALLOWED_ATTR: ["href", "title", "align", "start", "type", "checked", "disabled"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  };
  return (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), config);
}

// ── drawing messages ──

function addMessage(m) {
  emptyEl.hidden = true;
  const el = document.createElement("article");
  el.className = `msg msg--${m.role}`;
  if (m.role === "user") {
    el.innerHTML = `${m.doc ? `<p class="msg__doc">${docIcon}${esc(m.doc.name)}<span>${esc(docSize(m.doc))}</span></p>` : ""}<div class="msg__text"></div>`;
    $(".msg__text", el).textContent = m.text;
  } else {
    el.innerHTML = `<details class="think" hidden><summary><span data-think-label>Thinking</span></summary><div class="think__text"></div></details>
      <div class="md"></div><p class="msg__meta"></p>`;
    // a fold the page did not make itself is the visitor's choice, and stays
    $("details", el).addEventListener("toggle", (ev) => { m.thinkTouched ||= ev.target.open !== m.thinkAuto; });
  }
  msgsEl.append(el);
  m.el = el;
  return el;
}

const docIcon = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const docSize = (d) => `${Math.max(1, Math.round(d.chars / 1000))}k characters${d.cut ? ", shortened" : ""}`;

let frame = 0;
const dirty = new Set();
function paint(m) {
  dirty.add(m);
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; for (const x of dirty) drawAnswer(x); dirty.clear(); follow(); });
}

function drawAnswer(m) {
  const el = m.el, think = $("details", el);
  if (m.reasoning) {
    think.hidden = false;
    $(".think__text", el).textContent = m.reasoning;
    const thinking = !m.content && !m.end;
    // open while it thinks, folded away once the answer starts, unless the visitor chose otherwise
    if (!m.thinkTouched) { m.thinkAuto = thinking; think.open = thinking; }
    const secs = m.thoughtFor ?? Math.round((Date.now() - m.started) / 1000);
    $("[data-think-label]", el).textContent = thinking ? "Thinking…" : `Thought for ${secs} s`;
  }
  $(".md", el).innerHTML = chat.md(m.content) + (!m.end && (m.content || !m.reasoning) ? '<span class="caret"></span>' : "");
  const meta = $(".msg__meta", el);
  const parts = [];
  if (m.end === "error") parts.push(`<span class="msg__err">${esc(m.error)}</span>`);
  if (m.end === "stopped") parts.push("<span>Stopped</span>");
  const t = m.timings;
  if (m.by) parts.push('<span data-by></span>');
  if (t?.predicted_per_second) {
    const detail = [t.predicted_n && `${t.predicted_n.toLocaleString("en-US")} tokens written`, t.prompt_n && t.prompt_per_second && `${t.prompt_n.toLocaleString("en-US")} read at ${Math.round(t.prompt_per_second).toLocaleString("en-US")}/s`].filter(Boolean).join(" · ");
    parts.push(`<span class="msg__speed">${Math.round(t.predicted_per_second)} tokens/s</span>${detail ? `<span>${esc(detail)}</span>` : ""}`);
  }
  if (m.end && m === chat.msgs.at(-1) && !chat.over) parts.push(`<button class="ghost ghost--sm" type="button" data-regen>${m.end === "error" ? "Try again" : "Regenerate"}</button>`);
  meta.innerHTML = parts.join("");
  if (m.by) $("[data-by]", meta).textContent = `by ${m.by}`; // the model's name comes from the stream: text only
  meta.hidden = !parts.length;
}

// keep the newest words in view while they stream in, unless the visitor scrolled up to read
let pinned = true;
addEventListener("scroll", () => { pinned = innerHeight + scrollY >= document.documentElement.scrollHeight - 160; }, { passive: true });
function follow() { if (pinned && chat.busy) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }); }

function syncButtons() {
  const busy = !!chat.busy;
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  newBtn.hidden = busy || !chat.msgs.length || chat.over;
  for (const b of document.querySelectorAll("[data-example], [data-regen]")) b.disabled = busy || chat.over;
  for (const i of pickInputs) i.disabled = busy || chat.over;
}

// ── sending ──

function compose(text, doc) {
  if (!doc) return text;
  return `Here is a document, ${doc.name}:\n\n<document>\n${doc.text}\n</document>\n\n${text}`;
}

async function send(text, doc) {
  if (chat.busy || chat.over) return;
  const user = { role: "user", text, doc, content: compose(text, doc) };
  chat.msgs.push(user);
  addMessage(user);
  await answer();
}

async function answer() {
  // the answer before this one loses its "Regenerate" button: only the newest can be redone
  const prev = chat.msgs.at(-2);
  if (prev?.role === "assistant") drawAnswer(prev);
  // with a picker, the stream names the model that answered (Auto may choose either)
  const m = { role: "assistant", content: "", reasoning: "", started: Date.now(), named: !pickEl.hidden };
  const history = chat.msgs.filter((x) => x.role === "user" || x.end !== "error").map(({ role, content }) => ({ role, content }));
  chat.msgs.push(m);
  addMessage(m);
  pinned = true;
  const ctrl = new AbortController();
  chat.busy = ctrl;
  syncButtons();
  paint(m);
  let inThink = false; // a server that sends the thinking inline as <think>…</think> instead of reasoning_content
  try {
    const res = await fetch("/api/demo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history, thinking: thinkEl.checked, model: pickedModel() }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(chatError(res.status, data.error)), { status: res.status });
    }
    for await (const chunk of events(res.body)) {
      if (chunk.error) throw new Error(chunk.error.message || "The model stopped with an error.");
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) m.reasoning += delta.reasoning_content;
      if (delta.content) {
        let c = delta.content;
        if (!m.content && !inThink && /^\s*<think>/.test(c)) { inThink = true; c = c.replace(/^\s*<think>/, ""); }
        if (inThink) {
          const close = c.indexOf("</think>");
          if (close < 0) { m.reasoning += c; c = ""; }
          else { m.reasoning += c.slice(0, close); c = c.slice(close + 8).replace(/^\s+/, ""); inThink = false; }
        }
        if (c && m.reasoning && m.thoughtFor == null) m.thoughtFor = Math.round((Date.now() - m.started) / 1000);
        m.content += c;
      }
      if (chunk.timings) m.timings = chunk.timings;
      if (m.named && typeof chunk.model === "string" && chunk.model) m.by = chunk.model.slice(0, 80);
      paint(m);
    }
    m.end = "done";
  } catch (err) {
    if (err.name === "AbortError" && !chat.over) m.end = "stopped";
    else if (err.name === "AbortError") { m.end = "error"; m.error = "The demo has ended."; }
    else {
      m.end = "error";
      m.error = err.status ? err.message : err.message && !/fetch|network/i.test(err.message) ? err.message : "The connection dropped. Please try again.";
      if (err.status === 409 || err.status === 401) refresh(); // probably over: let the status say so
    }
  }
  if (m.reasoning && m.thoughtFor == null) m.thoughtFor = Math.round((Date.now() - m.started) / 1000);
  chat.busy = null;
  drawAnswer(m);
  syncButtons();
  if (!matchMedia("(pointer: coarse)").matches) promptEl.focus({ preventScroll: true });
}

function chatError(code, text) {
  if (code === 401) return recordingView ? "Your recording session has expired." : "Your session has expired. Open the link from your email again.";
  if (code === 409) return text || "The server is not available for chat right now.";
  if (code === 413) return "That is too long for the demo. Try a shorter document, or start a new chat.";
  if (code === 502) return "The server is not answering right now. Please try again in a moment.";
  return text || "Something went wrong. Please try again.";
}

// llama.cpp's stream: lines of "data: {json}", ending with "data: [DONE]"
async function* events(body) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { reader.cancel().catch(() => {}); return; }
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* a malformed line: skip it */ }
    }
  }
}

composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = promptEl.value.trim();
  if (!text || chat.busy) return;
  const doc = chat.doc;
  chat.doc = null;
  drawDoc();
  promptEl.value = "";
  grow();
  send(text, doc);
});

promptEl.addEventListener("keydown", (ev) => {
  // Enter sends, Shift+Enter starts a new line; on phones the Enter key just starts a new line
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !matchMedia("(pointer: coarse)").matches) { ev.preventDefault(); composer.requestSubmit(); }
});
const grow = () => { promptEl.style.height = "auto"; promptEl.style.height = Math.min(promptEl.scrollHeight + 2, 240) + "px"; };
promptEl.addEventListener("input", grow);

stopBtn.addEventListener("click", () => chat.busy?.abort());

msgsEl.addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-regen]") || chat.busy) return;
  const last = chat.msgs.pop();
  last.el.remove();
  answer();
});

newBtn.addEventListener("click", () => {
  if (chat.busy) return;
  for (const m of chat.msgs) m.el.remove();
  chat.msgs = [];
  emptyEl.hidden = false;
  syncButtons();
  promptEl.focus();
});

// ── the example report and the visitor's own documents ──

let sampleText = null;
document.querySelector(".chat__side").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-example]");
  if (!b || chat.busy || chat.over) return;
  if (b.dataset.example === "invoice" || b.dataset.example === "records") {
    const doc = { name: "INV-1042.txt", text: invoiceText, chars: invoiceText.length };
    return send(b.dataset.example === "invoice" ? EXTRACT_INVOICE : CHECK_RECORDS, doc);
  }
  try {
    sampleText ??= await fetch(SAMPLE.url).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
  } catch {
    docError.textContent = "The sample report did not load. Please try again.";
    docError.hidden = false;
    return;
  }
  docError.hidden = true;
  // the report goes with the first question about it; later questions find it in the conversation
  const already = chat.msgs.some((m) => m.doc?.sample);
  const doc = already ? null : { name: SAMPLE.name, text: sampleText, chars: sampleText.length, sample: true };
  send(EXAMPLES[b.dataset.example], doc);
});

function drawDoc() {
  const d = chat.doc;
  docEl.hidden = !d;
  promptEl.placeholder = d ? `Ask something about ${d.name}…` : "Ask something…";
  if (!d) { docEl.innerHTML = ""; return; }
  docEl.innerHTML = `<span class="msg__doc">${docIcon}${esc(d.name)}<span>${esc(docSize(d))}</span></span><button class="ghost ghost--sm" type="button" data-unattach aria-label="Remove ${esc(d.name)}">Remove</button>`;
  if (d.cut) docEl.insertAdjacentHTML("beforeend", `<p class="composer__hint">Long document: the demo reads the first ${MAX_DOC_CHARS.toLocaleString("en-US")} characters.</p>`);
}
docEl.addEventListener("click", (ev) => { if (ev.target.closest("[data-unattach]")) { chat.doc = null; drawDoc(); } });

attachEl.addEventListener("change", async () => {
  const file = attachEl.files?.[0];
  attachEl.value = "";
  if (!file) return;
  docError.hidden = true;
  const fail = (msg) => { docError.textContent = msg; docError.hidden = false; };
  if (file.size > MAX_FILE) return fail("That file is over 10 MB. Please pick a smaller one.");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  let text;
  try {
    docEl.hidden = false;
    docEl.innerHTML = `<span class="msg__doc">${docIcon}${esc(file.name)}<span>reading…</span></span>`;
    text = isPdf ? await pdfText(file) : await file.text();
  } catch (err) {
    console.warn("locus: could not read the file", err);
    drawDoc();
    return fail(isPdf ? "We could not read that PDF. Try another, or save it as text." : "We could not read that file.");
  }
  text = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) { drawDoc(); return fail("We found no text in that file. A scanned PDF holds only pictures of pages, which this demo cannot read."); }
  const cut = text.length > MAX_DOC_CHARS;
  chat.doc = { name: file.name, text: cut ? text.slice(0, MAX_DOC_CHARS) : text, chars: Math.min(text.length, MAX_DOC_CHARS), cut };
  drawDoc();
  promptEl.focus();
});

// pdf.js is large, so it loads only when someone attaches a PDF
async function pdfText(file) {
  const [pdfjs, { default: workerSrc }] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    let out = "";
    for (let p = 1; p <= pdf.numPages && out.length <= MAX_DOC_CHARS; p++) {
      const { items } = await (await pdf.getPage(p)).getTextContent();
      out += items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " ")).join("") + "\n\n";
    }
    return out;
  } finally {
    task.destroy(); // frees the worker
  }
}

// ── a switch through every status, only on the local dev server (see vite.config.js) ──
if (import.meta.env.DEV && !recordingView) {
  const states = ["none", "checking", "review", "queued", "booting", "ready", "rejected", "failed", "ended", "unreachable"];
  const now = new URLSearchParams(location.search).get("demo");
  const bar = document.createElement("nav");
  bar.className = "devbar";
  bar.setAttribute("aria-label", "Dev: demo status");
  bar.innerHTML = "<span>dev status</span>" + states.map((s) => `<a href="?demo=${s}"${s === now ? ' aria-current="true"' : ""}>${s}</a>`).join("");
  document.body.append(bar);
}

if (recordingView === "1") bindRecording(refresh);
refresh();
