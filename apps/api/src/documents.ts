import { InputError, LIMITS, sha256 } from "./pipeline.ts";
import type { ApprovedDocument } from "./pipeline.ts";
import { HttpError, readBody, string, page, nextCursor, like } from "./http.ts";
import {
  ADMINS,
  WRITERS,
  requireRole,
  mutate,
  membershipGuard,
} from "./workspaces.ts";
import type { Scope } from "./workspaces.ts";
export const ACTIVE =
  "status='approved' AND (valid_from IS NULL OR valid_from<=date('now')) AND (valid_until IS NULL OR valid_until>date('now'))";
export interface DocumentRow {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  version: string;
  content: string;
  content_hash: string;
  source_url: string | null;
  status: "draft" | "approved" | "archived";
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  valid_from: string | null;
  valid_until: string | null;
}
export function snapshot(row: DocumentRow): ApprovedDocument {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    content: row.content,
    contentHash: row.content_hash,
    sourceUrl: row.source_url,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}
function date(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new InputError(`${name} must be a real date (YYYY-MM-DD).`);
  return value;
}
function input(body: Record<string, unknown>) {
  const title = string(body.title, "Title", 120),
    version = string(body.version, "Version", 60),
    content = string(body.content, "Document text", LIMITS.document);
  let sourceUrl: string | null = null;
  if (
    body.sourceUrl !== undefined &&
    body.sourceUrl !== null &&
    body.sourceUrl !== ""
  ) {
    try {
      const url = new URL(string(body.sourceUrl, "Source URL", 2000));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      sourceUrl = url.href;
    } catch {
      throw new InputError(
        "Source URL must be an HTTP or HTTPS link without credentials.",
      );
    }
  }
  const validFrom = date(body.validFrom, "Effective date"),
    validUntil = date(body.validUntil, "Expiry date");
  if (validFrom && validUntil && validUntil <= validFrom)
    throw new InputError("Expiry must be after the effective date.");
  return { title, version, content, sourceUrl, validFrom, validUntil };
}
export async function documentRoutes(req: Request, url: URL, scope: Scope) {
  const { db, workspace, user } = scope;
  if (url.pathname === "/api/documents") {
    if (req.method === "GET") {
      const p = page(url);
      let where = "d.workspace_id=?";
      const params: unknown[] = [workspace.id];
      if (p.query) {
        where +=
          " AND (d.title LIKE ? ESCAPE '\\' OR d.version LIKE ? ESCAPE '\\')";
        params.push(like(p.query), like(p.query));
      }
      const status = url.searchParams.get("status");
      if (status) {
        if (!["draft", "approved", "archived"].includes(status))
          throw new InputError("Invalid document status.");
        where += " AND d.status=?";
        params.push(status);
      }
      if (p.cursor) {
        where += " AND (d.created_at<? OR (d.created_at=? AND d.id<?))";
        params.push(p.cursor.time, p.cursor.time, p.cursor.id);
      }
      const rows = (
        await db
          .prepare(
            `SELECT d.id,d.title,d.version,d.user_id,d.status,d.content_hash,d.source_url,d.valid_from,d.valid_until,d.created_at,d.approved_at,d.approved_by,
        u.email AS author_email, substr(d.content,1,160) AS preview,
        CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END AS eligible
        FROM support_documents d JOIN users u ON u.id=d.user_id WHERE ${where} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`,
          )
          .bind(...params, p.limit + 1)
          .all<DocumentRow>()
      ).results;
      return {
        documents: rows.slice(0, p.limit),
        nextCursor: nextCursor(rows, p.limit),
      };
    }
    if (req.method === "POST") {
      requireRole(scope, WRITERS);
      const value = input(await readBody(req));
      const id = crypto.randomUUID();
      const changed = await mutate(
        scope,
        db
          .prepare(
            `INSERT INTO support_documents(id,workspace_id,user_id,title,version,content,content_hash,source_url,valid_from,valid_until)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${membershipGuard()} AND (SELECT COUNT(*) FROM support_documents WHERE workspace_id=?)<500
        AND NOT EXISTS(SELECT 1 FROM support_documents WHERE workspace_id=? AND title=? AND version=?)`,
          )
          .bind(
            id,
            workspace.id,
            user.id,
            value.title,
            value.version,
            value.content,
            await sha256(value.content),
            value.sourceUrl,
            value.validFrom,
            value.validUntil,
            workspace.id,
            user.id,
            workspace.id,
            workspace.id,
            value.title,
            value.version,
          ),
        "document.created",
        id,
        { title: value.title, version: value.version },
      );
      if (!changed)
        throw new HttpError(
          409,
          "That version already exists, permissions changed, or the 500-version workspace limit was reached.",
          "DOCUMENT_CONFLICT",
        );
      return { id, status: "draft" };
    }
  }
  const match = url.pathname.match(
    /^\/api\/documents\/([a-f0-9-]{36})(?:\/(approve|archive))?$/,
  );
  if (!match) return null;
  const row = await db
    .prepare("SELECT * FROM support_documents WHERE id=? AND workspace_id=?")
    .bind(match[1], workspace.id)
    .first<DocumentRow>();
  if (!row) throw new HttpError(404, "Document not found.");
  if (!match[2] && req.method === "GET") return { document: row };
  if (req.method !== "POST" || !match[2]) return null;
  requireRole(scope, ADMINS);
  if (match[2] === "approve") {
    if (row.status !== "draft")
      throw new HttpError(
        409,
        "Only draft versions can be approved.",
        "DOCUMENT_CONFLICT",
      );
    if (workspace.require_two_person && row.user_id === user.id)
      throw new HttpError(
        403,
        "A different administrator must approve this document in a team workspace.",
        "SEPARATE_APPROVER_REQUIRED",
      );
    if (
      row.valid_until &&
      row.valid_until <= new Date().toISOString().slice(0, 10)
    )
      throw new HttpError(
        409,
        "This version has expired. Create a new version.",
        "DOCUMENT_EXPIRED",
      );
    const changed = await mutate(
      scope,
      db
        .prepare(
          `UPDATE support_documents SET status='approved',approved_at=datetime('now'),approved_by=? WHERE id=? AND workspace_id=? AND status='draft' AND (valid_until IS NULL OR valid_until>date('now')) AND (?=0 OR user_id!=?) AND ${membershipGuard(ADMINS)}`,
        )
        .bind(
          user.id,
          row.id,
          workspace.id,
          workspace.require_two_person,
          user.id,
          workspace.id,
          user.id,
        ),
      "document.approved",
      row.id,
      { version: row.version, hash: row.content_hash },
    );
    if (!changed)
      throw new HttpError(
        409,
        "Document or permissions changed. Refresh and retry.",
        "DOCUMENT_CONFLICT",
      );
  } else {
    if (row.status === "archived") return { id: row.id, status: "archived" };
    if (
      !(await mutate(
        scope,
        db
          .prepare(
            `UPDATE support_documents SET status='archived' WHERE id=? AND workspace_id=? AND status!='archived' AND ${membershipGuard(ADMINS)}`,
          )
          .bind(row.id, workspace.id, workspace.id, user.id),
        "document.archived",
        row.id,
        { version: row.version },
      ))
    )
      throw new HttpError(
        409,
        "Document or permissions changed. Refresh and retry.",
      );
  }
  return {
    id: row.id,
    status: match[2] === "approve" ? "approved" : "archived",
  };
}
