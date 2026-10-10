-- Rolling-window rate limits for account signup/login. Store only hashed identifiers.
CREATE TABLE IF NOT EXISTS account_auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  username_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('login', 'signup')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_auth_attempts_ip_time
  ON account_auth_attempts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_account_auth_attempts_user_time
  ON account_auth_attempts (username_key, created_at);
