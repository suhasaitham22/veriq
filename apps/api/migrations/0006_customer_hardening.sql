-- Preserve account/content data. Legacy email-granted access is suspended, not trusted.
ALTER TABLE workspace_members ADD COLUMN admitted_at TEXT;
UPDATE workspace_members SET admitted_at=created_at WHERE role='owner';
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN mfa_seed TEXT;
ALTER TABLE users ADD COLUMN mfa_pending TEXT;
ALTER TABLE users ADD COLUMN mfa_pending_at TEXT;
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;
-- Legacy cookies remain usable only for personal/account setup until a TOTP login.
ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK(mfa_verified IN (0,1));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
ALTER TABLE workspaces ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0,1));
ALTER TABLE workspaces ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 7 AND 365);
ALTER TABLE workspaces ADD COLUMN retention_enabled INTEGER NOT NULL DEFAULT 1 CHECK(retention_enabled IN (0,1));
-- Existing history is never silently put on a deletion schedule by migration.
UPDATE workspaces SET retention_enabled=0;

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin','reviewer','viewer')),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  recipient_label TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  consumed_at TEXT,
  consumed_by TEXT REFERENCES users(id),
  CHECK(recipient_id<>created_by),
  CHECK(consumed_by IS NULL OR consumed_by=recipient_id)
);
CREATE INDEX invitations_workspace ON workspace_invitations(workspace_id,created_at,id);
CREATE INDEX invitations_recipient ON workspace_invitations(recipient_id,consumed_at);
CREATE INDEX invitations_expiration ON workspace_invitations(expires_at);
CREATE TABLE ai_budget (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL,
  input_bytes INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);

-- Controlled workspace teardown may remove its owner; ordinary membership APIs may not.
DROP TRIGGER protect_owner_delete;
CREATE TRIGGER protect_owner_delete BEFORE DELETE ON workspace_members
WHEN OLD.role='owner' AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deleting=1)
BEGIN SELECT RAISE(ABORT,'Workspace owner membership is protected'); END;
CREATE TRIGGER disabled_workspace_owner BEFORE INSERT ON workspaces
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND disabled=1)
BEGIN SELECT RAISE(ABORT,'Disabled account cannot own a workspace'); END;
CREATE TRIGGER disabled_account_ownership BEFORE UPDATE OF disabled ON users
WHEN NEW.disabled=1 AND EXISTS(SELECT 1 FROM workspaces WHERE owner_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Delete owned workspaces before disabling the account'); END;

-- Bounded total storage across all tenants, not a per-account multiplier.
-- Existing over-cap data remains readable/exportable/deletable; no migration truncation.
CREATE TRIGGER capacity_workspaces BEFORE INSERT ON workspaces
WHEN (SELECT COUNT(*) FROM workspaces)>=1000 AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY workspaces'); END;
CREATE TRIGGER capacity_documents BEFORE INSERT ON support_documents
WHEN (SELECT COUNT(*) FROM support_documents)>=1000 AND NOT EXISTS(SELECT 1 FROM support_documents WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY documents'); END;
CREATE TRIGGER capacity_reviews BEFORE INSERT ON support_reviews
WHEN (SELECT COUNT(*) FROM support_reviews)>=1000 OR (SELECT COUNT(*) FROM support_reviews WHERE workspace_id=NEW.workspace_id)>=500 OR length(CAST(NEW.review_json AS BLOB))>131072
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY reviews'); END;
CREATE TRIGGER capacity_evidence BEFORE INSERT ON evidence_items
WHEN (SELECT COUNT(*) FROM evidence_items)>=1000
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY evidence'); END;
CREATE TRIGGER capacity_chat BEFORE INSERT ON chat_turns
WHEN (SELECT COUNT(*) FROM chat_turns)>=1000 AND NOT EXISTS(SELECT 1 FROM chat_turns WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY chat'); END;
CREATE TRIGGER capacity_feedback BEFORE INSERT ON pilot_feedback
WHEN (SELECT COUNT(*) FROM pilot_feedback)>=1000
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY feedback'); END;
CREATE TRIGGER capacity_audit BEFORE INSERT ON audit_events
WHEN (SELECT COUNT(*) FROM audit_events)>=5000 OR length(CAST(NEW.metadata_json AS BLOB))>8192
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY audit'); END;
CREATE TRIGGER capacity_invitations BEFORE INSERT ON workspace_invitations
WHEN (SELECT COUNT(*) FROM workspace_invitations)>=2000
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY invitations'); END;
CREATE TRIGGER capacity_request_limits BEFORE INSERT ON request_limits
WHEN (SELECT COUNT(*) FROM request_limits)>=5000 AND NOT EXISTS(SELECT 1 FROM request_limits WHERE key=NEW.key AND window=NEW.window)
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY rate-limit keys'); END;
CREATE TRIGGER capacity_attachments BEFORE INSERT ON review_attachments
WHEN (SELECT COUNT(*) FROM review_attachments)>=5000 AND NOT EXISTS(SELECT 1 FROM review_attachments WHERE review_id=NEW.review_id AND item_id=NEW.item_id)
BEGIN SELECT RAISE(ABORT,'VERIQ_CAPACITY attachments'); END;
CREATE INDEX chat_parent ON chat_turns(parent_id);
CREATE INDEX chat_review ON chat_turns(review_id);

-- Human approval responsibility is recorded separately from model judgments.
-- Retention/deletion removes the governed attestation with its parent review.
CREATE TABLE review_attestations (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES support_reviews(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decided_by TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL,
  policy_applicability_confirmed INTEGER NOT NULL CHECK(policy_applicability_confirmed=1),
  account_facts_checked INTEGER NOT NULL CHECK(account_facts_checked=1),
  evidence_inspected INTEGER NOT NULL CHECK(evidence_inspected=1),
  policy_scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(review_id,revision)
);
CREATE INDEX review_attestations_review ON review_attestations(review_id,revision);
CREATE INDEX review_attestations_workspace ON review_attestations(workspace_id,created_at,id);
CREATE TRIGGER review_attestation_immutable BEFORE UPDATE ON review_attestations
BEGIN SELECT RAISE(ABORT,'Approval attestations are immutable; record a new decision revision'); END;
