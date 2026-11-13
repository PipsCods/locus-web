// What the "Check your server" form sends, and the checks run on it before anything is stored.
// Used by both the live endpoint (functions/api/lead.js, on Cloudflare) and the stand-in the
// local dev server uses (vite.config.js), so the two can never drift apart.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const text = (value, max) => String(value ?? "").trim().slice(0, max);

export function cleanLead(body) {
  if (!body || typeof body !== "object") return { error: "Something went wrong. Please try again." };
  if (body.company_website) return { spam: true }; // a field people never see; only scripts fill it in
  const email = text(body.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return { error: "Please enter a valid email address." };
  let estimate = "";
  try { estimate = JSON.stringify(body.estimate ?? {}).slice(0, 2000); } catch { /* leave empty */ }
  return {
    lead: {
      email,
      server: text(body.server, 120),   // the configuration picked
      card: text(body.card, 60),        // the graphics card picked
      model: text(body.model, 80),      // the model the estimate landed on
      estimate,                         // the numbers shown, as JSON
      page: text(body.page, 160),
    },
  };
}
