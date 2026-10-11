import type { User } from "./auth.ts";
import { HttpError, readBody, string, uuid, page, nextCursor } from "./http.ts";
import { newSecret, sha256hex, isSecret, requestSessionHash } from "./auth.ts";
import { requireMfa } from "./mfa.ts";
export type Role = "owner" | "admin" | "reviewer" | "viewer";
export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  is_personal: number;
  require_two_person: number;
  role: Role;
  created_at: string;
}
export interface Scope {
  db: D1Database;
  user: User;
  workspace: Workspace;
}
export const WRITERS: Role[] = ["owner", "admin", "reviewer"];
export const ADMINS: Role[] = ["owner", "admin"];
export function requireRole(scope: Scope, roles: Role[]) {
  if (!roles.includes(scope.workspace.role))
    throw new HttpError(
      403,
      "Your workspace role does not allow this action.",
      "ROLE_FORBIDDEN",
    );
}
export async function ensurePersonal(db: D1Database, user: User) {
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,owner_id,is_personal,require_two_person) VALUES(?,'Personal workspace',?,1,0)",
      )
      .bind(user.id, user.id),
    db
      .prepare(
        "INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,admitted_at) VALUES(?,?,'owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      )
      .bind(user.id, user.id),
  ]);
}
export async function resolveScope(
  db: D1Database,
  user: User,
  workspaceId: string | null,
): Promise<Scope> {
  await ensurePersonal(db, user);
  const id = workspaceId ?? user.id;
  if (!uuid(id)) throw new HttpError(400, "Invalid workspace ID.");
  const workspace = await db
    .prepare(
      "SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=? AND m.admitted_at IS NOT NULL AND w.deleting=0",
    )
    .bind(id, user.id)
    .first<Workspace>();
  if (!workspace)
    throw new HttpError(404, "Workspace not found.", "WORKSPACE_UNAVAILABLE");
  if (!workspace.is_personal) requireMfa(user);
  return { db, user, workspace };
}
export function auditStatement(
  scope: Scope,
  action: string,
  objectId: string,
  metadata: unknown = {},
  conditional = true,
) {
  return scope.db
    .prepare(
      `INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id,metadata_json) SELECT ?,?,?,?,?,? ${conditional ? "WHERE changes()=1" : ""}`,
    )
    .bind(
      crypto.randomUUID(),
      scope.workspace.id,
      scope.user.id,
      action,
      objectId,
      JSON.stringify(metadata),
    );
}
/** Mutation and audit event commit together; failed/stale mutations leave no audit event. */
export async function mutate(
  scope: Scope,
  mutation: D1PreparedStatement,
  action: string,
  objectId: string,
  metadata: unknown = {},
  extra: D1PreparedStatement[] = [],
): Promise<boolean> {
  const results = await scope.db.batch([
    mutation,
    auditStatement(scope, action, objectId, metadata),
    ...extra,
  ]);
  return results[0].meta.changes === 1;
}
export function membershipGuard(roles: Role[] = WRITERS): string {
  return `EXISTS(SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND m.admitted_at IS NOT NULL AND w.deleting=0 AND u.disabled=0 AND (w.is_personal=1 OR u.mfa_seed IS NOT NULL) AND m.role IN (${roles.map((r) => `'${r}'`).join(",")}))`;
}
export async function workspaceRoutes(
  req: Request,
  url: URL,
  db: D1Database,
  user: User,
) {
  if (url.pathname === "/api/invitations/accept" && req.method === "POST")
    return acceptInvitation(req, db, user);
  if (url.pathname === "/api/workspaces") {
    await ensurePersonal(db, user);
    if (req.method === "GET")
      return {
        workspaces: (
          await db
            .prepare(
              "SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? AND m.admitted_at IS NOT NULL AND w.deleting=0 ORDER BY w.is_personal DESC,w.created_at,w.id",
            )
            .bind(user.id)
            .all<Workspace>()
        ).results,
      };
    if (req.method === "POST") {
      requireMfa(user);
      const name = string((await readBody(req)).name, "Workspace name", 100);
      const id = crypto.randomUUID();
      const sessionHash = (await requestSessionHash(req)) ?? "";
      // Both workspace creation and owner membership are atomic and capacity-bound.
      await db.batch([
        db
          .prepare(
            "INSERT INTO workspaces(id,name,owner_id) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM workspaces WHERE owner_id=? AND is_personal=0)<10 AND EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.disabled=0 AND u.mfa_seed IS NOT NULL AND s.token_hash=? AND s.mfa_verified=1 AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          )
          .bind(id, name, user.id, user.id, user.id, sessionHash),
        db
          .prepare(
            "INSERT INTO workspace_members(workspace_id,user_id,role,admitted_at) SELECT ?,?,'owner',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
          )
          .bind(id, user.id, id),
        db
          .prepare(
            "INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id) SELECT ?,?,?,'workspace.created',? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
          )
          .bind(crypto.randomUUID(), id, user.id, id, id),
      ]);
      const result = await db
        .prepare("SELECT * FROM workspaces WHERE id=?")
        .bind(id)
        .first();
      if (!result)
        throw new HttpError(
          409,
          "The 10-team ownership limit was reached or your verified session changed. Refresh and sign in again.",
          "WORKSPACE_LIMIT",
        );
      return { id };
    }
  }
  const match = url.pathname.match(
    /^\/api\/workspaces\/([a-f0-9-]{36})\/(members|audit|overview|invitations)(?:\/([a-f0-9-]{36})(?:\/(revoke))?)?$/,
  );
  if (!match) return null;
  const scope = await resolveScope(db, user, match[1]);
  if (match[4] && match[2] !== "invitations") return null;
  if (match[2] === "invitations") return invitationRoutes(req, scope, match[3], match[4]);
  if (match[2] === "overview" && req.method === "GET") {
    const counts = await db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND status='approved' AND (valid_from IS NULL OR valid_from<=date('now')) AND (valid_until IS NULL OR valid_until>date('now'))) AS activeDocuments,
      (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND status='draft') AS draftDocuments,
      (SELECT COUNT(*) FROM support_reviews WHERE workspace_id=? AND decision='pending') AS pendingReviews,
      (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=? AND admitted_at IS NOT NULL) AS members`,
      )
      .bind(
        scope.workspace.id,
        scope.workspace.id,
        scope.workspace.id,
        scope.workspace.id,
      )
      .first();
    return { counts };
  }
  if (match[2] === "audit" && req.method === "GET") {
    requireRole(scope, ADMINS);
    const p = page(url);
    const params: unknown[] = [scope.workspace.id];
    let where = "a.workspace_id=?";
    if (p.cursor) {
      where += " AND (a.created_at<? OR (a.created_at=? AND a.id<?))";
      params.push(p.cursor.time, p.cursor.time, p.cursor.id);
    }
    const rows = (
      await db
        .prepare(
          `SELECT a.*,u.email AS actor_email FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
        )
        .bind(...params, p.limit + 1)
        .all<{ id: string; created_at: string }>()
    ).results;
    return {
      events: rows.slice(0, p.limit),
      nextCursor: nextCursor(rows, p.limit),
    };
  }
  if (match[2] !== "members") return null;
  requireRole(scope, ADMINS);
  if (req.method === "GET" && !match[3])
    return {
      members: (
        await db
          .prepare(
            "SELECT m.user_id,m.role,m.admitted_at,m.created_at,u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role,u.email",
          )
          .bind(scope.workspace.id)
          .all()
      ).results,
    };
  if (req.method !== "POST") return null;
  if (!match[3])
    throw new HttpError(410, "Email-based member grants are retired. Issue an account-bound invitation instead.", "MEMBER_CREATE_RETIRED");
  requireMfa(user);
  if (scope.workspace.is_personal)
    throw new HttpError(
      409,
      "Create a team workspace to add members.",
      "PERSONAL_WORKSPACE",
    );
  const body = await readBody(req);
  const target = await db
    .prepare(
      "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
    )
    .bind(scope.workspace.id, match[3])
    .first<{ role: Role }>();
  if (!target) throw new HttpError(404, "Member not found.");
  if (target.role === "owner" || match[3] === user.id)
    throw new HttpError(
      409,
      "The owner and your own membership cannot be changed here.",
      "OWNER_PROTECTED",
    );
  if (
    scope.workspace.role !== "owner" &&
    (target.role === "admin" || body.role === "admin")
  )
    throw new HttpError(
      403,
      "Only the owner can change administrator memberships.",
      "ROLE_FORBIDDEN",
    );
  const remove = body.remove === true;
  if (!remove && !["admin", "reviewer", "viewer"].includes(String(body.role)))
    throw new HttpError(400, "Choose admin, reviewer or viewer.");
  const mutation = remove
    ? db
        .prepare(
          `DELETE FROM workspace_members WHERE workspace_id=? AND user_id=? AND role=? AND ${membershipGuard(scope.workspace.role === "owner" ? ["owner"] : ADMINS)}`,
        )
        .bind(
          scope.workspace.id,
          match[3],
          target.role,
          scope.workspace.id,
          user.id,
        )
    : db
        .prepare(
          `UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=? AND role=? AND admitted_at IS NOT NULL AND ${membershipGuard(scope.workspace.role === "owner" ? ["owner"] : ADMINS)}`,
        )
        .bind(
          body.role,
          scope.workspace.id,
          match[3],
          target.role,
          scope.workspace.id,
          user.id,
        );
  if (
    !(await mutate(
      scope,
      mutation,
      remove ? "member.removed" : "member.role_changed",
      match[3],
      remove ? {} : { role: body.role },
      [
        db.prepare(`UPDATE workspace_invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND (recipient_id=? OR created_by=?) AND ${LIVE_INVITATION} AND changes()=1`)
          .bind(scope.workspace.id, match[3], match[3]),
      ],
    ))
  )
    throw new HttpError(409, "Membership changed. Refresh and retry.");
  return { ok: true };
}

const INVITE_TTL_SECONDS = 48 * 3600;
const MAX_WORKSPACE_SEATS = 50;
const LIVE_INVITATION = "consumed_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function invitationRoutes(req: Request, scope: Scope, invitationId?: string, action?: string) {
  const { db, workspace, user } = scope;
  requireRole(scope, ADMINS);
  if (workspace.is_personal)
    throw new HttpError(409, "Create a team workspace to invite members.", "PERSONAL_WORKSPACE");
  if (req.method === "GET" && !invitationId) {
    const invitations = (await db.prepare(`SELECT id,workspace_id AS workspaceId,role,recipient_id AS recipientAccountId,recipient_label AS recipientLabel,created_at AS createdAt,expires_at AS expiresAt FROM workspace_invitations WHERE workspace_id=? AND ${LIVE_INVITATION} ORDER BY created_at,id`)
      .bind(workspace.id).all()).results;
    return { invitations };
  }
  if (req.method !== "POST") return null;
  requireMfa(user);
  if (invitationId && action === "revoke") {
    const invitation = await db.prepare("SELECT role FROM workspace_invitations WHERE id=? AND workspace_id=?").bind(invitationId, workspace.id).first<{ role: Role }>();
    const roles: Role[] = invitation?.role === "admin" ? ["owner"] : ADMINS;
    requireRole(scope, roles);
    const changed = await mutate(scope, db.prepare(`UPDATE workspace_invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND ${LIVE_INVITATION} AND ${membershipGuard(roles)}`)
      .bind(invitationId, workspace.id, workspace.id, user.id), "invitation.revoked", invitationId);
    if (!changed) throw new HttpError(409, "This invitation is no longer active.", "INVITATION_INACTIVE");
    return { ok: true };
  }
  if (invitationId) return null;
  const body = await readBody(req);
  const recipientLabel = string(body.recipientLabel, "Recipient label", 120);
  if (!uuid(body.recipientAccountId)) throw new HttpError(400, "Enter the recipient's exact account ID from their signed-in account.");
  const recipientId = body.recipientAccountId;
  if (recipientId === user.id)
    throw new HttpError(409, "An invitation must be bound to a different account; self-invitations are not allowed.", "SELF_INVITATION");
  if (!["admin", "reviewer", "viewer"].includes(String(body.role)))
    throw new HttpError(400, "Choose admin, reviewer or viewer.");
  const role = body.role as "admin" | "reviewer" | "viewer";
  const roles: Role[] = role === "admin" ? ["owner"] : ADMINS;
  requireRole(scope, roles);
  const recipient = await db.prepare("SELECT id,mfa_seed IS NOT NULL AS enrolled FROM users WHERE id=? AND disabled=0").bind(recipientId).first<{ id: string; enrolled: number }>();
  if (!recipient) throw new HttpError(404, "That account is unavailable. Ask the recipient for their account ID through your independently verified channel.", "ACCOUNT_NOT_FOUND");
  const member = await db.prepare("SELECT role,admitted_at FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace.id, recipientId).first<{ role: Role; admitted_at: string | null }>();
  if (member?.admitted_at || member?.role === "owner")
    throw new HttpError(409, "That account is already admitted.", "MEMBER_EXISTS");
  if (!recipient.enrolled)
    throw new HttpError(403, "The recipient must enable two-factor authentication before team admission.", "MFA_REQUIRED");
  if (await db.prepare(`SELECT 1 FROM workspace_invitations WHERE workspace_id=? AND recipient_id=? AND ${LIVE_INVITATION}`).bind(workspace.id, recipientId).first())
    throw new HttpError(409, "That account already has an active invitation. Revoke it before issuing another.", "INVITATION_PENDING");
  const seats = await db.prepare(`SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=? AND admitted_at IS NOT NULL)+(SELECT COUNT(*) FROM workspace_invitations WHERE workspace_id=? AND ${LIVE_INVITATION}) AS n`).bind(workspace.id, workspace.id).first<{ n: number }>();
  if (seats && seats.n >= MAX_WORKSPACE_SEATS)
    throw new HttpError(409, "This workspace has reached its 50-member and active-invitation allowance.", "SEAT_LIMIT");
  const id = crypto.randomUUID();
  const token = newSecret();
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();
  const changed = await mutate(scope, db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,token_hash,role,recipient_id,recipient_label,created_by,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${membershipGuard(roles)}
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0 AND mfa_seed IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND (admitted_at IS NOT NULL OR role='owner'))
    AND NOT EXISTS(SELECT 1 FROM workspace_invitations WHERE workspace_id=? AND recipient_id=? AND ${LIVE_INVITATION})
    AND ((SELECT COUNT(*) FROM workspace_members WHERE workspace_id=? AND admitted_at IS NOT NULL)+(SELECT COUNT(*) FROM workspace_invitations WHERE workspace_id=? AND ${LIVE_INVITATION}))<?`)
    .bind(id, workspace.id, await sha256hex(token), role, recipientId, recipientLabel, user.id, expiresAt,
      workspace.id, user.id, recipientId, workspace.id, recipientId, workspace.id, recipientId, workspace.id, workspace.id, MAX_WORKSPACE_SEATS),
    "invitation.created", id, { role, recipientAccountId: recipientId });
  if (!changed) throw new HttpError(409, "Permissions, recipient eligibility or invitation capacity changed. Refresh the workspace.", "INVITATION_CONFLICT");
  return { invitation: { id, workspaceId: workspace.id, recipientAccountId: recipientId, role, expiresAt, recipientLabel }, token };
}

async function acceptInvitation(req: Request, db: D1Database, user: User) {
  requireMfa(user);
  const body = await readBody(req);
  const invalid = () => new HttpError(409, "This invitation is unavailable for this account. Ask the inviter for a new account-bound invitation.", "INVITATION_INVALID");
  if (!isSecret(body.token)) throw invalid();
  const invitation = await db.prepare("SELECT id,workspace_id,role FROM workspace_invitations WHERE token_hash=? AND recipient_id=?")
    .bind(await sha256hex(body.token), user.id).first<{ id: string; workspace_id: string; role: Role }>();
  if (!invitation) throw invalid();
  const sessionHash = (await requestSessionHash(req)) ?? "";
  const results = await db.batch([
    db.prepare(`UPDATE workspace_invitations SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),consumed_by=?
      WHERE id=? AND recipient_id=? AND ${LIVE_INVITATION}
      AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_invitations.workspace_id AND w.deleting=0 AND w.is_personal=0)
      AND EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=workspace_invitations.recipient_id AND u.disabled=0 AND u.mfa_seed IS NOT NULL AND s.token_hash=? AND s.mfa_verified=1 AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND EXISTS(SELECT 1 FROM workspace_members issuer JOIN users u ON u.id=issuer.user_id WHERE issuer.workspace_id=workspace_invitations.workspace_id AND issuer.user_id=workspace_invitations.created_by AND issuer.admitted_at IS NOT NULL AND issuer.role IN ('owner','admin') AND (workspace_invitations.role!='admin' OR issuer.role='owner') AND u.disabled=0 AND u.mfa_seed IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=workspace_invitations.workspace_id AND m.user_id=workspace_invitations.recipient_id AND (m.admitted_at IS NOT NULL OR m.role='owner'))`)
      .bind(user.id, invitation.id, user.id, sessionHash),
    db.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,admitted_at)
      SELECT ?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,admitted_at=excluded.admitted_at WHERE workspace_members.admitted_at IS NULL AND workspace_members.role<>'owner'`)
      .bind(invitation.workspace_id, user.id, invitation.role),
    db.prepare("INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id,metadata_json) SELECT ?,?,?,'invitation.accepted',?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), invitation.workspace_id, user.id, invitation.id, JSON.stringify({ role: invitation.role })),
  ]);
  if (results[0].meta.changes !== 1) throw invalid();
  return { workspaceId: invitation.workspace_id, role: invitation.role };
}
