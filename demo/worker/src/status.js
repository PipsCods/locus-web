// The demo status machine and the public view of a demo row.

export const TRANSITIONS = {
  pending_email: ["checking"],
  checking: ["review", "rejected", "queued", "booting", "failed"],
  review: ["rejected", "queued", "booting", "failed"],
  queued: ["booting", "failed"],
  booting: ["ready", "failed", "ended"],
  ready: ["ended", "failed"],
  rejected: [],
  ended: [],
  failed: [],
};

export const STATUSES = Object.keys(TRANSITIONS);
export const ACTIVE = ["booting", "ready"]; // a machine is (or may be) rented
export const TERMINAL = ["rejected", "ended", "failed"];
export const STEPS = ["reserving", "downloading", "loading"];

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Statuses that may move to `to`, for an atomic `UPDATE … WHERE status IN (…)`. */
export const sourcesOf = (to) => STATUSES.filter((s) => canTransition(s, to));

// Rough minutes left per boot step, shown as a time estimate on the status page.
const STEP_ETA = { reserving: 30, downloading: 25, loading: 5 };

/** What GET /api/demo/status returns for a row (null row = no demo). Never includes secrets. */
export function publicStatus(row, now = Date.now()) {
  if (!row) return { ok: true, status: "none" };
  let status = row.status === "pending_email" ? "none" : row.status;
  if (status === "ready" && row.ends_at && Date.parse(row.ends_at) <= now) status = "ended";
  const out = { ok: true, status };
  if (status === "checking") out.eta_minutes = 2;
  if (status === "booting") {
    const step = STEPS.includes(row.step) ? row.step : "reserving";
    out.step = step;
    out.eta_minutes = STEP_ETA[step];
  }
  if (status === "ready" || status === "booting" || status === "ended") {
    if (row.ends_at) out.ends_at = new Date(row.ends_at).toISOString();
    if (row.hw_cpu || row.hw_gpu) out.hardware = { cpu: row.hw_cpu ?? "", ram_gb: row.hw_ram_gb ?? 0, gpu: row.hw_gpu ?? "" };
    if (row.model) out.model = row.model;
  }
  return out;
}
