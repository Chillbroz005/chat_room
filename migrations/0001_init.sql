CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  password_salt TEXT,
  password_hash TEXT
);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);

CREATE TABLE IF NOT EXISTS members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(room_id, visitor_id)
);
CREATE TABLE IF NOT EXISTS room_admins (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  PRIMARY KEY(room_id, visitor_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','gif','event')),
  text TEXT NOT NULL DEFAULT '',
  gif_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room_id,id);
CREATE TABLE IF NOT EXISTS blocked (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, visitor_id)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_room_id ON activity(room_id,id);
CREATE TABLE IF NOT EXISTS join_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS join_attempt_window ON join_attempts(room_id,visitor_id,created_at);
