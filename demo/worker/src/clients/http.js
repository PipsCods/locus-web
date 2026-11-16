// Small fetch helpers shared by the API clients.

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** fetch + JSON with a timeout; throws HttpError on non-2xx. */
export async function fetchJson(fetchFn, url, { timeoutMs = 15_000, ...init } = {}) {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new HttpError(`${init.method ?? "GET"} ${new URL(url).pathname}: HTTP ${res.status}`, res.status, body);
  return body;
}

/** Reads at most maxBytes of a response body as text (the rest is cancelled). */
export async function readCapped(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - off);
    all.set(part, off);
    off += part.length;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}
