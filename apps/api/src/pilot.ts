import { HttpError, readBody, string, uuid, page, nextCursor } from "./http.ts";
import { ADMINS, requireRole, mutate, membershipGuard } from "./workspaces.ts";
import type { Scope, Role } from "./workspaces.ts";
import { sha256 } from "./pipeline.ts";
const MEMBERS: Role[] = ["owner", "admin", "reviewer", "viewer"];
const SAMPLE = {
  title: "[Sample] Export and refund policy",
  version: "demo-v1",
  content:
    "Fictional demo company policy. Starter plans include 100 exports per month. Unlimited exports are available on the Enterprise plan. Refund requests must be submitted within 30 days of purchase. Refunds are available only for unused subscriptions. This sample policy does not establish customer account facts or actions.",
};
const scenarios = [
  {
    id: "supported",
    label: "Documented policy",
    draft: "Refund requests must be submitted within 30 days of purchase.",
    expectation:
      "Look for an exact quote supporting the submission deadline. A person still decides whether to send.",
  },
  {
    id: "contradiction",
    label: "Wrong plan benefit",
    draft: "All plans include unlimited exports.",
    expectation: "Look for the Starter plan limit contradicting this reply.",
  },
  {
    id: "missing",
    label: "Unsupported account promise",
    draft: "I have issued your refund and the money will arrive tomorrow.",
    expectation:
      "The policy cannot establish a customer action or arrival date. This needs account evidence.",
  },
];
export async function pilotRoutes(req: Request, url: URL, scope: Scope) {
  const { db, workspace, user } = scope;
  if (url.pathname === "/api/demo" && req.method === "GET")
    return { scenarios, samplePolicy: SAMPLE };
  if (url.pathname === "/api/demo/setup" && req.method === "POST") {
    requireRole(scope, ["owner"]);
    if (!workspace.is_personal)
      throw new HttpError(
        409,
        "Use your personal workspace for fictional sample policies. Company workspaces keep two-person approval.",
        "DEMO_PERSONAL_ONLY",
      );
    if ((await readBody(req)).confirmSamplePolicies !== true)
      throw new HttpError(
        400,
        "Explicitly confirm the fictional sample policy setup.",
      );
    const hash = await sha256(SAMPLE.content);
    let existing = await db
      .prepare(
        "SELECT id,status,content_hash FROM support_documents WHERE workspace_id=? AND title=? AND version=?",
      )
      .bind(workspace.id, SAMPLE.title, SAMPLE.version)
      .first<{ id: string; status: string; content_hash: string }>();
    if (!existing) {
      const id = crypto.randomUUID();
      await mutate(
        scope,
        db
          .prepare(
            `INSERT OR IGNORE INTO support_documents(id,workspace_id,user_id,title,version,content,content_hash,status,approved_by,approved_at) SELECT ?,?,?,?,?,?,?,'approved',?,datetime('now') WHERE ${membershipGuard(["owner"])} AND (SELECT COUNT(*) FROM support_documents WHERE workspace_id=?)<500`,
          )
          .bind(
            id,
            workspace.id,
            user.id,
            SAMPLE.title,
            SAMPLE.version,
            SAMPLE.content,
            hash,
            user.id,
            workspace.id,
            user.id,
            workspace.id,
          ),
        "document.sample_approved",
        id,
        { title: SAMPLE.title, version: SAMPLE.version, hash },
      );
      existing = await db
        .prepare(
          "SELECT id,status,content_hash FROM support_documents WHERE workspace_id=? AND title=? AND version=?",
        )
        .bind(workspace.id, SAMPLE.title, SAMPLE.version)
        .first<{ id: string; status: string; content_hash: string }>();
    }
    if (
      !existing ||
      existing.status !== "approved" ||
      existing.content_hash !== hash
    )
      throw new HttpError(
        409,
        "The sample version is archived, changed, or the document limit was reached. Use your own approved policy instead.",
        "DEMO_UNAVAILABLE",
      );
    return { documentIds: [existing.id], scenarios };
  }
  if (url.pathname === "/api/feedback" && req.method === "POST") {
    const body = await readBody(req),
      note = string(body.note, "Feedback", 2000, 10);
    if (
      !Number.isInteger(body.rating) ||
      Number(body.rating) < 1 ||
      Number(body.rating) > 5
    )
      throw new HttpError(400, "Choose a usefulness rating from 1 to 5.");
    if (
      !["usability", "evidence", "policy_gap", "other"].includes(
        String(body.kind),
      )
    )
      throw new HttpError(400, "Choose a feedback category.");
    const reviewId = body.reviewId ?? null;
    if (
      reviewId !== null &&
      (!uuid(reviewId) ||
        !(await db
          .prepare(
            "SELECT id FROM support_reviews WHERE id=? AND workspace_id=?",
          )
          .bind(reviewId, workspace.id)
          .first()))
    )
      throw new HttpError(404, "Review not found in this workspace.");
    const id = crypto.randomUUID();
    const changed = await mutate(
      scope,
      db
        .prepare(
          `INSERT INTO pilot_feedback(id,workspace_id,user_id,review_id,rating,kind,note) SELECT ?,?,?,?,?,?,? WHERE ${membershipGuard(MEMBERS)} AND (SELECT COUNT(*) FROM pilot_feedback WHERE user_id=? AND created_at>=date('now'))<10 AND (SELECT COUNT(*) FROM pilot_feedback WHERE workspace_id=?)<1000`,
        )
        .bind(
          id,
          workspace.id,
          user.id,
          reviewId,
          body.rating,
          body.kind,
          note,
          workspace.id,
          user.id,
          user.id,
          workspace.id,
        ),
      "feedback.created",
      id,
      { kind: body.kind, reviewId },
    );
    if (!changed) {
      const count = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM pilot_feedback WHERE user_id=? AND created_at>=date('now')",
        )
        .bind(user.id)
        .first<{ n: number }>();
      if (count && count.n >= 10)
        throw new HttpError(
          429,
          "You can submit up to 10 feedback notes per UTC day.",
          "FEEDBACK_LIMIT",
        );
      throw new HttpError(
        409,
        "Permissions changed or the workspace feedback limit was reached.",
      );
    }
    return { id, ok: true };
  }
  if (
    ["/api/feedback", "/api/feedback/export"].includes(url.pathname) &&
    req.method === "GET"
  ) {
    requireRole(scope, ADMINS);
    const base =
      "SELECT f.*,u.email AS author_email FROM pilot_feedback f JOIN users u ON u.id=f.user_id";
    if (url.pathname.endsWith("/export"))
      return {
        feedback: (
          await db
            .prepare(
              `${base} WHERE f.workspace_id=? ORDER BY f.created_at DESC,f.id DESC LIMIT 1000`,
            )
            .bind(workspace.id)
            .all()
        ).results,
      };
    const p = page(url),
      params: unknown[] = [workspace.id];
    let where = "f.workspace_id=?";
    if (p.cursor) {
      where += " AND (f.created_at<? OR (f.created_at=? AND f.id<?))";
      params.push(p.cursor.time, p.cursor.time, p.cursor.id);
    }
    const rows = (
      await db
        .prepare(
          `${base} WHERE ${where} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`,
        )
        .bind(...params, p.limit + 1)
        .all<{ id: string; created_at: string }>()
    ).results;
    const summary = await db
      .prepare(
        "SELECT COUNT(*) AS count,ROUND(AVG(rating),1) AS averageRating FROM pilot_feedback WHERE workspace_id=?",
      )
      .bind(workspace.id)
      .first();
    return {
      feedback: rows.slice(0, p.limit),
      nextCursor: nextCursor(rows, p.limit),
      summary,
    };
  }
  return null;
}
