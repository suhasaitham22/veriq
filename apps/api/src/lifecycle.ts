import type { User } from "./auth.ts";
import { clearSessionCookie, requirePassword, requestSessionHash } from "./auth.ts";
import { requireMfa } from "./mfa.ts";
import { HttpError, readBody, uuid } from "./http.ts";
import { resolveScope, requireRole, auditStatement } from "./workspaces.ts";
import type { Scope } from "./workspaces.ts";
import { AI_CAPACITY, STORAGE_CAPACITY } from "./capacity.ts";

const SECTIONS = ["documents", "reviews", "attestations", "evidence", "attachments", "chat", "feedback", "audit", "members", "invitations"] as const;
type Section = typeof SECTIONS[number];
const EXPORTS: Record<Section, { table: string; key: string; columns: string; pageSize: number }> = {
  documents: { table: "support_documents", key: "id", columns: "*", pageSize: 25 },
  reviews: { table: "support_reviews", key: "id", columns: "*", pageSize: 10 },
  attestations: { table: "review_attestations", key: "id", columns: "*", pageSize: 100 },
  evidence: { table: "evidence_items", key: "id", columns: "id,workspace_id,user_id,kind,title,note,source_url,filename,media_type,byte_size,content_hash,status,approved_by,approved_at,created_at", pageSize: 100 },
  attachments: { table: "review_attachments", key: "id", columns: "*", pageSize: 100 },
  chat: { table: "chat_turns", key: "id", columns: "id,workspace_id,user_id,parent_id,question,document_ids_json,answer,review_id,state,created_at", pageSize: 100 },
  feedback: { table: "pilot_feedback", key: "id", columns: "*", pageSize: 100 },
  audit: { table: "audit_events", key: "id", columns: "*", pageSize: 100 },
  members: { table: "workspace_members", key: "user_id", columns: "user_id,role,admitted_at,created_at", pageSize: 100 },
  invitations: { table: "workspace_invitations", key: "id", columns: "id,workspace_id,recipient_id,role,recipient_label,created_by,created_at,expires_at,consumed_by,consumed_at,revoked_at", pageSize: 100 },
};

/** These predicates are evaluated inside a D1 batch, not from a stale application list. */
function retentionStatements(db: D1Database, workspaceId?: string, locked = false) {
  const selected = workspaceId ? `w.id=?${locked ? " AND w.deleting=1" : ""}` : "w.deleting=0 AND w.retention_enabled=1";
  const bind = (sql: string) => workspaceId ? db.prepare(sql).bind(workspaceId) : db.prepare(sql);
  const expiredReview = `SELECT r.id FROM support_reviews r JOIN workspaces w ON w.id=r.workspace_id
    WHERE ${selected} AND r.created_at<datetime('now','-'||w.retention_days||' days')
    AND NOT EXISTS(SELECT 1 FROM chat_turns c WHERE c.review_id=r.id)`;
  return [
    // Retain a conversation until its most recent turn expires; delete the entire tree together.
    bind(`WITH RECURSIVE tree(id,root,workspace_id) AS (
      SELECT c.id,c.id,c.workspace_id FROM chat_turns c JOIN workspaces w ON w.id=c.workspace_id WHERE c.parent_id IS NULL AND ${selected}
      UNION ALL SELECT c.id,t.root,c.workspace_id FROM chat_turns c JOIN tree t ON c.parent_id=t.id AND c.workspace_id=t.workspace_id
    ) DELETE FROM chat_turns WHERE id IN (SELECT t.id FROM tree t WHERE t.root IN (
      SELECT t2.root FROM tree t2 JOIN chat_turns c ON c.id=t2.id JOIN workspaces w ON w.id=t2.workspace_id
      GROUP BY t2.root HAVING MAX(c.created_at)<datetime('now','-'||w.retention_days||' days')))`),
    bind(`DELETE FROM review_requests WHERE review_id IN (${expiredReview})`),
    bind(`DELETE FROM review_attachments WHERE review_id IN (${expiredReview})`),
    bind(`DELETE FROM pilot_feedback WHERE review_id IN (${expiredReview})`),
    bind(`UPDATE audit_events SET metadata_json='{"contentRemovedByRetention":true}' WHERE workspace_id=(SELECT r.workspace_id FROM support_reviews r WHERE r.id=audit_events.object_id) AND object_id IN (${expiredReview})`),
    bind(`DELETE FROM support_reviews WHERE id IN (${expiredReview})`),
    bind(`DELETE FROM pilot_feedback WHERE id IN (SELECT f.id FROM pilot_feedback f JOIN workspaces w ON w.id=f.workspace_id WHERE ${selected} AND f.created_at<datetime('now','-'||w.retention_days||' days'))`),
    bind(`DELETE FROM audit_events WHERE workspace_id IN (SELECT w.id FROM workspaces w WHERE ${selected}) AND created_at<datetime('now','-365 days')`),
  ];
}

export async function purgeExpired(db: D1Database, workspaceId?: string) {
  const results = await db.batch(retentionStatements(db, workspaceId));
  return { chat: results[0].meta.changes, requests: results[1].meta.changes, attachments: results[2].meta.changes,
    feedback: results[3].meta.changes + results[6].meta.changes, reviews: results[5].meta.changes, audit: results[7].meta.changes };
}

export async function scheduledCleanup(db: D1Database) {
  await purgeExpired(db);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
    db.prepare("DELETE FROM request_limits WHERE expires_at<unixepoch()"),
    db.prepare("DELETE FROM review_requests WHERE expires_at<unixepoch()"),
    db.prepare("DELETE FROM workspace_invitations WHERE expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare("DELETE FROM usage WHERE day<date('now','-2 days')"),
    db.prepare("DELETE FROM ai_budget WHERE day<date('now','-2 days')"),
  ]);
}

// All credential/MFA changes revoke sessions in the same transaction. Rechecking
// the exact session here also fences changes made while password hashing awaited.
const OWNER_AUTHORIZATION = `SELECT 1 FROM workspaces w
  JOIN workspace_members m ON m.workspace_id=w.id AND m.role='owner' AND m.admitted_at IS NOT NULL
  JOIN users u ON u.id=m.user_id AND u.disabled=0
  JOIN sessions s ON s.user_id=u.id
  WHERE w.id=? AND w.owner_id=u.id AND u.id=? AND s.token_hash=?
  AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (w.is_personal=1 OR (s.mfa_verified=1 AND u.mfa_seed IS NOT NULL))`;

function deletionStatements(scope: Scope, sessionHash: string, retainWorkspace = false) {
  const { db, workspace, user } = scope;
  const guard = "EXISTS(SELECT 1 FROM workspaces WHERE id=? AND owner_id=? AND deleting=1)";
  return [
    db.prepare(`UPDATE workspaces SET deleting=1 WHERE id=? AND deleting=0 AND EXISTS(${OWNER_AUTHORIZATION})`).bind(workspace.id, workspace.id, user.id, sessionHash),
    ...["review_requests", "review_attachments", "pilot_feedback", "chat_turns", "support_reviews", "evidence_items", "support_documents", "audit_events", "workspace_invitations", "workspace_members"].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND ${guard}`).bind(workspace.id, workspace.id, user.id)),
    ...(retainWorkspace ? [] : [db.prepare("DELETE FROM workspaces WHERE id=? AND owner_id=? AND deleting=1").bind(workspace.id, user.id)]),
  ];
}

async function deleteLocalMedia(scope: Scope, media?: R2Bucket) {
  const rows = (await scope.db.prepare("SELECT object_key FROM evidence_items WHERE workspace_id=? AND object_key IS NOT NULL").bind(scope.workspace.id).all<{ object_key: string }>()).results;
  if (!rows.length) return;
  if (!media)
    throw new HttpError(409, "This workspace contains local-demo media. Run deletion in its local emulator with that object store attached; production media is disabled.", "LOCAL_MEDIA_PRESENT");
  for (const row of rows) await media.delete(row.object_key);
}

export async function lifecycleRoutes(req: Request, url: URL, db: D1Database, user: User, media?: R2Bucket) {
  const match = url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/(lifecycle|export|retention|purge|delete)$/);
  const accountDelete = url.pathname === "/api/account/delete" && req.method === "POST";
  if (!match && !accountDelete) return null;
  const sessionHash = (await requestSessionHash(req)) ?? "";
  if (accountDelete) {
    const body = await readBody(req);
    if (body.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm account deletion.");
    await requirePassword(db, user, body.password, "default", req.headers.get("cf-connecting-ip") ?? "unknown");
    if (user.mfaEnabled) requireMfa(user);
    if (await db.prepare("SELECT 1 FROM workspaces WHERE owner_id=? AND is_personal=0 LIMIT 1").bind(user.id).first())
      throw new HttpError(409, "Delete your owned team workspaces before deleting this account.", "OWNED_WORKSPACES_REMAIN");
    // A public signup must not be able to reserve a predictable deletion label.
    const deletedLabel = `deleted-${crypto.randomUUID()}@invalid.test`;
    // A never-opened account must remain deletable even when workspace capacity
    // is exhausted; do not provision a personal workspace just to erase it.
    if (!(await db.prepare("SELECT 1 FROM workspaces WHERE id=? AND owner_id=?").bind(user.id, user.id).first())) {
      const disabled = "EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=1)";
      const results = await db.batch([
        db.prepare("UPDATE users SET email=?,password_hash='',salt='',recovery_hash=NULL,mfa_seed=NULL,mfa_pending=NULL,mfa_pending_at=NULL,mfa_last_step=NULL,disabled=1 WHERE id=? AND disabled=0 AND NOT EXISTS(SELECT 1 FROM workspaces WHERE owner_id=?) AND EXISTS(SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .bind(deletedLabel, user.id, user.id, user.id, sessionHash),
        db.prepare(`DELETE FROM workspace_members WHERE user_id=? AND ${disabled}`).bind(user.id, user.id),
        db.prepare(`DELETE FROM workspace_invitations WHERE (recipient_id=? OR created_by=?) AND ${disabled}`).bind(user.id, user.id, user.id),
        db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${disabled}`).bind(user.id, user.id),
        db.prepare(`DELETE FROM receipts WHERE user_id=? AND ${disabled}`).bind(user.id, user.id),
      ]);
      if (results[0].meta.changes !== 1) throw new HttpError(409, "Account authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
      return new Response(JSON.stringify({ ok: true, sharedWorkspaceContentRetained: true }), { headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() } });
    }
    const personal = await resolveScope(db, user, null);
    await deleteLocalMedia(personal, media);
    const accountGuard = "EXISTS(SELECT 1 FROM workspaces WHERE id=? AND owner_id=? AND deleting=1)";
    const results = await db.batch([
      ...deletionStatements(personal, sessionHash, true),
      db.prepare(`DELETE FROM workspace_members WHERE user_id=? AND ${accountGuard}`).bind(user.id, user.id, user.id),
      db.prepare(`DELETE FROM workspace_invitations WHERE (recipient_id=? OR created_by=?) AND ${accountGuard}`).bind(user.id, user.id, user.id, user.id),
      db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${accountGuard}`).bind(user.id, user.id, user.id),
      db.prepare(`DELETE FROM receipts WHERE user_id=? AND ${accountGuard}`).bind(user.id, user.id, user.id),
      db.prepare("DELETE FROM workspaces WHERE id=? AND owner_id=? AND deleting=1").bind(user.id, user.id),
      db.prepare("UPDATE users SET email=?,password_hash='',salt='',recovery_hash=NULL,mfa_seed=NULL,mfa_pending=NULL,mfa_pending_at=NULL,mfa_last_step=NULL,disabled=1 WHERE id=? AND changes()=1").bind(deletedLabel, user.id),
    ]);
    if (results[0].meta.changes !== 1) throw new HttpError(409, "Account authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
    return new Response(JSON.stringify({ ok: true, sharedWorkspaceContentRetained: true }), { headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() } });
  }
  if (!match) return null;
  const scope = await resolveScope(db, user, match[1]);
  requireRole(scope, ["owner"]);
  const settings = await db.prepare("SELECT id,name,is_personal,retention_days,retention_enabled FROM workspaces WHERE id=?").bind(scope.workspace.id).first<{ id: string; name: string; is_personal: number; retention_days: number; retention_enabled: number }>();
  if (!settings) throw new HttpError(404, "Workspace not found.");
  if (match[2] === "lifecycle" && req.method === "GET") return { retentionDays: settings.retention_days, retentionEnabled: settings.retention_enabled === 1, auditRetentionDays: 365, limits: { storage: STORAGE_CAPACITY, ai: AI_CAPACITY }, policyLibraryRetainedUntilDeletion: true };
  if (req.method !== "POST") return null;
  const body = await readBody(req);
  if (["retention", "purge", "delete"].includes(match[2]) && body.workspaceName !== settings.name)
    throw new HttpError(400, "Type the exact workspace name to confirm this lifecycle change.", "WORKSPACE_CONFIRMATION_REQUIRED");
  if (!settings.is_personal && match[2] !== "export") requireMfa(user);
  await requirePassword(db, user, body.password, match[2] === "export" ? "export" : "default", req.headers.get("cf-connecting-ip") ?? "unknown");
  if (match[2] === "export") {
    const section = body.section ?? SECTIONS[0];
    if (!SECTIONS.includes(section as Section)) throw new HttpError(400, "Unknown export section.");
    const cursor = body.cursor ?? null;
    if (cursor !== null && !uuid(cursor)) throw new HttpError(400, "Invalid export cursor.");
    const spec = EXPORTS[section as Section];
    const rows = (await db.prepare(`SELECT ${spec.columns} FROM ${spec.table} WHERE workspace_id=? AND ${spec.key}>? ORDER BY ${spec.key} LIMIT ?`)
      .bind(scope.workspace.id, cursor ?? "", spec.pageSize + 1).all<Record<string, unknown>>()).results;
    if (!(await db.prepare(OWNER_AUTHORIZATION).bind(scope.workspace.id, user.id, sessionHash).first()))
      throw new HttpError(409, "Export authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
    const records = rows.slice(0, spec.pageSize);
    const hasMore = rows.length > spec.pageSize;
    return { format: "veriq-workspace-export-v1", exportedAt: new Date().toISOString(), consistentSnapshot: false, workspace: settings, section, records,
      nextCursor: hasMore ? records[records.length - 1][spec.key] : null,
      nextSection: hasMore ? null : SECTIONS[SECTIONS.indexOf(section as Section) + 1] ?? null };
  }
  if (match[2] === "retention") {
    if (!Number.isInteger(body.retentionDays) || Number(body.retentionDays) < 7 || Number(body.retentionDays) > 365)
      throw new HttpError(400, "Retention must be 7–365 days.");
    const results = await db.batch([
      db.prepare(`UPDATE workspaces SET retention_days=?,retention_enabled=1 WHERE id=? AND deleting=0 AND EXISTS(${OWNER_AUTHORIZATION})`).bind(body.retentionDays, scope.workspace.id, scope.workspace.id, user.id, sessionHash),
      auditStatement(scope, "workspace.retention_changed", scope.workspace.id, { retentionDays: body.retentionDays }),
    ]);
    if (results[0].meta.changes !== 1) throw new HttpError(409, "Workspace authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
    return { ok: true, retentionDays: body.retentionDays };
  }
  if (match[2] === "purge") {
    const results = await db.batch([
      db.prepare(`UPDATE workspaces SET deleting=1 WHERE id=? AND deleting=0 AND EXISTS(${OWNER_AUTHORIZATION})`).bind(scope.workspace.id, scope.workspace.id, user.id, sessionHash),
      ...retentionStatements(db, scope.workspace.id, true),
      db.prepare("INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id,metadata_json) SELECT ?,?,?,'workspace.retention_applied',?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=? AND owner_id=? AND deleting=1)")
        .bind(crypto.randomUUID(), scope.workspace.id, user.id, scope.workspace.id, JSON.stringify({ retentionDays: settings.retention_days }), scope.workspace.id, user.id),
      db.prepare("UPDATE workspaces SET deleting=0 WHERE id=? AND owner_id=? AND deleting=1").bind(scope.workspace.id, user.id),
    ]);
    if (results[0].meta.changes !== 1) throw new HttpError(409, "Workspace authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
    const removed = { chat: results[1].meta.changes, requests: results[2].meta.changes, attachments: results[3].meta.changes,
      feedback: results[4].meta.changes + results[7].meta.changes, reviews: results[6].meta.changes, audit: results[8].meta.changes };
    return { ok: true, removed };
  }
  if (match[2] === "delete") {
    if (body.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm permanent workspace deletion.");
    await deleteLocalMedia(scope, media);
    const results = await db.batch(deletionStatements(scope, sessionHash));
    if (results[0].meta.changes !== 1) throw new HttpError(409, "Workspace authorization changed. Sign in again.", "LIFECYCLE_CONFLICT");
    return { ok: true };
  }
  return null;
}
