ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;

CREATE TABLE IF NOT EXISTS message_reactions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK(emoji IN ('👍','❤️','😂','😮','😢','🎉')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, visitor_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_room_message ON message_reactions(room_id, message_id);

CREATE TABLE IF NOT EXISTS typing (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS typing_room_updated ON typing(room_id, updated_at);
