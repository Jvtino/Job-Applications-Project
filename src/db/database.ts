// src/db/database.ts
//
// Local SQLite datastore (better-sqlite3). Single-user per install: one DB file on this
// machine, gitignored, never synced anywhere. The profile and the SEPARATE facts ledger are
// each stored as a single (optionally encrypted) blob — see crypto.ts.

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DB = Database.Database;

let singleton: DB | undefined;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  id             TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  data           BLOB    NOT NULL,
  enc            INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  profile_id TEXT PRIMARY KEY,
  data       BLOB    NOT NULL,
  enc        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Append-only audit trail. Every automated action the app takes (and every pause/confirm)
-- is recorded here for Module 7; Milestone 1 already writes ingest/approve events.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  ts         TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);

-- Applications submitted/attempted. Enforces HARD DEDUP (unique dedup_key per profile) and
-- backs per-company rate limiting. status: needs_review | submitted | skipped | challenge.
CREATE TABLE IF NOT EXISTS applications (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  dedup_key  TEXT NOT NULL,
  company    TEXT,
  title      TEXT,
  url        TEXT,
  ats        TEXT,
  mode       TEXT,
  status     TEXT NOT NULL,
  submitted  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, dedup_key)
);

-- Saved application drafts generated from approved resume facts. These are review artifacts, not
-- submissions: status tracks the user's pipeline state independently from browser submission.
CREATE TABLE IF NOT EXISTS application_drafts (
  id                       TEXT PRIMARY KEY,
  profile_id               TEXT NOT NULL,
  job_id                   TEXT,
  dedup_key                TEXT NOT NULL,
  company                  TEXT,
  title                    TEXT,
  apply_url                TEXT,
  tailored_resume_summary  TEXT,
  cover_letter             TEXT,
  application_answers      TEXT,
  status                   TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (profile_id, dedup_key),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Target companies/sources to monitor. Each row is a supported ATS board or job-search source.
-- auto_submit_approved is the per-employer allowlist used by the
-- 24/7 auto mode (CAPTCHA-free forms the user has explicitly pre-approved).
CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  board_url           TEXT NOT NULL,
  ats_type            TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  auto_submit_approved INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  UNIQUE (board_url)
);

-- Discovery provenance. These tables intentionally sit beside discovered_jobs instead of replacing
-- it in one jump: discovered_jobs remains the dashboard/read model, while this graph preserves the
-- run/query/observation/filter/score audit trail needed to explain every result.
CREATE TABLE IF NOT EXISTS discovery_runs (
  trace_id             TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  status               TEXT NOT NULL,
  target_snapshot_json TEXT,
  summary_json         TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS source_queries (
  id             TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_label   TEXT,
  query_text     TEXT NOT NULL,
  params_json    TEXT,
  result_count   INTEGER,
  status         TEXT NOT NULL,
  failure_reason TEXT,
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_source_queries_trace ON source_queries(trace_id);

CREATE TABLE IF NOT EXISTS raw_job_observations (
  id                 TEXT PRIMARY KEY,
  trace_id           TEXT NOT NULL,
  query_id           TEXT,
  profile_id         TEXT NOT NULL,
  source_type        TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  fetched_url        TEXT,
  http_status        INTEGER,
  content_type       TEXT,
  raw_payload_json   TEXT,
  raw_html_text      TEXT,
  detected_jsonld_json TEXT,
  parse_status       TEXT NOT NULL,
  parse_errors_json  TEXT,
  observed_at        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_raw_observations_trace ON raw_job_observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_raw_observations_query ON raw_job_observations(query_id);

CREATE TABLE IF NOT EXISTS normalized_jobs (
  job_id                       TEXT PRIMARY KEY,
  profile_id                   TEXT NOT NULL,
  canonical_company            TEXT NOT NULL,
  canonical_title              TEXT NOT NULL,
  location                     TEXT,
  country                      TEXT,
  remote_type                  TEXT,
  canonical_url                TEXT NOT NULL,
  application_url              TEXT NOT NULL,
  ats_type                     TEXT,
  role_family                  TEXT,
  seniority                    TEXT,
  years_required_min           REAL,
  years_required_max           REAL,
  salary_min                   REAL,
  salary_max                   REAL,
  salary_currency              TEXT,
  description_text             TEXT,
  requirements_json            TEXT,
  skills_required_json         TEXT,
  skills_preferred_json        TEXT,
  certifications_required_json TEXT,
  clearance_requirement        TEXT,
  sponsorship_requirement      TEXT,
  posting_date                 TEXT,
  expiration_date              TEXT,
  normalization_confidence     REAL NOT NULL,
  status                       TEXT NOT NULL,
  first_seen_at                TEXT NOT NULL,
  last_seen_at                 TEXT NOT NULL,
  observation_count            INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_normalized_jobs_profile_status ON normalized_jobs(profile_id, status);

CREATE TABLE IF NOT EXISTS job_observation_links (
  job_id           TEXT NOT NULL,
  observation_id   TEXT NOT NULL,
  trace_id         TEXT NOT NULL,
  is_primary_source INTEGER NOT NULL DEFAULT 0,
  source_rank      INTEGER NOT NULL DEFAULT 0,
  match_confidence REAL NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (job_id, observation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_job_observation_links_trace ON job_observation_links(trace_id);

CREATE TABLE IF NOT EXISTS dedupe_groups (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL,
  job_id               TEXT NOT NULL,
  dedupe_key           TEXT NOT NULL,
  group_confidence     REAL NOT NULL,
  survivor_reason_json TEXT,
  merged_fields_json   TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (profile_id, dedupe_key)
) STRICT;

CREATE TABLE IF NOT EXISTS filter_decisions (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  trace_id       TEXT NOT NULL,
  filter_name    TEXT NOT NULL,
  result         TEXT NOT NULL,
  reason_code    TEXT NOT NULL,
  reason_text    TEXT NOT NULL,
  evidence_json  TEXT,
  decided_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_filter_decisions_job ON filter_decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_filter_decisions_trace ON filter_decisions(trace_id);

CREATE TABLE IF NOT EXISTS scorecards (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL,
  trace_id              TEXT NOT NULL,
  component_scores_json TEXT NOT NULL,
  overall_score         REAL NOT NULL,
  score_version         TEXT NOT NULL,
  explanation_json      TEXT,
  created_at            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_scorecards_job ON scorecards(job_id);
CREATE INDEX IF NOT EXISTS idx_scorecards_trace ON scorecards(trace_id);

CREATE TABLE IF NOT EXISTS rerank_decisions (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  trace_id         TEXT NOT NULL,
  input_facts_json TEXT,
  output_json      TEXT NOT NULL,
  model_name       TEXT,
  prompt_hash      TEXT,
  latency_ms       INTEGER,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS user_feedback (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  label             TEXT NOT NULL,
  reason_codes_json TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS normalized_jobs_fts
USING fts5(job_id UNINDEXED, title, company, location, description);

CREATE TABLE IF NOT EXISTS automation_progress (
  job_id              TEXT PRIMARY KEY,
  profile_id          TEXT NOT NULL,
  status              TEXT NOT NULL,
  current_step_label  TEXT NOT NULL,
  total_items         INTEGER NOT NULL DEFAULT 0,
  processed_items     INTEGER NOT NULL DEFAULT 0,
  qualified_count     INTEGER NOT NULL DEFAULT 0,
  one_click_count     INTEGER NOT NULL DEFAULT 0,
  applied_count       INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  percent_complete    REAL NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  error_message       TEXT,
  recent_events_json  TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS idx_automation_progress_profile_updated ON automation_progress(profile_id, updated_at DESC);

-- Account-required sites. METADATA ONLY: ApplyPilot detects when a career site requires an
-- account and records that you (the human) have/need one. There is intentionally NO password
-- column -- the app never stores, types, or transmits credentials. The password_store column
-- is just a free-text label (e.g. 1Password) pointing at where YOU saved it.
-- logged_in records that the PERSISTENT browser session is currently authenticated for this
-- site (you logged in once in the headed browser; the session persists in the browser profile).
-- It is NOT a credential — just a "session is live" flag so auto mode can reuse the login.
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL,
  domain         TEXT NOT NULL,
  username       TEXT,
  account_exists INTEGER NOT NULL DEFAULT 0,
  logged_in      INTEGER NOT NULL DEFAULT 0,
  last_login_at  TEXT,
  password_store TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (profile_id, domain)
);

-- Dashboard/read-model rows for discovered jobs. The discovery_* provenance tables preserve raw
-- observations, duplicate links, filter decisions, and scorecards; this table keeps current UI and
-- automation reads stable during the staged refactor.
CREATE TABLE IF NOT EXISTS discovered_jobs (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL,
  company      TEXT,
  title        TEXT,
  location     TEXT,
  job_url      TEXT NOT NULL,
  ats_type     TEXT,
  score        REAL,
  rationale    TEXT,
  knockouts    TEXT,
  salary_min   REAL,
  salary_max   REAL,
  description  TEXT,
  fit_factors  TEXT,
  tags         TEXT,
  status       TEXT NOT NULL,
  dedup_key    TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  UNIQUE (profile_id, dedup_key)
);

-- Cached semantic vector of the applicant (résumé insights + approved facts), one per profile.
-- Local-only embeddings; used to rank discovered jobs by cosine similarity. source_hash lets us
-- skip re-embedding when the underlying text is unchanged.
CREATE TABLE IF NOT EXISTS profile_embeddings (
  profile_id  TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- DERIVED résumé understanding (years of experience, seniority, domains, skills) used ONLY for
-- job matching. This is inference, kept SEPARATE from the literal facts ledger; it is never a
-- résumé claim and never feeds document generation. Stored as JSON text.
CREATE TABLE IF NOT EXISTS resume_insights (
  profile_id TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Content-addressed cache of LLM completions (e.g. job fit reranking). Local models are slow, so
-- caching keyed by a hash of model+prompt makes re-runs cheap. Safe to clear at any time.
CREATE TABLE IF NOT EXISTS llm_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Per-call LLM usage metering (commercial M3): which feature used which model and how many tokens.
-- Append-only, NO prompt/completion text and no PII — this is the local ledger the paid tier's
-- usage display and billing reconciliation read from. Safe to clear at any time.
CREATE TABLE IF NOT EXISTS llm_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  feature       TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);

-- Redacted snapshot of what the form-fill agent actually resolved on an employer form (the review
-- gate's filled / flagged / needs-confirmation entries), captured locally so the Applications tab can
-- show the real field-by-field application. Protected-class self-ID and work-authorization VALUES are
-- redacted before write (see src/server/fill-snapshot.ts), so no sensitive value is stored in plaintext.
CREATE TABLE IF NOT EXISTS fill_snapshots (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,
  dedup_key     TEXT NOT NULL,
  company       TEXT,
  title         TEXT,
  url           TEXT,
  ats           TEXT,
  submitted     INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (profile_id, dedup_key)
);
`;

export function openDatabase(dbPath: string): DB {
  // ":memory:" and "" are SQLite's sentinels for a transient database the driver keeps off the
  // real filesystem (anonymous in-memory / private temp). Pass them through verbatim: never
  // resolve() them to a path (which would create a literal ":memory:" file in the cwd) and skip
  // WAL — SQLite silently downgrades it to journal_mode=memory anyway, so enabling it is a no-op.
  const inMemory = dbPath === ":memory:" || dbPath === "";
  let db: DB;
  if (inMemory) {
    db = new Database(dbPath);
  } else {
    const abs = resolve(dbPath);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(abs);
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/** Idempotent column adds for DBs created before a column existed. */
function migrate(db: DB): void {
  const addColumn = (table: string, col: string, decl: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    } catch {
      /* column already exists — ignore */
    }
  };
  addColumn("accounts", "logged_in", "INTEGER NOT NULL DEFAULT 0");
  addColumn("accounts", "last_login_at", "TEXT");
  // Semantic matching: cache each posting's job-description embedding for cosine ranking.
  addColumn("discovered_jobs", "embedding", "BLOB");
  addColumn("discovered_jobs", "embedding_model", "TEXT");
  // Recency signal: when the posting was published, if the board exposes it.
  addColumn("discovered_jobs", "posted_at", "TEXT");
  // Strategy tier the user assigns to a match: A (dream), B (strong fit), C (backup). NULL = unset.
  // Drives effort allocation + review prioritization; Tier A is also structurally barred from
  // auto-submit by the pure gate (decideAutoSubmit) as defense-in-depth.
  addColumn("discovered_jobs", "tier", "TEXT");
  // Chronicle dashboard fields: optional, populated when discovery reads the detail page.
  addColumn("discovered_jobs", "salary_min", "REAL");
  addColumn("discovered_jobs", "salary_max", "REAL");
  addColumn("discovered_jobs", "description", "TEXT");
  addColumn("discovered_jobs", "fit_factors", "TEXT");
  addColumn("discovered_jobs", "tags", "TEXT");
  // Rich structured job-fit assessment (JobFitScore JSON): category, reasoning, concerns, missing
  // requirements, recommended action. Populated by the job-fit engine when a description is analyzed.
  addColumn("discovered_jobs", "fit", "TEXT");
}

/** Process-wide shared handle, opened lazily. */
export function getDatabase(dbPath: string): DB {
  if (!singleton) singleton = openDatabase(dbPath);
  return singleton;
}

export function closeDatabase(): void {
  singleton?.close();
  singleton = undefined;
}

export function recordAudit(
  db: DB,
  profileId: string | null,
  action: string,
  detail?: unknown
): void {
  db.prepare(
    "INSERT INTO audit_log (profile_id, ts, action, detail) VALUES (?, ?, ?, ?)"
  ).run(
    profileId,
    new Date().toISOString(),
    action,
    detail === undefined ? null : JSON.stringify(detail)
  );
}
