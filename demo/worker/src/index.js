// locus-demo Worker: serves /api/demo/* (reached from the Pages site through the DEMO service
// binding), runs the screening and provisioning Workflows, and the 5-minute cleanup sweep.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { makeDeps } from "./deps.js";
import { fail } from "./http.js";
import { requestDemo, confirm, status, chat, ownerDecide, manual } from "./routes.js";
import { screen } from "./pipeline.js";
import { provision } from "./provision.js";
import { runSweep } from "./sweep.js";

const ROUTES = {
  "POST /api/demo/request": requestDemo,
  "GET /api/demo/confirm": confirm,
  "GET /api/demo/status": status,
  "POST /api/demo/chat": chat,
  "GET /api/demo/decide": ownerDecide,
  "GET /api/demo/manual": manual,
};

export async function handle(request, deps) {
  const url = new URL(request.url);
  const route = ROUTES[`${request.method} ${url.pathname.replace(/\/$/, "")}`];
  if (!route) return fail(url.pathname.startsWith("/api/demo/") ? 404 : 404, "Not found.");
  if (!deps.cfg.secret || deps.cfg.secret.length < 32) {
    console.error("SIGNING_SECRET missing or too short");
    return fail(503, "The demo is not set up yet.");
  }
  try {
    return await route(request, deps);
  } catch (err) {
    console.error(`${request.method} ${url.pathname}`, err);
    return fail(500, "Something went wrong. Please try again.");
  }
}

export default {
  async fetch(request, env) {
    // fakes are for local `wrangler dev` only: refuse them on any non-local hostname
    if (env.DEV_FAKES === "1" && !["localhost", "127.0.0.1"].includes(new URL(request.url).hostname)) {
      return fail(503, "DEV_FAKES is set on a deployed Worker. Remove it.");
    }
    return handle(request, makeDeps(env));
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSweep(makeDeps(env)).then((r) => console.log("sweep", JSON.stringify(r))));
  },
};

export class ChecksWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return screen(makeDeps(this.env), event.payload.demoId, step);
  }
}

export class ProvisionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return provision(makeDeps(this.env), event.payload.demoId, step);
  }
}
