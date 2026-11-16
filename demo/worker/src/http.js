// Response helpers and the session cookie.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const fail = (status, error) => json({ ok: false, error }, status);

export const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } });

export const COOKIE = "locus_demo";

export const sessionCookie = (value, maxAgeSeconds) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Reads a JSON body of at most maxBytes; returns { body } or { error: 400 | 413 }. */
export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { error: 413 };
  if (!request.body) return { error: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return { error: 413 };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return { body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { error: 400 };
  }
}
