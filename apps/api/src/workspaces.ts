import type { User } from "./auth.ts";
import { HttpError, readBody, string, uuid, page, nextCursor } from "./http.ts";
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
        "INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,'owner')",
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
      "SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?",
    )
    .bind(id, user.id)
    .first<Workspace>();
  if (!workspace)
    throw new HttpError(404, "Workspace not found.", "WORKSPACE_UNAVAILABLE");
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
  return `EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=? AND m.user_id=? AND m.role IN (${roles.map((r) => `'${r}'`).join(",")}))`;
}
export async function workspaceRoutes(
  req: Request,
  url: URL,
  db: D1Database,
  user: User,
) {
  if (url.pathname === "/api/workspaces") {
    await ensurePersonal(db, user);
    if (req.method === "GET")
      return {
        workspaces: (
          await db
            .prepare(
              "SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.is_personal DESC,w.created_at,w.id",
            )
            .bind(user.id)
            .all<Workspace>()
        ).results,
      };
    if (req.method === "POST") {
      const name = string((await readBody(req)).name, "Workspace name", 100);
      const id = crypto.randomUUID();
      // Both workspace creation and owner membership are atomic and capacity-bound.
      await db.batch([
        db
          .prepare(
            "INSERT INTO workspaces(id,name,owner_id) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM workspaces WHERE owner_id=? AND is_personal=0)<10",
          )
          .bind(id, name, user.id, user.id),
        db
          .prepare(
            "INSERT INTO workspace_members(workspace_id,user_id,role) SELECT ?,?,'owner' WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
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
          "You can own up to 10 team workspaces.",
          "WORKSPACE_LIMIT",
        );
      return { id };
    }
  }
  const match = url.pathname.match(
    /^\/api\/workspaces\/([a-f0-9-]{36})\/(members|audit|overview)(?:\/([a-f0-9-]{36}))?$/,
  );
  if (!match) return null;
  const scope = await resolveScope(db, user, match[1]);
  if (match[2] === "overview" && req.method === "GET") {
    const counts = await db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND status='approved' AND (valid_from IS NULL OR valid_from<=date('now')) AND (valid_until IS NULL OR valid_until>date('now'))) AS activeDocuments,
      (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND status='draft') AS draftDocuments,
      (SELECT COUNT(*) FROM support_reviews WHERE workspace_id=? AND decision='pending') AS pendingReviews,
      (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?) AS members`,
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
            "SELECT m.user_id,m.role,m.created_at,u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role,u.email",
          )
          .bind(scope.workspace.id)
          .all()
      ).results,
    };
  if (req.method !== "POST") return null;
  if (scope.workspace.is_personal)
    throw new HttpError(
      409,
      "Create a team workspace to add members.",
      "PERSONAL_WORKSPACE",
    );
  const body = await readBody(req);
  if (!match[3]) {
    const email = string(body.email, "Member email", 254).toLowerCase();
    if (!["admin", "reviewer", "viewer"].includes(String(body.role)))
      throw new HttpError(400, "Choose admin, reviewer or viewer.");
    if (body.role === "admin" && scope.workspace.role !== "owner")
      throw new HttpError(
        403,
        "Only the owner can appoint administrators.",
        "ROLE_FORBIDDEN",
      );
    const target = await db
      .prepare("SELECT id FROM users WHERE email=?")
      .bind(email)
      .first<{ id: string }>();
    if (!target)
      throw new HttpError(
        404,
        "That account is not registered. Ask your teammate to create an account first.",
        "ACCOUNT_NOT_FOUND",
      );
    const exists = await db
      .prepare(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
      )
      .bind(scope.workspace.id, target.id)
      .first();
    if (exists)
      throw new HttpError(
        409,
        "This account is already a member.",
        "MEMBER_EXISTS",
      );
    const changed = await mutate(
      scope,
      db
        .prepare(
          `INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role) SELECT ?,?,? WHERE ${membershipGuard(body.role === "admin" ? ["owner"] : ADMINS)}`,
        )
        .bind(
          scope.workspace.id,
          target.id,
          body.role,
          scope.workspace.id,
          user.id,
        ),
      "member.added",
      target.id,
      { role: body.role },
    );
    if (!changed)
      throw new HttpError(
        409,
        "Your permissions changed. Refresh the workspace.",
      );
    return { ok: true };
  }
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
          `UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=? AND role=? AND ${membershipGuard(scope.workspace.role === "owner" ? ["owner"] : ADMINS)}`,
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
    ))
  )
    throw new HttpError(409, "Membership changed. Refresh and retry.");
  return { ok: true };
}
