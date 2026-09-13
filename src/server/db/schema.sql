-- Command Center schema.
--
-- Single-user by design. There are no ownership columns anywhere: adding
-- multi-user scoping later is one migration, whereas threading an unused owner
-- id through every query and index costs clarity on every single read.
--
-- Timestamp convention: every timestamp column is TEXT holding ISO-8601 UTC.
-- Mixed epoch-seconds/epoch-millis columns are the single most common source of
-- off-by-1000 date bugs, so this schema simply does not have integer times.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  source_job_id    TEXT,
  title            TEXT NOT NULL,
  company          TEXT NOT NULL,
  location         TEXT,
  is_remote        INTEGER,
  url              TEXT NOT NULL,
  apply_url        TEXT,
  description_text TEXT NOT NULL DEFAULT '',
  salary_text      TEXT,
  posted_at        TEXT,
  status           TEXT NOT NULL DEFAULT 'discovered'
                     CHECK (status IN ('discovered','screened','ready','applied','closed')),
  score            INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  score_reason     TEXT,
  brief            TEXT,
  tailored_headline TEXT,
  tailored_summary  TEXT,
  tailored_skills   TEXT,
  resume_path       TEXT,
  -- Search support, derived from the posting at write time by the jobs
  -- repository. `search_blob` is a lowercased "title | company | location |
  -- description" concatenation scanned with LIKE: FTS5 is not guaranteed to be
  -- compiled into the SQLite bundled with Node, and at this corpus size a scan
  -- over one prepared column is both faster to reason about and impossible to
  -- leave stale. The experience columns are parsed out of the prose, which is
  -- the only place a board states it, and `salary_annual` is the top of the
  -- published range in dollars per year, because no SQL expression can compare
  -- "$180k - $220k" to a pay floor.
  experience_min_years INTEGER,
  experience_max_years INTEGER,
  salary_annual    INTEGER,
  -- Geography rolled up out of `location`: the ISO alpha-2 the place text
  -- names, and its macro region. A facet over the raw string is a list of
  -- cities, which is not a filter anyone can use.
  location_country TEXT,
  location_region  TEXT,
  -- Outreach recipient. `contact_email` is derived from the posting prose and
  -- owned by the derivation; `contact_email_manual` is owned by the user and
  -- always wins. Two columns rather than one plus a provenance flag so a
  -- re-ingest or a re-parse can never clobber an address a human confirmed.
  contact_email        TEXT,
  contact_email_manual TEXT,
  search_blob      TEXT NOT NULL DEFAULT '',
  discovered_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Re-ingesting a board must update rather than duplicate. `url` is the natural
-- key every adapter can supply; (source, source_job_id) is the stronger one
-- when the board exposes an id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_job
  ON jobs(source, source_job_id) WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status_discovered
  ON jobs(status, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);
-- Indexes over the three columns above are created by `ensureJobSearchSchema`
-- (src/server/search/schema.ts), not here: a database predating those columns
-- only grows them via ALTER, and a CREATE INDEX naming a column that does not
-- exist yet would fail this whole file on open.

-- Namespaced tags (`skill:python`, `level:senior`) derived from the posting's
-- own words at write time. A row per tag rather than a delimited column: a
-- facet is then a GROUP BY over an index instead of a scan that has to parse
-- its own storage format, and a filter is an exact match instead of a LIKE
-- that would let `skill:go` match `skill:golang` if the vocabulary ever grew
-- one.
CREATE TABLE IF NOT EXISTS job_tags (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL CHECK (kind IN ('level','skill','employment','eligibility')),
  tag    TEXT NOT NULL,
  PRIMARY KEY (job_id, tag)
) WITHOUT ROWID;

-- The facet direction (tag -> jobs) is the one the primary key cannot serve.
CREATE INDEX IF NOT EXISTS idx_job_tags_tag ON job_tags(tag, job_id);

CREATE TABLE IF NOT EXISTS stage_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL
                CHECK (to_stage IN ('applied','recruiter_screen','technical_interview','onsite','offer','closed')),
  outcome     TEXT
                CHECK (outcome IS NULL OR outcome IN ('offer_accepted','offer_declined','rejected','withdrawn','ghosted')),
  note        TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_events_job
  ON stage_events(job_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS interviews (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scheduled_at  TEXT NOT NULL,
  duration_mins INTEGER,
  type          TEXT NOT NULL
                  CHECK (type IN ('recruiter_screen','technical','system_design','behavioural','onsite')),
  outcome       TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_interviews_job ON interviews(job_id, scheduled_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('follow_up','prep','todo')),
  title        TEXT NOT NULL,
  due_at       TEXT,
  is_completed INTEGER NOT NULL DEFAULT 0,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(is_completed, due_at);

-- Click-tracked links embedded in a submitted resume. A non-bot click is the
-- only engagement signal available before a reply arrives.
CREATE TABLE IF NOT EXISTS resume_links (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS resume_link_clicks (
  id            TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL REFERENCES resume_links(id) ON DELETE CASCADE,
  clicked_at    TEXT NOT NULL,
  is_likely_bot INTEGER NOT NULL DEFAULT 0,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_link
  ON resume_link_clicks(link_id, is_likely_bot, clicked_at DESC);

-- ---------------------------------------------------------------------------
-- Outbound connectors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connectors (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL
                      CHECK (provider IN ('google_sheets','notion','gmail_send')),
  account_key       TEXT NOT NULL DEFAULT 'default',
  display_name      TEXT,
  status            TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (status IN ('disconnected','connected','error')),
  credentials       TEXT,
  config            TEXT,
  last_connected_at TEXT,
  last_synced_at    TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, account_key)
);

CREATE TABLE IF NOT EXISTS connector_sync_runs (
  id                 TEXT PRIMARY KEY,
  connector_id       TEXT REFERENCES connectors(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL,
  account_key        TEXT NOT NULL DEFAULT 'default',
  status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','completed','failed','cancelled')),
  trigger            TEXT NOT NULL DEFAULT 'manual'
                       CHECK (trigger IN ('manual','agent','schedule')),
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  records_considered INTEGER NOT NULL DEFAULT 0,
  records_created    INTEGER NOT NULL DEFAULT 0,
  records_updated    INTEGER NOT NULL DEFAULT 0,
  records_unchanged  INTEGER NOT NULL DEFAULT 0,
  records_failed     INTEGER NOT NULL DEFAULT 0,
  error_code         TEXT,
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_scope
  ON connector_sync_runs(provider, account_key, started_at DESC);

-- Idempotency ledger. `content_hash` is the digest of the rendered row, so a
-- re-push of unchanged data is a no-op instead of a duplicate write.
CREATE TABLE IF NOT EXISTS connector_records (
  id             TEXT PRIMARY KEY,
  connector_id   TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  entity_kind    TEXT NOT NULL
                   CHECK (entity_kind IN ('opportunity','application','interview','follow_up')),
  entity_id      TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  remote_url     TEXT,
  content_hash   TEXT NOT NULL,
  last_pushed_at TEXT NOT NULL,
  UNIQUE (connector_id, entity_kind, entity_id)
);

-- ---------------------------------------------------------------------------
-- Agent trace
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,
  job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  goal            TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run','live')),
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','awaiting_approval','completed','failed','cancelled')),
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  steps_total     INTEGER NOT NULL DEFAULT 0,
  steps_succeeded INTEGER NOT NULL DEFAULT 0,
  steps_failed    INTEGER NOT NULL DEFAULT 0,
  steps_skipped   INTEGER NOT NULL DEFAULT 0,
  llm_calls       INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS agent_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  tool              TEXT NOT NULL,
  app               TEXT NOT NULL DEFAULT 'local',
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','succeeded','failed','skipped','awaiting_approval','denied')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT,
  input             TEXT,
  output            TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  started_at        TEXT,
  completed_at      TEXT,
  decided_at        TEXT,
  decided_by        TEXT,
  error_code        TEXT,
  error_message     TEXT,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, seq);

-- Replay guard: a tool call that already succeeded under a given key must never
-- execute a second time, even across process restarts. This is the database-level
-- half of the guarantee; the step runner checks it before executing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steps_idempotency
  ON agent_steps(tool, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'succeeded';

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
