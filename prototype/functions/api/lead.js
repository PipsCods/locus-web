// POST /api/lead: stores one "Check your server" request.
// Runs as a Cloudflare Pages Function. Storage is a D1 database bound as DB (see wrangler.jsonc);
// the table is created on first use, so there is no separate set-up step. If a KV namespace is
// bound as LEADS instead, leads go there.

import { cleanLead } from "../../shared/lead.js";

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const TABLE = `CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  email TEXT NOT NULL,
  server TEXT, card TEXT, model TEXT, estimate TEXT, country TEXT, page TEXT
)`;

async function save(db, row) {
  const insert = () =>
    db.prepare("INSERT INTO leads (created_at, email, server, card, model, estimate, country, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.created_at, row.email, row.server, row.card, row.model, row.estimate, row.country, row.page)
      .run();
  try {
    await insert();
  } catch (err) {
    if (!/no such table/i.test(String(err?.message ?? err))) throw err;
    await db.prepare(TABLE).run(); // first lead ever: make the table, then store it
    await insert();
  }
}

export async function onRequestPost({ request, env }) {
  // only our own pages may post here
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return reply({ ok: false, error: "Not allowed." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > 10_000) return reply({ ok: false, error: "Too large." }, 413);

  let body;
  try { body = await request.json(); } catch { return reply({ ok: false, error: "Something went wrong. Please try again." }, 400); }
  const { lead, error, spam } = cleanLead(body);
  if (spam) return reply({ ok: true }); // say nothing useful to a script
  if (error) return reply({ ok: false, error }, 400);

  const row = { ...lead, created_at: new Date().toISOString(), country: request.cf?.country ?? "" };
  try {
    if (env.DB) await save(env.DB, row);
    else if (env.LEADS) await env.LEADS.put(`lead:${row.created_at}:${crypto.randomUUID()}`, JSON.stringify(row));
    else {
      console.error("lead not stored: bind a D1 database as DB (or a KV namespace as LEADS)");
      return reply({ ok: false, error: "Storage is not set up yet." }, 503);
    }
  } catch (err) {
    console.error("lead not stored:", err);
    return reply({ ok: false, error: "We could not save that. Please try again." }, 500);
  }
  return reply({ ok: true });
}

export const onRequest = () => reply({ ok: false, error: "Use POST." }, 405);
