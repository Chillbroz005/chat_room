-- R-02: opaque, revocable room invitations and versioned policy acceptance.
CREATE TABLE IF NOT EXISTS room_invites (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS room_invites_room_active
  ON room_invites(room_id, revoked_at);
CREATE TABLE IF NOT EXISTS policy_acceptances (
  visitor_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, policy_version)
);
