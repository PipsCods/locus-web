import { defineConfig } from "vite";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cleanLead } from "./shared/lead.js";
import { demoApi } from "./dev/demo-api.js";

const recordingWorker = process.env.RECORDING_WORKER_URL;
if (recordingWorker && !["localhost", "127.0.0.1"].includes(new URL(recordingWorker).hostname)) {
  throw new Error("RECORDING_WORKER_URL must be a local Wrangler server.");
}

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// While developing there is no Cloudflare: this answers POST /api/lead with the same checks as the
// live endpoint (functions/api/lead.js) and keeps what it receives in a local file, .leads.dev.jsonl.
const devLeads = () => ({
  name: "locus-dev-leads",
  configureServer(server) {
    // Cloudflare serves check.html at /check (and demo.html at /demo); do the same here so links work in both places
    server.middlewares.use((req, _res, next) => {
      const page = req.url?.match(/^\/(check|demo)(?=$|\?)/)?.[1];
      if (req.url?.match(/^\/recording\/finance(?=$|\?)/)) req.url = req.url.replace("/recording/finance", "/dev/finance.html");
      if (page) req.url = req.url.replace(`/${page}`, `/${page}.html`);
      next();
    });
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
    // and a stand-in for the live demo's API (dev/demo-api.js explains how to pick a status)
    if (!recordingWorker) server.middlewares.use("/api/demo", demoApi);
  },
});

export default defineConfig({
  plugins: [devLeads()],
  server: recordingWorker ? { proxy: { "/api/demo": recordingWorker } } : {},
  build: {
    // four pages: the landing page, "Check your server", "Try it live", and the page shown for an address that does not exist
    rollupOptions: { input: { index: here("./index.html"), check: here("./check.html"), demo: here("./demo.html"), 404: here("./404.html") } },
  },
});
