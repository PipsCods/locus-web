-- Live demo requests and their lifecycle. Lives in the same D1 database as `leads` (locus-leads).
--
-- status (see src/status.js for the allowed transitions):
--   pending_email -> checking -> review | rejected | queued | booting
--   review -> rejected | queued | booting
--   queued -> booting | failed
--   booting -> ready | failed
--   ready -> ended | failed
-- step (only while booting): reserving | downloading | loading
--
-- All timestamps are ISO 8601 UTC strings (Date.toISOString()), so they compare as text.

CREATE TABLE IF NOT EXISTS demos (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  domain           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_email',
  step             TEXT,
  ip               TEXT,
  country          TEXT,
  page             TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  confirmed_at     TEXT,
  checked_at       TEXT,
  approved_at      TEXT,
  queued_at        TEXT,
  booting_at       TEXT,
  ready_at         TEXT,
  ends_at          TEXT,
  ended_at         TEXT,

  checks_json      TEXT,            -- hard-gate results, JSON
  verdict          TEXT,            -- approve | review | reject (final, after code rules)
  agent_verdict    TEXT,            -- what the model said, for the audit trail
  verdict_reason   TEXT,
  decided_by       TEXT,            -- rules | agent | owner
  failed_reason    TEXT,

  vast_instance_id INTEGER,
  vast_offer_id    INTEGER,
  machine_id       INTEGER,
  tried_machines   TEXT,            -- JSON array of Vast machine ids already tried
  tunnel_id        TEXT,
  hostname         TEXT,
  dns_record_id    TEXT,
  api_key          TEXT,            -- per-demo llama-server key; never sent to the browser
  hw_cpu           TEXT,
  hw_ram_gb        INTEGER,
  hw_gpu           TEXT
);

CREATE INDEX IF NOT EXISTS demos_email   ON demos (email, created_at);
CREATE INDEX IF NOT EXISTS demos_domain  ON demos (domain, created_at);
CREATE INDEX IF NOT EXISTS demos_status  ON demos (status);
CREATE INDEX IF NOT EXISTS demos_ip      ON demos (ip, created_at);
CREATE INDEX IF NOT EXISTS demos_approved ON demos (approved_at);

-- Single-use signed links: a link's nonce is inserted on first use; a second insert fails.
CREATE TABLE IF NOT EXISTS used_tokens (
  nonce   TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);
