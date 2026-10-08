import {
  InputError,
  LIMITS,
  reviewDraft,
  sha256,
  splitStatements,
} from "./pipeline.ts";
import type { AIClient, Review } from "./pipeline.ts";
import {
  HttpError,
  readBody,
  string,
  uuid,
  page,
  nextCursor,
  like,
} from "./http.ts";
import { WRITERS, requireRole, mutate, membershipGuard } from "./workspaces.ts";
import type { Scope } from "./workspaces.ts";
import { ACTIVE, snapshot } from "./documents.ts";
import type { DocumentRow } from "./documents.ts";
import { attachments } from "./evidence.ts";
interface ReviewRow {
  id: string;
  draft_text: string;
  review_json: string;
  status: string;
  decision: string;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  revision: number;
  created_at: string;
  user_id: string;
}
async function record(row: ReviewRow, db: D1Database, workspaceId: string) {
  const review = JSON.parse(row.review_json) as Review;
  const ids = review.documents.map((d) => d.id);
  const active = ids.length
    ? await db
        .prepare(
          `SELECT COUNT(*) AS n FROM support_documents WHERE workspace_id=? AND ${ACTIVE} AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(workspaceId, ...ids)
        .first<{ n: number }>()
    : null;
  return {
    attachments: await attachments(db, workspaceId, row.id),
    policiesCurrent: !!active && active.n === ids.length,
    ...{
      id: row.id,
      draft: row.draft_text,
      review: JSON.parse(row.review_json),
      status: row.status,
      decision: row.decision,
      decisionNote: row.decision_note,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      revision: row.revision,
      created_at: row.created_at,
      authorId: row.user_id,
    },
  };
}
async function quota(db: D1Database, userId: string) {
  return !!(await db
    .prepare(
      "INSERT INTO usage(ip,day,count) VALUES(?,?,1) ON CONFLICT(ip,day) DO UPDATE SET count=count+1 WHERE count<50 RETURNING count",
    )
    .bind(`support:${userId}`, new Date().toISOString().slice(0, 10))
    .first());
}
export async function reviewRoutes(
  req: Request,
  url: URL,
  scope: Scope,
  ai: AIClient,
) {
  const { db, workspace, user } = scope;
  if (url.pathname === "/api/reviews" && req.method === "GET") {
    const p = page(url);
    let where = "r.workspace_id=?";
    const params: unknown[] = [workspace.id];
    if (p.query) {
      where += " AND r.draft_text LIKE ? ESCAPE '\\'";
      params.push(like(p.query));
    }
    const decision = url.searchParams.get("decision");
    if (decision) {
      if (!["pending", "approved", "rejected"].includes(decision))
        throw new InputError("Invalid decision filter.");
      where += " AND r.decision=?";
      params.push(decision);
    }
    if (p.cursor) {
      where += " AND (r.created_at<? OR (r.created_at=? AND r.id<?))";
      params.push(p.cursor.time, p.cursor.time, p.cursor.id);
    }
    const rows = (
      await db
        .prepare(
          `SELECT r.id,substr(r.draft_text,1,120) AS preview,r.status,r.decision,r.revision,r.created_at,u.email AS author_email FROM support_reviews r JOIN users u ON u.id=r.user_id WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
        )
        .bind(...params, p.limit + 1)
        .all<{ id: string; created_at: string }>()
    ).results;
    return {
      reviews: rows.slice(0, p.limit),
      nextCursor: nextCursor(rows, p.limit),
    };
  }
  if (url.pathname === "/api/reviews" && req.method === "POST") {
    requireRole(scope, WRITERS);
    const body = await readBody(req);
    if (typeof body.draft !== "string")
      throw new InputError("A draft string is required.");
    splitStatements(body.draft);
    if (
      !Array.isArray(body.documentIds) ||
      !body.documentIds.length ||
      body.documentIds.length > LIMITS.documents ||
      !body.documentIds.every(uuid) ||
      new Set(body.documentIds).size !== body.documentIds.length
    )
      throw new InputError(
        `Select 1–${LIMITS.documents} distinct approved document IDs.`,
      );
    const ids = [...(body.documentIds as string[])].sort();
    const marks = ids.map(() => "?").join(",");
    await db
      .prepare(
        "DELETE FROM review_requests WHERE expires_at<? AND state!='running'",
      )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const key = req.headers.get("idempotency-key");
    if (key && !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new InputError(
        "Idempotency-Key must be 16–128 letters, digits, hyphens or underscores.",
      );
    const operationKey = key ?? crypto.randomUUID();
    const requestHash = await sha256(
      JSON.stringify({ draft: body.draft, ids, engine: "support-v2" }),
    );
    const existing = await db
      .prepare(
        "SELECT * FROM review_requests WHERE workspace_id=? AND user_id=? AND key=?",
      )
      .bind(workspace.id, user.id, operationKey)
      .first<{
        request_hash: string;
        state: string;
        review_id: string | null;
        expires_at: number;
      }>();
    if (existing && existing.request_hash !== requestHash)
      throw new HttpError(
        409,
        "This retry key was already used for a different draft or policy set.",
        "IDEMPOTENCY_CONFLICT",
      );
    if (existing?.state === "completed") {
      const row = await db
        .prepare("SELECT * FROM support_reviews WHERE id=? AND workspace_id=?")
        .bind(existing.review_id, workspace.id)
        .first<ReviewRow>();
      if (row)
        return { ...(await record(row, db, workspace.id)), replayed: true };
    }
    const query = `SELECT * FROM support_documents WHERE workspace_id=? AND ${ACTIVE} AND id IN (${marks}) ORDER BY id`;
    const rows = (
      await db
        .prepare(query)
        .bind(workspace.id, ...ids)
        .all<DocumentRow>()
    ).results;
    if (rows.length !== ids.length)
      throw new HttpError(
        400,
        "Selected documents are unavailable, expired, scheduled or not approved in this workspace.",
        "DOCUMENTS_UNAVAILABLE",
      );
    const documents = rows.map(snapshot);
    if (documents.reduce((n, d) => n + d.content.length, 0) > LIMITS.corpus)
      throw new InputError(
        "Selected documents exceed the review budget. Select a smaller policy set.",
      );
    const now = Math.floor(Date.now() / 1000),
      lease = crypto.randomUUID();
    // A lease fences late workers. Only one attempt for a retry key can save a review.
    const claim = await db
      .prepare(
        `INSERT INTO review_requests(workspace_id,user_id,key,request_hash,lease,state,expires_at) VALUES(?,?,?,?,?,'running',?)
      ON CONFLICT(workspace_id,user_id,key) DO UPDATE SET lease=excluded.lease,state='running',expires_at=excluded.expires_at
      WHERE request_hash=excluded.request_hash AND (state='failed' OR (state='running' AND expires_at<?)) RETURNING lease`,
      )
      .bind(
        workspace.id,
        user.id,
        operationKey,
        requestHash,
        lease,
        now + 120,
        now,
      )
      .first();
    if (!claim)
      throw new HttpError(
        409,
        "This review is already running. Wait briefly, then retry with the same key.",
        "REVIEW_IN_PROGRESS",
      );
    try {
      if (!(await quota(db, user.id)))
        throw new HttpError(
          429,
          "Daily review limit reached.",
          "QUOTA_EXCEEDED",
        );
      const review = await reviewDraft(body.draft, documents, ai);
      const id = crypto.randomUUID();
      const inserted = await mutate(
        scope,
        db
          .prepare(
            `INSERT INTO support_reviews(id,user_id,workspace_id,draft_text,review_json,status)
        SELECT ?,?,?,?,?,? WHERE ${membershipGuard()} AND (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND ${ACTIVE} AND id IN (${marks}))=?
        AND EXISTS(SELECT 1 FROM review_requests WHERE workspace_id=? AND user_id=? AND key=? AND lease=? AND state='running')`,
          )
          .bind(
            id,
            user.id,
            workspace.id,
            body.draft,
            JSON.stringify(review),
            review.status,
            workspace.id,
            user.id,
            workspace.id,
            ...ids,
            ids.length,
            workspace.id,
            user.id,
            operationKey,
            lease,
          ),
        "review.created",
        id,
        { status: review.status, documentIds: ids },
        [
          db
            .prepare(
              "UPDATE review_requests SET state='completed',review_id=?,expires_at=? WHERE workspace_id=? AND user_id=? AND key=? AND lease=? AND EXISTS(SELECT 1 FROM support_reviews WHERE id=?)",
            )
            .bind(
              id,
              Math.floor(Date.now() / 1000) + 86400,
              workspace.id,
              user.id,
              operationKey,
              lease,
              id,
            ),
        ],
      );
      if (!inserted)
        throw new HttpError(
          409,
          "Policies or permissions changed during review. Refresh and retry.",
          "REVIEW_STALE",
        );
      return { id, review, decision: "pending", revision: 0, replayed: false };
    } catch (error) {
      await db
        .prepare(
          "UPDATE review_requests SET state='failed' WHERE workspace_id=? AND user_id=? AND key=? AND lease=? AND state='running'",
        )
        .bind(workspace.id, user.id, operationKey, lease)
        .run();
      throw error;
    }
  }
  const match = url.pathname.match(
    /^\/api\/reviews\/([a-f0-9-]{36})(?:\/(decision|export))?$/,
  );
  if (!match) return null;
  const row = await db
    .prepare("SELECT * FROM support_reviews WHERE id=? AND workspace_id=?")
    .bind(match[1], workspace.id)
    .first<ReviewRow>();
  if (!row) throw new HttpError(404, "Review not found.");
  if (req.method === "GET" && !match[2]) return record(row, db, workspace.id);
  if (req.method === "GET" && match[2] === "export")
    return record(row, db, workspace.id);
  if (req.method !== "POST" || match[2] !== "decision") return null;
  requireRole(scope, WRITERS);
  const body = await readBody(req);
  if (body.decision !== "approved" && body.decision !== "rejected")
    throw new InputError("Choose approved or rejected.");
  const note = string(body.note, "Decision note", 2000, 5);
  if (
    !Number.isInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    throw new InputError("A nonnegative expectedRevision is required.");
  const result = JSON.parse(row.review_json) as Review;
  const documentIds = result.documents.map((d) => d.id),
    marks = documentIds.map(() => "?").join(",");
  if (body.decision === "approved" && row.status !== "ready_for_review")
    throw new HttpError(
      409,
      "Resolve missing or conflicting evidence in a new review before approving.",
      "REVIEW_NOT_READY",
    );
  const eligibility =
    body.decision === "approved"
      ? `AND (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND ${ACTIVE} AND id IN (${marks}))=?`
      : "";
  const bindings: unknown[] = [
    body.decision,
    note,
    user.id,
    row.id,
    workspace.id,
    body.expectedRevision,
    workspace.id,
    user.id,
  ];
  if (body.decision === "approved")
    bindings.push(workspace.id, ...documentIds, documentIds.length);
  const changed = await mutate(
    scope,
    db
      .prepare(
        `UPDATE support_reviews SET decision=?,decision_note=?,decided_by=?,decided_at=datetime('now'),revision=revision+1
    WHERE id=? AND workspace_id=? AND revision=? AND ${membershipGuard()} ${eligibility}`,
      )
      .bind(...bindings),
    `review.${body.decision}`,
    row.id,
    { note, revision: Number(body.expectedRevision) + 1 },
  );
  if (!changed)
    throw new HttpError(
      409,
      "The review, policies or permissions changed. Refresh before deciding.",
      "DECISION_CONFLICT",
    );
  return {
    ok: true,
    decision: body.decision,
    revision: Number(body.expectedRevision) + 1,
  };
}
