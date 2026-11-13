// "Check your server": pick a server and a card, leave an email, get an estimate.
// The options and every number behind the estimate live in check-data.js; the sums in estimate.js.

import { PLATFORMS, CONFIGS, GPUS } from "./check-data.js";
import { estimate, byId } from "./estimate.js";

const $ = (sel, root = document) => root.querySelector(sel);
const form = $("#check-form"), gensEl = $("[data-gens]"), configsEl = $("[data-configs]"), cardsEl = $("[data-cards]");
const result = $("#result"), status = $("[data-status]"), go = $("[data-go]");
const email = $("#email"), emailError = $("#email-error");

const state = { platform: null, config: null, gpu: null, unlocked: false };

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const range = ([lo, hi], fmt = money) => (fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`);
const nice = (n) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n));
const whole = ([lo, hi]) => { const a = Math.max(1, Math.floor(lo)), b = Math.max(a, Math.round(hi)); return a === b ? `about ${a}` : `${a} to ${b}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── the choices ──
function option(name, value, checked, html, cls = "") {
  return `<label class="opt ${cls}"><input type="radio" name="${name}" value="${esc(value)}"${checked ? " checked" : ""}><span class="opt__body">${html}</span></label>`;
}

function drawGens() {
  gensEl.innerHTML = PLATFORMS.map((p) =>
    option("platform", p.id, p.id === state.platform,
      `<span class="opt__kicker">${esc(p.maker)} · ${esc(p.years)}</span><strong>${esc(p.name)}</strong><span class="opt__note">${esc(p.servers)}</span>`)).join("");
}

function drawConfigs() {
  const list = CONFIGS.filter((c) => c.platform === state.platform);
  configsEl.hidden = !list.length;
  configsEl.innerHTML = list.map((c) =>
    option("config", c.id, c.id === state.config,
      `<strong>${c.sockets} × ${esc(c.cpu)}</strong><span class="opt__note">${c.sockets * c.cores} cores in all</span><span class="opt__mem">${c.ram >= 1024 ? c.ram / 1024 + " TB" : c.ram + " GB"} memory</span>`, "opt--row")).join("");
}

function drawCards() {
  cardsEl.innerHTML = GPUS.map((g) =>
    option("gpu", g.id, g.id === state.gpu,
      `<span class="opt__kicker">${g.vram} GB · ${esc(range(g.price))}</span><strong>${esc(g.name)}</strong><span class="opt__note">${esc(g.fit)}</span>`)).join("");
}

// ── the answer ──
function drawResult() {
  const e = estimate(state.config, state.gpu);
  if (!e) return;
  const server = `${e.config.sockets} × ${e.config.cpu}, ${e.config.ram >= 1024 ? e.config.ram / 1024 + " TB" : e.config.ram + " GB"}`;
  if (!e.model) {
    result.innerHTML = `<p class="label">Your estimate</p><h2>This set-up is too small for the models we run.</h2>
      <p class="lead">${esc(server)} with the ${esc(e.gpu.name)} does not have the memory for them. More memory in the server is usually the cheapest way in.</p>`;
    return e;
  }
  const m = e.model;
  const speedBig = `${whole(e.words)} words a second`;
  const peopleBig = e.slow ? "One at a time" : e.people >= 8 ? "8 or more" : e.people === 1 ? "One at a time" : `Up to ${e.people}`;
  const peopleNote = e.slow
    ? "At this pace it suits work that can wait, such as reports and summaries, more than live conversation."
    : e.people === 1
      ? "Comfortable for one person. A second person asking at the same moment slows both down."
      : `people asking at the same moment, each still getting about ${Math.max(1, Math.round(e.eachWords))} words a second.`;

  let step = "";
  if (e.step) {
    const b = e.step.model;
    if (e.step.slow) step = `<strong>${esc(b.name)}</strong> would also fit, but at about ${Math.max(1, Math.round(e.step.tokS * 0.75))} words a second it would feel slow on this server.`;
    else {
      const size = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048].find((gb) => gb >= e.step.needRam); // the next size memory is actually sold in
      const needs = [e.step.needRam && `${size >= 1024 ? size / 1024 + " TB" : size + " GB"} of memory or more`, e.step.needCard && `a card with ${e.step.needCard} GB`].filter(Boolean).join(" and ");
      step = `With ${needs}, this server could hold <strong>${esc(b.name)}</strong> (${esc(b.size)}).`;
    }
  }
  const faster = e.faster ? `Prefer speed over size? <strong>${esc(e.faster.model.name)}</strong> (${esc(e.faster.model.size)}) would write about ${Math.round(e.faster.tokS * 0.75)} words a second on the same set-up.` : "";

  const compare = e.full
    ? `<div class="compare">
      <p class="label">Next to the usual way</p>
      <div class="compare__row compare__row--ours"><span>Your server, plus one card</span><strong>${esc(range(e.add.map(nice)))}</strong></div>
      <div class="compare__row"><span>A new server built only from graphics cards, able to hold the same model<small>${esc(e.full.name)}</small></span><strong>${esc(range(e.full.price))}</strong></div>
      <p class="compare__note">To be fair to it: that server answers several times faster and serves far more people at once. If hundreds will ask at the same moment, it is the right tool. For a team, yours is enough.</p>
    </div>`
    : `<div class="compare">
      <p class="label">Next to the usual way</p>
      <p class="compare__note compare__note--only">A model this size fits on the card you picked by itself, so there is no room of graphics cards to save on here. The gain starts with more memory in the server: that is what lets it hold the large models.</p>
    </div>`;

  result.innerHTML = `
    <p class="label">Your estimate</p>
    <h2>${esc(m.name)}</h2>
    <p class="lead">${esc(m.blurb)} It is the largest model that fits ${esc(server)} with one ${esc(e.gpu.name)}${e.slow ? "" : " and still answers at a usable pace"}.</p>

    <dl class="stats">
      <div><dt>Speed</dt><dd><strong>${speedBig}</strong><span>for one person asking. That is ${whole(e.tokS)} tokens a second, ${e.words[0] >= 4 ? "faster than most people read" : e.words[1] >= 4 ? "about the pace people read at" : "slower than most people read"}.</span></dd></div>
      <div><dt>People at once</dt><dd><strong>${peopleBig}</strong><span>${peopleNote}</span></dd></div>
      <div><dt>What you add</dt><dd><strong>${esc(range(e.add.map(nice)))}</strong><span>One ${esc(e.gpu.name)}. The server, its memory and its processors are the ones you have.</span></dd></div>
    </dl>

    ${compare}

    ${faster ? `<p class="result__step">${faster}</p>` : ""}
    ${step ? `<p class="result__step">${step}</p>` : ""}

    <p class="fine">An estimate, not a promise. It is worked out from published measurements of this way of sharing the work between memory, processor and card on comparable machines, scaled to yours${e.platform.isa === "avx2" || e.platform.isa === "avx512" ? "; for servers of this age there are fewer measurements, so the range is wider" : ""}. Real speed depends on how the memory is fitted, the exact processors and how long the questions are. Prices are US-dollar street prices from November 2026 and move often. We confirm every figure with a test on the real machine.</p>`;
  return e;
}

// ── events ──
function refresh(changed) {
  if (changed === "platform") { state.config = CONFIGS.find((c) => c.platform === state.platform)?.id ?? null; drawConfigs(); }
  for (const el of form.querySelectorAll(".opt")) el.classList.toggle("is-on", el.querySelector("input").checked);
  if (state.unlocked) { drawResult(); status.textContent = ""; }
}

form.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.name === "platform") { state.platform = t.value; refresh("platform"); }
  else if (t.name === "config") { state.config = t.value; refresh(); }
  else if (t.name === "gpu") { state.gpu = t.value; refresh(); }
});
email.addEventListener("input", () => { emailError.hidden = true; email.removeAttribute("aria-invalid"); });

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const address = email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
    emailError.textContent = "Please enter your email address to see the estimate.";
    emailError.hidden = false;
    email.setAttribute("aria-invalid", "true");
    email.focus();
    return;
  }
  const e = estimate(state.config, state.gpu);
  go.disabled = true;
  status.textContent = "Working it out…";
  let refused = "";
  try {
    const res = await fetch("/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: address,
        company_website: form.elements.company_website.value,
        server: state.config,
        card: state.gpu,
        model: e?.model?.id ?? "",
        estimate: e?.model ? { tokS: e.tokS.map((v) => +v.toFixed(1)), people: e.people, add: e.add, full: e.full?.price ?? null } : {},
        page: location.pathname,
      }),
    });
    if (res.status === 400) refused = (await res.json().catch(() => ({}))).error || "Please check your email address.";
    else if (!res.ok) console.warn("locus: the request was not stored (", res.status, ")"); // our problem, not the visitor's: still show the estimate
  } catch (err) {
    console.warn("locus: the request was not stored", err);
  }
  go.disabled = false;
  if (refused) { status.textContent = ""; emailError.textContent = refused; emailError.hidden = false; email.setAttribute("aria-invalid", "true"); email.focus(); return; }

  state.unlocked = true;
  go.textContent = "Update my estimate";
  status.textContent = "";
  drawResult();
  result.hidden = false;
  result.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  result.focus({ preventScroll: true });
});

// start on the most common set-up
state.platform = PLATFORMS.find((p) => p.start)?.id ?? PLATFORMS[0].id;
state.config = CONFIGS.find((c) => c.platform === state.platform && c.start)?.id ?? CONFIGS.find((c) => c.platform === state.platform).id;
state.gpu = GPUS.find((g) => g.start)?.id ?? GPUS[0].id;
drawGens(); drawConfigs(); drawCards(); refresh();
