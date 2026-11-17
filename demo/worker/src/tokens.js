// Signed tokens for email links and the session cookie.
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256(secret, payload part)).
// Payload: { p: purpose, d: demo id, exp: unix seconds, n?: nonce, a?: action }.
// Single-use links carry a nonce that is recorded in D1 `used_tokens` on first use.

const enc = new TextEncoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const randomId = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error("SIGNING_SECRET is missing or shorter than 32 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(mac)}`;
}

/** Returns the payload, or null if the token is malformed, forged, expired or for another purpose. */
export async function verify(secret, token, purpose, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(mac), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  if (!payload || payload.p !== purpose || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= now) return null;
  return payload;
}

/** Makes a token for `purpose` valid for `ttlSeconds`; single-use tokens get a nonce. */
export function issue(secret, purpose, demoId, ttlSeconds, extra = {}, now = Date.now()) {
  const payload = { p: purpose, d: demoId, exp: Math.floor(now / 1000) + ttlSeconds, ...extra };
  if (SINGLE_USE.has(purpose)) payload.n = randomId(12);
  return sign(secret, payload);
}

export const SINGLE_USE = new Set(["confirm", "decide"]);

/** Records the nonce; returns false if it was already used (the link was clicked before). */
export async function consume(db, nonce, now = new Date()) {
  if (!nonce) return false;
  const res = await db.prepare("INSERT OR IGNORE INTO used_tokens (nonce, used_at) VALUES (?, ?)").bind(nonce, now.toISOString()).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** verify() + consume() for single-use purposes. */
export async function redeem(secret, db, token, purpose, now = Date.now()) {
  const payload = await verify(secret, token, purpose, now);
  if (!payload) return { error: "invalid" };
  if (SINGLE_USE.has(purpose) && !(await consume(db, payload.n, new Date(now)))) return { error: "used", payload };
  return { payload };
}
