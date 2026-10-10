CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🐺',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_accounts (
  visitor_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_accounts_account_id ON browser_accounts(account_id);
