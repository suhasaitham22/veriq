/**
 * Every review and chat answer is checked against *all* active approved
 * policies in the workspace. A caller cannot narrow the set, so it cannot
 * approve a draft by leaving the conflicting policy out of the request.
 *
 * "All" is bounded to one workspace. It is not a claim that the workspace holds
 * every policy the company has.
 */
import { ACTIVE, snapshot } from "./documents.ts";
import type { DocumentRow } from "./documents.ts";
import { HttpError } from "./http.ts";
import { LIMITS, POLICY_SCOPE } from "./pipeline.ts";
import type { ActivePolicySet, PolicyScope } from "./pipeline.ts";

/** Attestation keys a human must send to approve a review. */
export const ATTESTATION_KEYS = [
  "policyApplicabilityConfirmed",
  "accountFactsChecked",
  "evidenceInspected",
] as const;

/**
 * Snapshot every active approved policy, ordered by id, or refuse with an
 * action the administrator can take. Nothing is truncated, sampled or dropped:
 * an unreviewable corpus is an error, never a quiet partial review.
 */
export async function activePolicies(
  db: D1Database,
  workspaceId: string,
): Promise<ActivePolicySet> {
  const documents = (
    await db.prepare(`SELECT * FROM support_documents WHERE workspace_id=? AND ${ACTIVE} ORDER BY id LIMIT ?`)
      .bind(workspaceId, LIMITS.documents + 1).all<DocumentRow>()
  ).results.map(snapshot);
  if (!documents.length)
    throw new HttpError(
      409,
      "This workspace has no approved, active policy version. Approve a policy version, or check its effective and expiry dates, then run the review.",
      "NO_ACTIVE_POLICIES",
    );
  if (documents.length > LIMITS.documents)
    throw new HttpError(
      409,
      `This workspace exceeds ${LIMITS.documents} active approved policy versions. A review must cover all of them. Archive superseded versions or use a separate workspace for a bounded policy domain, then retry.`,
      "POLICY_SCOPE_OVER_CAP",
    );
  const corpusChars = documents.reduce((sum, document) => sum + document.content.length, 0);
  if (corpusChars > LIMITS.corpus)
    throw new HttpError(
      409,
      `This workspace's active approved policies total ${corpusChars} UTF-16 code units. A review must cover all of them and supports at most ${LIMITS.corpus}. Archive superseded versions or use a separate workspace for a bounded policy domain, then retry.`,
      "POLICY_SCOPE_OVER_CAP",
    );
  return {
    documents,
    scope: {
      kind: POLICY_SCOPE,
      documentCount: documents.length,
      documentIds: documents.map((d) => d.id),
      corpusChars,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * An optional exact-set guard, not a source selector. Chat passes its generation
 * snapshot here so a changed corpus cannot silently replace it during checking.
 * Public clients should omit it; older subset clients receive an explicit error.
 */
export function requireCompleteScope(
  documentIds: unknown,
  policies: ActivePolicySet,
): void {
  if (documentIds === undefined) return;
  const expected = policies.scope.documentIds;
  const given = Array.isArray(documentIds) ? [...documentIds].sort() : null;
  if (
    !given ||
    given.length !== expected.length ||
    new Set(given).size !== given.length ||
    given.some((id, i) => id !== expected[i])
  )
    throw new HttpError(
      409,
      `documentIds must list every active approved policy in this workspace (${expected.length} right now). Omit documentIds to always review the complete active set.`,
      "POLICY_SCOPE_INCOMPLETE",
    );
}

export interface ScopeFence {
  sql: string;
  params: (string | number)[];
}

/**
 * Two counts pin the exact active set: its size, and how many of the snapshot's
 * own ids are still active. Approving, archiving or expiring any policy while
 * the model runs moves one of them, so a guarded write cannot land and an
 * existing approval cannot be granted against a stale snapshot.
 */
export function scopeFence(
  workspaceId: string,
  scope: PolicyScope,
): ScopeFence {
  const marks = scope.documentIds.map(() => "?").join(",");
  return {
    sql: `(SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND ${ACTIVE})=? AND (SELECT COUNT(*) FROM support_documents WHERE workspace_id=? AND ${ACTIVE} AND id IN (${marks}))=?`,
    params: [
      workspaceId,
      scope.documentCount,
      workspaceId,
      ...scope.documentIds,
      scope.documentCount,
    ],
  };
}

export async function scopeIsCurrent(
  db: D1Database,
  workspaceId: string,
  scope: PolicyScope,
): Promise<boolean> {
  const fence = scopeFence(workspaceId, scope);
  return !!(await db
    .prepare(`SELECT 1 AS scope_current WHERE ${fence.sql}`)
    .bind(...fence.params)
    .first());
}

/**
 * The explicit full-workspace scope marker, or null when a stored review
 * predates it. A review without the marker proves nothing about coverage, so
 * it is never current and can never be approved.
 */
export function workspaceScope(review: unknown): PolicyScope | null {
  const stored = review as {
    scope?: unknown;
    policyScope?: Partial<PolicyScope>;
  } | null;
  const scope = stored?.policyScope;
  if (
    stored?.scope !== POLICY_SCOPE ||
    !scope ||
    scope.kind !== POLICY_SCOPE ||
    !Array.isArray(scope.documentIds) ||
    !scope.documentIds.length ||
    scope.documentIds.some((id) => typeof id !== "string") ||
    scope.documentIds.length !== scope.documentCount
  )
    return null;
  return scope as PolicyScope;
}
