CREATE TABLE pilot_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  review_id TEXT REFERENCES support_reviews(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  kind TEXT NOT NULL CHECK(kind IN ('usability','evidence','policy_gap','other')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX feedback_workspace ON pilot_feedback(workspace_id,created_at,id);
CREATE INDEX feedback_author ON pilot_feedback(user_id,created_at);
CREATE TRIGGER feedback_immutable BEFORE UPDATE ON pilot_feedback
BEGIN SELECT RAISE(ABORT,'Pilot feedback is append-only'); END;
