CREATE TABLE IF NOT EXISTS room_usernames (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, display_name),
  UNIQUE (room_id, visitor_id)
);
