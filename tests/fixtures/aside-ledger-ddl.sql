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
