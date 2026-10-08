CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  is_personal INTEGER NOT NULL DEFAULT 0 CHECK(is_personal IN (0,1)),
  require_two_person INTEGER NOT NULL DEFAULT 1 CHECK(require_two_person IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX personal_workspace_owner ON workspaces(owner_id) WHERE is_personal = 1;
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(workspace_id,user_id)
);
CREATE INDEX memberships_user ON workspace_members(user_id);
INSERT INTO workspaces(id,name,owner_id,is_personal,require_two_person) SELECT id,'Personal workspace',id,1,0 FROM users;
INSERT INTO workspace_members(workspace_id,user_id,role) SELECT id,id,'owner' FROM users;

CREATE TABLE documents_v3 (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, version TEXT NOT NULL,
  content TEXT NOT NULL, content_hash TEXT NOT NULL, source_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), approved_at TEXT,
  approved_by TEXT REFERENCES users(id), valid_from TEXT, valid_until TEXT,
  UNIQUE(workspace_id,title,version)
);
INSERT INTO documents_v3(id,workspace_id,user_id,title,version,content,content_hash,source_url,status,created_at,approved_at,approved_by)
SELECT id,user_id,user_id,title,version,content,content_hash,source_url,status,created_at,approved_at,
  CASE WHEN status='approved' THEN user_id ELSE NULL END FROM support_documents;
DROP TABLE support_documents;
ALTER TABLE documents_v3 RENAME TO support_documents;
CREATE INDEX documents_workspace ON support_documents(workspace_id,status,created_at,id);
ALTER TABLE support_reviews ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE support_reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE support_reviews ADD COLUMN decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected'));
ALTER TABLE support_reviews ADD COLUMN decision_note TEXT;
ALTER TABLE support_reviews ADD COLUMN decided_by TEXT REFERENCES users(id);
ALTER TABLE support_reviews ADD COLUMN decided_at TEXT;
ALTER TABLE support_reviews ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE support_reviews SET workspace_id=user_id, status=json_extract(review_json,'$.status');
CREATE INDEX reviews_workspace ON support_reviews(workspace_id,created_at,id);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, object_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_workspace ON audit_events(workspace_id,created_at,id);
CREATE TABLE request_limits (
  key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(key,window)
);
CREATE INDEX limits_expiration ON request_limits(expires_at);
CREATE TABLE review_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL, request_hash TEXT NOT NULL, lease TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),
  review_id TEXT REFERENCES support_reviews(id), expires_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id,key)
);
CREATE INDEX requests_expiration ON review_requests(expires_at);
CREATE INDEX session_owner ON sessions(user_id);
-- Policy provenance and review evidence cannot be edited in place, even by an accidental SQL update.
CREATE TRIGGER document_immutable BEFORE UPDATE OF workspace_id,user_id,title,version,content,content_hash,source_url,valid_from,valid_until ON support_documents
BEGIN SELECT RAISE(ABORT,'Create a new document version instead of changing provenance'); END;
CREATE TRIGGER review_immutable BEFORE UPDATE OF workspace_id,user_id,draft_text,review_json,status ON support_reviews
BEGIN SELECT RAISE(ABORT,'Review evidence is immutable'); END;
CREATE TRIGGER protect_owner_delete BEFORE DELETE ON workspace_members WHEN OLD.role='owner'
BEGIN SELECT RAISE(ABORT,'Workspace owner membership is protected'); END;
CREATE TRIGGER protect_owner_role BEFORE UPDATE OF role ON workspace_members WHEN OLD.role='owner' OR NEW.role='owner'
BEGIN SELECT RAISE(ABORT,'Ownership transfer requires a separate workflow'); END;
