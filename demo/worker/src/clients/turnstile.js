// Cloudflare Turnstile server-side validation.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileClient({ secret, fetchFn = fetch }) {
  return {
    async verify(token, remoteip) {
      if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not set");
      if (typeof token !== "string" || !token || token.length > 2048) return { success: false, codes: ["missing-input-response"] };
      const res = await fetchFn(SITEVERIFY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, response: token, remoteip, idempotency_key: crypto.randomUUID() }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({}));
      return { success: body.success === true, codes: body["error-codes"] ?? [], hostname: body.hostname };
    },
  };
}
