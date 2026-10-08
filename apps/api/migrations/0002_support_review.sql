CREATE TABLE support_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  UNIQUE (user_id, title, version)
);
CREATE INDEX support_documents_owner ON support_documents(user_id, status);
CREATE TABLE support_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  draft_text TEXT NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX support_reviews_owner ON support_reviews(user_id, created_at);
