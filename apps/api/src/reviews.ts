import {
  InputError,
  reviewDraft,
  sha256,
  splitStatements,
} from "./pipeline.ts";
import type { AIClient } from "./pipeline.ts";
import {
  HttpError,
  readBody,
  string,
  page,
  nextCursor,
  like,
  windowRetryAfter,
} from "./http.ts";
import { DAILY_LIMITS } from "./usage.ts";
import { WRITERS, requireRole, mutate, membershipGuard } from "./workspaces.ts";
import type { Scope } from "./workspaces.ts";
import {
  ATTESTATION_KEYS,
  activePolicies,
  requireCompleteScope,
  scopeFence,
  scopeIsCurrent,
  workspaceScope,
} from "./policy-scope.ts";
import { attachments } from "./evidence.ts";
import { requireMfa } from "./mfa.ts";
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
  const review: unknown = JSON.parse(row.review_json);
  const policyScope = workspaceScope(review);
  return {
    attachments: await attachments(db, workspaceId, row.id),
    /** A review without a full-workspace scope marker proves no coverage. */
    fullWorkspaceScope: !!policyScope,
    policiesCurrent: policyScope
      ? await scopeIsCurrent(db, workspaceId, policyScope)
      : false,
    attestation: await db
      .prepare(
        "SELECT revision,decided_by,created_at,policy_applicability_confirmed AS policyApplicabilityConfirmed,account_facts_checked AS accountFactsChecked,evidence_inspected AS evidenceInspected FROM review_attestations WHERE review_id=? AND workspace_id=? ORDER BY revision DESC LIMIT 1",
      )
      .bind(row.id, workspaceId)
      .first(),
    ...{
      id: row.id,
      draft: row.draft_text,
      review,
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
      "INSERT INTO usage(ip,day,count) VALUES(?,?,1) ON CONFLICT(ip,day) DO UPDATE SET count=count+1 WHERE count<? RETURNING count",
    )
    .bind(
      `support:${userId}`,
      new Date().toISOString().slice(0, 10),
      DAILY_LIMITS.reviews,
    )
    .first());
}
/**
 * Approval is a human act, not a model result. The approver must state that
 * they checked the three things a receipt deliberately does not establish.
 */
function requireAttestation(value: unknown) {
  const refusal = new InputError(
    `Approval requires attestation with ${ATTESTATION_KEYS.join(", ")} all true. Inspect the evidence, confirm these policies apply to this customer, and check account-specific facts yourself first.`,
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refusal;
  // Shape checked above; the three claims are read individually below.
  const claims = { ...value } as Record<string, unknown>;
  if (
    Object.keys(claims).length !== ATTESTATION_KEYS.length ||
    !ATTESTATION_KEYS.every((key) => claims[key] === true)
  )
    throw refusal;
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
    // The retry identity is the draft. A completed key replays its own review
    // even after the active set moved on, and the replayed record says so.
    const requestHash = await sha256(
      JSON.stringify({ draft: body.draft, engine: "support-v3" }),
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
        "This retry key was already used for a different draft.",
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
    // Always the complete active set: a caller may name it but cannot narrow it.
    const policies = await activePolicies(db, workspace.id);
    requireCompleteScope(body.documentIds, policies);
    const ids = policies.scope.documentIds;
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
          "Daily review limit reached. The app allowance resets at midnight UTC.",
          "QUOTA_EXCEEDED",
          windowRetryAfter(86400),
        );
      const review = await reviewDraft(body.draft, policies, ai);
      const id = crypto.randomUUID();
      // Adding, archiving or expiring a policy while the model ran invalidates
      // this write, so no saved review can claim coverage it never had.
      const fence = scopeFence(workspace.id, review.policyScope);
      const inserted = await mutate(
        scope,
        db
          .prepare(
            `INSERT INTO support_reviews(id,user_id,workspace_id,draft_text,review_json,status)
        SELECT ?,?,?,?,?,? WHERE ${membershipGuard()} AND ${fence.sql}
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
            ...fence.params,
            workspace.id,
            user.id,
            operationKey,
            lease,
          ),
        "review.created",
        id,
        { status: review.status, scope: review.scope, documentIds: ids },
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
          "The workspace's active policies or your permissions changed while this review ran. Run a new review.",
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
  if (req.method === "GET" && (!match[2] || match[2] === "export"))
    return record(row, db, workspace.id);
  if (req.method !== "POST" || match[2] !== "decision") return null;
  requireRole(scope, WRITERS);
  // A team decision is accountable to a verified second factor.
  if (!workspace.is_personal) requireMfa(user);
  const body = await readBody(req);
  if (body.decision !== "approved" && body.decision !== "rejected")
    throw new InputError("Choose approved or rejected.");
  const approving = body.decision === "approved";
  if (approving) requireAttestation(body.attestation);
  else if (body.attestation !== undefined)
    throw new InputError(
      "An attestation records a human approval only. Remove it to reject this draft.",
    );
  const note = string(body.note, "Decision note", 2000, 5);
  if (
    !Number.isInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    throw new InputError("A nonnegative expectedRevision is required.");
  const revision = Number(body.expectedRevision) + 1;
  const policyScope = workspaceScope(JSON.parse(row.review_json));
  if (approving && !policyScope)
    throw new HttpError(
      409,
      "This review predates full-workspace policy coverage, so its scope cannot be proven and it cannot be approved. Run a new review; it will cover every active approved policy.",
      "REVIEW_SCOPE_LEGACY",
    );
  if (approving && row.status !== "ready_for_review")
    throw new HttpError(
      409,
      "Resolve missing or conflicting evidence in a new review before approving.",
      "REVIEW_NOT_READY",
    );
  const fence =
    approving && policyScope ? scopeFence(workspace.id, policyScope) : null;
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
  if (fence) bindings.push(...fence.params);
  const changed = await mutate(
    scope,
    db
      .prepare(
        `UPDATE support_reviews SET decision=?,decision_note=?,decided_by=?,decided_at=datetime('now'),revision=revision+1
    WHERE id=? AND workspace_id=? AND revision=? AND ${membershipGuard()}${fence ? ` AND ${fence.sql}` : ""}`,
      )
      .bind(...bindings),
    `review.${body.decision}`,
    row.id,
    approving
      ? { note, revision, attestation: body.attestation, policyScope }
      : { note, revision },
    approving && policyScope
      ? [
          // Immutable record that a person, not the model, accepted this draft.
          db
            .prepare(
              `INSERT INTO review_attestations(id,review_id,workspace_id,decided_by,revision,policy_applicability_confirmed,account_facts_checked,evidence_inspected,policy_scope_json)
        SELECT ?,?,?,?,?,1,1,1,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM support_reviews WHERE id=? AND workspace_id=? AND decision='approved' AND decided_by=? AND revision=?)`,
            )
            .bind(
              crypto.randomUUID(),
              row.id,
              workspace.id,
              user.id,
              revision,
              JSON.stringify(policyScope),
              row.id,
              workspace.id,
              user.id,
              revision,
            ),
        ]
      : [],
  );
  if (!changed)
    throw new HttpError(
      409,
      "The review, the workspace's active policies or your permissions changed. Refresh before deciding.",
      "DECISION_CONFLICT",
    );
  return { ok: true, decision: body.decision, revision };
}
