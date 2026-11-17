// Email behind one interface: send({ to, subject, text, html }). Resend implementation, plain fetch.
// https://resend.com/docs/api-reference/emails/send-email

import { fetchJson } from "./http.js";

export function resendClient({ apiKey, from, fetchFn = fetch }) {
  return {
    async send({ to, subject, text, html, idempotencyKey }) {
      if (!apiKey) throw new Error("RESEND_API_KEY is not set");
      const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey.slice(0, 256);
      const body = await fetchJson(fetchFn, "https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
      });
      return { id: body?.id };
    },
  };
}
