ALTER TABLE rooms ADD COLUMN creator_id TEXT;
UPDATE rooms
SET creator_id = (
  SELECT visitor_id
  FROM room_admins
  WHERE room_admins.room_id = rooms.id
  ORDER BY rowid
  LIMIT 1
)
WHERE creator_id IS NULL;

CREATE TABLE IF NOT EXISTS muted (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, visitor_id)
);

CREATE TABLE IF NOT EXISTS master_attempts (
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS master_attempt_window ON master_attempts(visitor_id,created_at);
