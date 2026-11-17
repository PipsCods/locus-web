// D1 access for the `demos` table. Every status change goes through transition(), which is a
// single conditional UPDATE, so two racing callers cannot both move a row.

import { canTransition, sourcesOf, ACTIVE } from "./status.js";

const iso = (d = new Date()) => new Date(d).toISOString();
const hoursAgo = (h, now) => iso(new Date(now).getTime() - h * 3600_000);

export async function createDemo(db, { email, domain, ip, country, page }, now = Date.now()) {
  // hex, so it can be used as-is in tunnel names, DNS labels and Vast labels
  const id = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const t = iso(now);
  await db
    .prepare("INSERT INTO demos (id, email, domain, status, ip, country, page, created_at, updated_at) VALUES (?, ?, ?, 'pending_email', ?, ?, ?, ?, ?)")
    .bind(id, email, domain, ip ?? "", country ?? "", page ?? "", t, t)
    .run();
  return id;
}

export const getDemo = (db, id) => db.prepare("SELECT * FROM demos WHERE id = ?").bind(id).first();

const COLUMNS = new Set([
  "step", "confirmed_at", "checked_at", "approved_at", "queued_at", "booting_at", "ready_at", "ends_at", "ended_at",
  "checks_json", "verdict", "agent_verdict", "verdict_reason", "decided_by", "failed_reason",
  "vast_instance_id", "vast_offer_id", "machine_id", "tried_machines", "tunnel_id", "hostname", "dns_record_id", "api_key",
  "hw_cpu", "hw_ram_gb", "hw_gpu",
]);

function setClause(fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!COLUMNS.has(k)) throw new Error(`unknown column ${k}`);
  return { sql: keys.map((k) => `${k} = ?`).join(", "), values: keys.map((k) => fields[k] ?? null) };
}

/** Updates non-status fields. */
export async function updateDemo(db, id, fields, now = Date.now()) {
  const { sql, values } = setClause(fields);
  if (!sql) return;
  await db.prepare(`UPDATE demos SET ${sql}, updated_at = ? WHERE id = ?`).bind(...values, iso(now), id).run();
}

/**
 * Moves a demo to `to` if its current status allows it. `from` narrows the accepted sources.
 * Returns true if the row changed.
 */
export async function transition(db, id, to, fields = {}, { from, now = Date.now() } = {}) {
  const sources = (from ?? sourcesOf(to)).filter((s) => canTransition(s, to));
  if (!sources.length) throw new Error(`no status can move to ${to}`);
  const { sql, values } = setClause(fields);
  const res = await db
    .prepare(`UPDATE demos SET status = ?${sql ? ", " + sql : ""}, updated_at = ? WHERE id = ? AND status IN (${sources.map(() => "?").join(",")})`)
    .bind(to, ...values, iso(now), id, ...sources)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * Admits an approved demo to booting only if the concurrency and daily caps still allow it,
 * in one statement (D1 runs writes one at a time, so the counts cannot change underneath).
 * Returns true if this demo may now provision.
 */
export async function admitToBooting(db, id, caps, now = Date.now()) {
  const sources = sourcesOf("booting");
  const res = await db
    .prepare(
      `UPDATE demos SET status = 'booting', step = 'reserving', booting_at = ?, approved_at = COALESCE(approved_at, ?), updated_at = ?
       WHERE id = ? AND status IN (${sources.map(() => "?").join(",")})
         AND (SELECT COUNT(*) FROM demos WHERE status IN (${ACTIVE.map(() => "?").join(",")})) < ?
         AND (SELECT COUNT(*) FROM demos WHERE booting_at IS NOT NULL AND booting_at > ?) < ?`,
    )
    .bind(iso(now), iso(now), iso(now), id, ...sources, ...ACTIVE, caps.maxConcurrent, hoursAgo(24, now), caps.dailyTotal)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/** Counts used by the request-time caps. */
export async function capCounts(db, { email, domain, ip }, caps, now = Date.now()) {
  const counted = "status NOT IN ('rejected')";
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first().then((r) => Number(r?.n ?? 0));
  const [emailRecent, domainRecent, dailyTotal, ipRecent, pendingForEmail] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM demos WHERE email = ? AND confirmed_at IS NOT NULL AND ${counted} AND created_at > ?`, email, hoursAgo(caps.perEmailDays * 24, now)),
    one(`SELECT COUNT(*) AS n FROM demos WHERE domain = ? AND confirmed_at IS NOT NULL AND ${counted} AND created_at > ?`, domain, hoursAgo(caps.perDomainHours, now)),
    one("SELECT COUNT(*) AS n FROM demos WHERE booting_at IS NOT NULL AND booting_at > ?", hoursAgo(24, now)),
    one("SELECT COUNT(*) AS n FROM demos WHERE ip = ? AND created_at > ?", ip ?? "", hoursAgo(1, now)),
    one("SELECT COUNT(*) AS n FROM demos WHERE email = ? AND status = 'pending_email' AND created_at > ?", email, hoursAgo(24, now)),
  ]);
  return { emailRecent, domainRecent, dailyTotal, ipRecent, pendingForEmail };
}

export const listByStatus = (db, statuses) =>
  db.prepare(`SELECT * FROM demos WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`).bind(...statuses).all().then((r) => r.results ?? []);

/** Rows that own (or recently owned) cloud resources, for the sweep. */
export const listWithResources = (db, sinceIso) =>
  db
    .prepare("SELECT * FROM demos WHERE status IN ('booting','ready') OR ((vast_instance_id IS NOT NULL OR tunnel_id IS NOT NULL) AND updated_at > ?)")
    .bind(sinceIso)
    .all()
    .then((r) => r.results ?? []);
