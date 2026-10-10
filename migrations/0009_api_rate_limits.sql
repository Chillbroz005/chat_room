-- Rolling-window rate limits for room creation and message posting.
-- Identifiers are SHA-256 hashes; no raw IP or browser session IDs are stored.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  room_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_lookup
  ON api_rate_limits (action, subject_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_created
  ON api_rate_limits (created_at);
