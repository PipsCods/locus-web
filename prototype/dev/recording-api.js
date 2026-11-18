import { randomUUID, timingSafeEqual } from "node:crypto";
import { PROFILES, RECORDING_MODELS, recordingModels, setupForUsers, userOptions } from "../shared/recording.js";
import { CHECK_RECORDS, invoice, usd } from "../shared/invoice.js";
import purchaseOrder from "../../demo/recording/purchase-order.json" with { type: "json" };

const previews = new Map();
const mode = { recording: "preview" };
// The tiered benchmark downloaded both models in 352 seconds.
const DOWNLOAD_AT = 15_000;
const LOAD_AT = DOWNLOAD_AT + 360_000;
const READY_AT = LOAD_AT + 15_000;

function previewId(req) {
  return /(?:^|;\s*)locus_recording_preview=([a-f0-9-]+)/.exec(req.headers.cookie ?? "")?.[1];
}

export function recordingStatus(req, page) {
  if (page.get("recording") === "tiered") return {
    ok: true, status: "ready", ...mode, models: RECORDING_MODELS, model: "Two models",
    hardware: { cpu: "2× AMD EPYC 7642", ram_gb: 367, gpu: "2× RTX 3090" },
  };
  if (page.get("recording") !== "1") return null;
  const take = previews.get(previewId(req));
  if (!take) return { ok: true, status: "none", ...mode };
  const { gpu, model } = take.setup;
  const hardware = { cpu: "AMD Threadripper PRO 9995WX", ram_gb: 256, gpu };
  const models = recordingModels(take.setup.id);
  const elapsed = Date.now() - take.started;
  if (elapsed < READY_AT) return {
    ok: true, status: "booting", ...mode,
    step: elapsed < DOWNLOAD_AT ? "reserving" : elapsed < LOAD_AT ? "downloading" : "loading",
    eta_minutes: (READY_AT - elapsed) / 60_000,
    ...(elapsed >= DOWNLOAD_AT ? { hardware } : {}),
  };
  return { ok: true, status: "ready", ...mode, hardware, model, ...(models.length ? { models } : {}) };
}

export async function recordingApi(path, req, res, page, send, readBody) {
  if (path === "/recording/catalog" && req.method === "GET") {
    if (!previewId(req)) res.setHeader("set-cookie", `locus_recording_preview=${randomUUID()}; Path=/; HttpOnly; SameSite=Strict`);
    return send(res, 200, { ok: true, ...mode, profiles: PROFILES, users: userOptions });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
  const { body } = await readBody(req, 2000);
  if (path === "/recording/review") {
    if (!body || typeof body.prompt !== "string" || !body.prompt.includes(invoice.id) || !body.prompt.includes(invoice.purchaseOrder)) {
      return send(res, 400, { ok: false, error: "Ask about invoice INV-1042 and PO-1842." });
    }
    const source = purchaseOrder;
    const excess = invoice.units - source.goods_receipt.units;
    return send(res, 200, { ok: true, source, excess, discrepancy: excess * invoice.unitPrice });
  }
  if (path !== "/recording/recommendation" && path !== "/recording/start") return send(res, 404, { ok: false, error: "Not found." });
  const key = process.env.RECORDING_ACCESS_KEY;
  if (!key || key.length < 16 || key.length > 256) {
    return send(res, 503, { ok: false, error: "Set a recording key in the terminal and restart the preview." });
  }
  if (typeof body?.key !== "string" || body.key.length !== key.length ||
      !timingSafeEqual(Buffer.from(body.key, "utf16le"), Buffer.from(key, "utf16le"))) {
    return send(res, 401, { ok: false, error: "The validation key is incorrect." });
  }
  const setup = setupForUsers(body.users);
  if (!PROFILES.some(({ id }) => id === body.profile) || !setup) {
    return send(res, 400, { ok: false, error: "Choose a server and number of users." });
  }
  const available = body.profile === "threadripper" && page.get("scenario") !== "unavailable";
  if (path === "/recording/recommendation") {
    return send(res, 200, { ok: true, recommendation: { gpu: setup.gpu, model: setup.model }, available });
  }
  const id = previewId(req);
  if (!id) return send(res, 400, { ok: false, error: "Reload the picker and try again." });
  const existing = previews.get(id);
  if (existing) {
    if (existing.setup !== setup || existing.profile !== body.profile) {
      return send(res, 409, { ok: false, error: "This take already has a server setup." });
    }
    return send(res, 200, { ok: true, session: id });
  }
  if (!available) return send(res, 409, { ok: false, error: "A matching offer is no longer available." });
  if (page.get("scenario") === "failed-start") {
    return send(res, 503, { ok: false, error: "The reservation could not start. Please try again." });
  }
  previews.set(id, { started: Date.now(), setup, profile: body.profile });
  return send(res, 200, { ok: true, session: id });
}

export function recordingAnswer(st, last) {
  if (!st) return null;
  if (last.trimEnd().endsWith(CHECK_RECORDS)) {
    return "Check the purchase order for the agreed quantity and price. Then check the goods receipt for the quantity delivered. Compare both against the invoice before approving payment.";
  }
  if (last.includes(invoice.id)) {
    return `Invoice **${invoice.id}** lists a total of **${usd(invoice.units * invoice.unitPrice)} USD** and references purchase order **${invoice.purchaseOrder}**.`;
  }
  return `Load the sample invoice ${invoice.id} to continue the local walkthrough.`;
}
