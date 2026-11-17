// Hard-gate checks run before the approval agent. Each gate returns
//   { name, pass: true | false | null, severity: "reject" | "review", detail }
// pass=null means "could not tell" (timeout, no RDAP for this TLD, ...).
// A failed "reject" gate rejects outright; a failed "review" gate (or an error) caps the outcome
// at review. See decide.js for how gates and the agent's verdict combine.

import disposableText from "./lists/disposable.js";
import freeText from "./lists/free.js";
import { readCapped } from "../clients/http.js";

// Lists are newline-joined strings; a substring search avoids building 40k-entry Sets, which
// would cost more CPU than the free plan's 10 ms per invocation allows.
const DISPOSABLE = `\n${disposableText}\n`;
const FREE = `\n${freeText}\n`;
const listed = (list, domain) => !domain.includes("\n") && list.includes(`\n${domain}\n`);
export const isDisposable = (domain) => domainAndParents(domain).some((d) => listed(DISPOSABLE, d));
export const isFree = (domain) => listed(FREE, domain);

/** domain and each parent with at least two labels: a.b.example.com -> [a.b.example.com, b.example.com, example.com] */
export const domainAndParents = (domain) => {
  const labels = domain.split(".");
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
};

export function blocklistGates(domain) {
  const disposable = isDisposable(domain);
  const free = isFree(domain) && !disposable;
  return [
    { name: "disposable_mailbox", pass: !disposable, severity: "reject", detail: disposable ? "disposable email provider" : "not on the disposable list" },
    { name: "free_mailbox", pass: !free, severity: "reject", detail: free ? "free email provider, not a company address" : "not on the free-mail list" },
  ];
}

/** MX lookup over DNS-over-HTTPS (Cloudflare's JSON API). */
export async function mxGate(domain, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const g = { name: "mx_record", severity: "reject" };
  try {
    const res = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ...g, pass: null, detail: `DoH HTTP ${res.status}` };
    const body = await res.json();
    if (body.Status === 3) return { ...g, pass: false, detail: "domain does not exist (NXDOMAIN)" };
    const mx = (body.Answer ?? []).filter((a) => a.type === 15).map((a) => String(a.data).trim());
    const real = mx.filter((d) => !/^0\s+\.?$/.test(d)); // RFC 7505 null MX "0 ." means "no mail"
    if (body.Status === 0 && real.length) return { ...g, pass: true, detail: real.slice(0, 3).join(", ") };
    if (body.Status === 0) return { ...g, pass: false, detail: mx.length ? "null MX: domain accepts no email" : "no MX records" };
    return { ...g, pass: null, detail: `DNS status ${body.Status}` };
  } catch (err) {
    return { ...g, pass: null, detail: `lookup failed: ${err?.name ?? "error"}` };
  }
}

/** Domain age via RDAP (rdap.org bootstraps to the right registry). Tries parents for subdomains. */
export async function domainAgeGate(domain, { fetchFn = fetch, timeoutMs = 8000, minDays = 90, now = Date.now() } = {}) {
  const g = { name: "domain_age", severity: "review" };
  const candidates = domainAndParents(domain).slice(-3).reverse(); // example.com first, then deeper
  for (const name of candidates) {
    try {
      const res = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(name)}`, {
        headers: { accept: "application/rdap+json" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) continue;
      if (!res.ok) return { ...g, pass: null, detail: `RDAP HTTP ${res.status}` };
      const body = await res.json();
      const reg = (body.events ?? []).find((e) => e.eventAction === "registration");
      if (!reg?.eventDate || Number.isNaN(Date.parse(reg.eventDate))) return { ...g, pass: null, detail: `RDAP has no registration date for ${name}` };
      const days = Math.floor((now - Date.parse(reg.eventDate)) / 86_400_000);
      return { ...g, pass: days > minDays, detail: `${name} registered ${reg.eventDate.slice(0, 10)} (${days} days ago)`, days };
    } catch (err) {
      return { ...g, pass: null, detail: `RDAP lookup failed: ${err?.name ?? "error"}` };
    }
  }
  return { ...g, pass: null, detail: "no RDAP record found (TLD may not publish RDAP)" };
}

/** Strips a page down to readable text: title, meta description, visible text. */
export function htmlToText(html, maxChars) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return [title && `Title: ${title}`, desc && `Description: ${desc}`, body].filter(Boolean).join("\n").slice(0, maxChars);
}

const BOT_WALL = new Set([401, 403, 429, 503]);

/** Is the company website up? Returns the gate plus the homepage text for the agent. */
export async function websiteGate(domain, { fetchFn = fetch, timeoutMs = 8000, maxChars = 6000 } = {}) {
  const g = { name: "website_reachable", severity: "review" };
  let last = "no response";
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      const res = await fetchFn(url, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; locus-demo-check/1.0)", accept: "text/html,*/*;q=0.5" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const type = res.headers.get("content-type") ?? "";
        const html = type.includes("html") || type.includes("text") ? await readCapped(res, 256 * 1024) : "";
        return { gate: { ...g, pass: true, detail: `${url} HTTP ${res.status}` }, homepage: htmlToText(html, maxChars) };
      }
      res.body?.cancel().catch(() => {});
      if (BOT_WALL.has(res.status)) return { gate: { ...g, pass: true, detail: `${url} HTTP ${res.status} (site up, content blocked)` }, homepage: "" };
      last = `${url} HTTP ${res.status}`;
    } catch (err) {
      last = `${url} ${err?.name ?? "error"}`;
    }
  }
  return { gate: { ...g, pass: false, detail: last }, homepage: "" };
}

/** Runs every gate for an email domain. */
export async function runChecks(domain, opts = {}) {
  const block = blocklistGates(domain);
  if (block.some((b) => b.pass === false)) return { gates: block, homepage: "" }; // no network for gmail.com
  const [mx, age, site] = await Promise.all([
    mxGate(domain, { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs }),
    domainAgeGate(domain, { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs, minDays: opts.minDays, now: opts.now }),
    websiteGate(domain, { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs, maxChars: opts.maxChars }),
  ]);
  return { gates: [...block, mx, age, site.gate], homepage: site.homepage };
}
