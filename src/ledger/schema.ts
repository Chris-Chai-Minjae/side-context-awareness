import { Database } from "bun:sqlite"
import { configureSqlite } from "../memory/sqlite"

configureSqlite()

const SCHEMA_VERSION = 1

const V1_DDL = `
CREATE TABLE context_awareness_blobs (
  id TEXT PRIMARY KEY NOT NULL,
  content_hash TEXT NOT NULL,
  content BLOB NOT NULL,
  redacted_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  frame_id TEXT,
  frame_index INTEGER
);
CREATE TABLE context_awareness_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  app_name TEXT NOT NULL DEFAULT '',
  bundle_id TEXT NOT NULL DEFAULT '',
  window_title TEXT NOT NULL DEFAULT '',
  url TEXT,
  domain TEXT,
  target TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL,
  blob_id TEXT REFERENCES context_awareness_blobs(id) ON DELETE SET NULL,
  session_id TEXT
);
CREATE TABLE context_awareness_frames (
  id TEXT PRIMARY KEY NOT NULL,
  content BLOB NOT NULL,
  member_count INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE context_awareness_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  window_from INTEGER NOT NULL,
  window_to INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  body TEXT,
  apps TEXT NOT NULL DEFAULT '[]',
  domains TEXT NOT NULL DEFAULT '[]',
  citations TEXT NOT NULL DEFAULT '[]',
  source_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  digested_at INTEGER
);
CREATE INDEX idx_context_awareness_blobs_frame
  ON context_awareness_blobs(frame_id);
CREATE UNIQUE INDEX idx_context_awareness_blobs_hash
  ON context_awareness_blobs(content_hash);
CREATE INDEX idx_context_awareness_blobs_last_seen
  ON context_awareness_blobs(last_seen_at);
CREATE INDEX idx_context_awareness_events_app
  ON context_awareness_events(bundle_id, occurred_at);
CREATE INDEX idx_context_awareness_events_blob
  ON context_awareness_events(blob_id);
CREATE INDEX idx_context_awareness_events_domain
  ON context_awareness_events(domain, occurred_at);
CREATE INDEX idx_context_awareness_events_occurred
  ON context_awareness_events(occurred_at);
CREATE INDEX idx_context_awareness_events_session
  ON context_awareness_events(session_id, occurred_at);
CREATE INDEX idx_context_awareness_summaries_lease
  ON context_awareness_summaries(status, lease_expires_at);
CREATE INDEX idx_context_awareness_summaries_ready
  ON context_awareness_summaries(status, available_at);
CREATE INDEX idx_context_awareness_summaries_status
  ON context_awareness_summaries(status, window_from);
CREATE UNIQUE INDEX idx_context_awareness_summaries_unique_window
  ON context_awareness_summaries(kind, window_from, window_to);
CREATE INDEX idx_context_awareness_summaries_window
  ON context_awareness_summaries(kind, window_to);
CREATE TABLE side_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE side_terms (term_hash TEXT NOT NULL, event_id TEXT NOT NULL
  REFERENCES context_awareness_events(id) ON DELETE CASCADE, PRIMARY KEY(term_hash, event_id)) WITHOUT ROWID;
CREATE TABLE side_suppressions (bucket_start INTEGER NOT NULL, scope TEXT NOT NULL, key_hash TEXT NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY(bucket_start, scope, key_hash)) WITHOUT ROWID;
CREATE TABLE side_day_counters (day TEXT PRIMARY KEY, events INTEGER, blobs INTEGER, raw_bytes INTEGER,
  suppressions INTEGER, masks INTEGER);
`

const MIGRATIONS = [{ version: 1, sql: V1_DDL }] as const

export class LedgerSchemaVersionError extends Error {
  constructor(readonly value: string | null) {
    super(`Unsupported ledger schema version: ${value ?? "missing"}`)
    this.name = "LedgerSchemaVersionError"
  }
}

function currentVersion(db: Database): number {
  const hasMeta = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'side_meta'",
    )
    .get()
  if (!hasMeta) {
    const existingTable = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get()
    if (existingTable) throw new LedgerSchemaVersionError(null)
    return 0
  }

  const value =
    db
      .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'schema_version'")
      .get()?.value ?? null
  const version = value && /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION)
    throw new LedgerSchemaVersionError(value)
  return version
}

function migrate(db: Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.query(
        "INSERT INTO side_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version))
    })()
  }
}

export function openLedger(path: string): Database {
  const db = new Database(path)
  try {
    const version = currentVersion(db)
    if (version === 0) db.exec("PRAGMA auto_vacuum=INCREMENTAL")
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
    `)
    migrate(db, version)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
