import { defineConfig } from "vite";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cleanLead } from "./shared/lead.js";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// While developing there is no Cloudflare: this answers POST /api/lead with the same checks as the
// live endpoint (functions/api/lead.js) and keeps what it receives in a local file, .leads.dev.jsonl.
const devLeads = () => ({
  name: "locus-dev-leads",
  configureServer(server) {
    // Cloudflare serves check.html at /check; do the same here so links work in both places
    server.middlewares.use((req, _res, next) => { if (req.url === "/check" || req.url?.startsWith("/check?")) req.url = req.url.replace("/check", "/check.html"); next(); });
    server.middlewares.use("/api/lead", (req, res) => {
      const send = (status, data) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(data)); };
      if (req.method !== "POST") return send(405, { ok: false, error: "Use POST." });
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; if (raw.length > 10_000) req.destroy(); });
      req.on("end", async () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { ok: false, error: "Something went wrong. Please try again." }); }
        const { lead, error, spam } = cleanLead(body);
        if (spam) return send(200, { ok: true });
        if (error) return send(400, { ok: false, error });
        await appendFile(here("./.leads.dev.jsonl"), JSON.stringify({ ...lead, created_at: new Date().toISOString(), country: "dev" }) + "\n");
        send(200, { ok: true });
      });
    });
  },
});

export default defineConfig({
  plugins: [devLeads()],
  build: {
    // three pages: the landing page, "Check your server", and the page shown for an address that does not exist
    rollupOptions: { input: { index: here("./index.html"), check: here("./check.html"), 404: here("./404.html") } },
  },
});
