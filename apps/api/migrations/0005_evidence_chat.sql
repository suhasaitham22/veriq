-- Private supporting references. Approval is a human decision, not AI verification.
CREATE TABLE evidence_items (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('link','media')),
 title TEXT NOT NULL, note TEXT NOT NULL, source_url TEXT, object_key TEXT UNIQUE,
 filename TEXT, media_type TEXT, byte_size INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','archived')),
 approved_by TEXT REFERENCES users(id), approved_at TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')),
 CHECK((kind='link' AND source_url IS NOT NULL AND object_key IS NULL AND byte_size=0) OR
       (kind='media' AND source_url IS NULL AND object_key IS NOT NULL AND byte_size>0))
);
CREATE INDEX evidence_workspace ON evidence_items(workspace_id,created_at DESC,id DESC);
CREATE TRIGGER immutable_evidence BEFORE UPDATE ON evidence_items
WHEN NEW.id!=OLD.id OR NEW.workspace_id!=OLD.workspace_id OR NEW.user_id!=OLD.user_id OR
 NEW.kind!=OLD.kind OR NEW.title!=OLD.title OR NEW.note!=OLD.note OR
 NEW.source_url IS NOT OLD.source_url OR NEW.object_key IS NOT OLD.object_key OR
 NEW.filename IS NOT OLD.filename OR NEW.media_type IS NOT OLD.media_type OR
 NEW.byte_size!=OLD.byte_size OR NEW.content_hash!=OLD.content_hash OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'Evidence content is immutable'); END;
CREATE TABLE review_attachments (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 review_id TEXT NOT NULL REFERENCES support_reviews(id), item_id TEXT NOT NULL REFERENCES evidence_items(id),
 user_id TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), UNIQUE(review_id,item_id)
);
CREATE INDEX attachments_review ON review_attachments(workspace_id,review_id);
CREATE TRIGGER immutable_attachment BEFORE UPDATE ON review_attachments BEGIN SELECT RAISE(ABORT,'Attachment is immutable'); END;
CREATE TABLE chat_turns (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, parent_id TEXT REFERENCES chat_turns(id),
 question TEXT NOT NULL, document_ids_json TEXT NOT NULL, answer TEXT,
 review_id TEXT REFERENCES support_reviews(id), state TEXT NOT NULL CHECK(state IN ('running','failed','completed')),
 lease TEXT NOT NULL, lease_until INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT(datetime('now')), UNIQUE(workspace_id,user_id,request_key)
);
CREATE INDEX chat_workspace ON chat_turns(workspace_id,created_at DESC,id DESC);
CREATE TRIGGER immutable_chat_input BEFORE UPDATE ON chat_turns
WHEN NEW.id!=OLD.id OR NEW.workspace_id!=OLD.workspace_id OR NEW.user_id!=OLD.user_id OR
 NEW.request_key!=OLD.request_key OR NEW.request_hash!=OLD.request_hash OR
 NEW.parent_id IS NOT OLD.parent_id OR NEW.question!=OLD.question OR
 NEW.document_ids_json!=OLD.document_ids_json OR NEW.created_at!=OLD.created_at OR
 (OLD.answer IS NOT NULL AND NEW.answer IS NOT OLD.answer) OR
 (OLD.state='completed' AND (NEW.state!=OLD.state OR NEW.review_id IS NOT OLD.review_id))
BEGIN SELECT RAISE(ABORT,'Chat input and completed answers are immutable'); END;
