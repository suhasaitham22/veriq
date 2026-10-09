import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import api from "../apps/api/src/index.ts";
import type { Env } from "../apps/api/src/index.ts";
import type { AIClient } from "../apps/api/src/pipeline.ts";
import { HttpError } from "../apps/api/src/http.ts";
import { fixture, fakeAI } from "./helpers.ts";
import {
  EvaluationInputError,
  evaluate,
  readLabels,
  readObservations,
  run,
} from "../apps/api/evaluation/evaluate.mjs";

const refund = "Refund requests must be submitted within 30 days of purchase.";
const conflict = "Refund requests must be submitted within 7 days of purchase.";
const ATTESTED = {
  policyApplicabilityConfirmed: true,
  accountFactsChecked: true,
  evidenceInspected: true,
};
async function call(
  env: Env,
  path: string,
  token?: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { cookie: `__Host-veriq_session=${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
async function approvedPolicy(
  env: Env,
  token: string,
  title: string,
  version: string,
  content: string,
) {
  const created = await call(env, "/api/documents", token, {
    title,
    version,
    content,
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(
    (await call(env, `/api/documents/${id}/approve`, token, {})).status,
    200,
  );
  return id as string;
}
interface BatchRequest {
  statements: { index: number; text: string }[];
  documents: { ref: string; title: string; version: string; text: string }[];
}
function payload(input: unknown): BatchRequest {
  assert.ok(input && typeof input === "object" && "messages" in input);
  const { messages } = input;
  assert.ok(Array.isArray(messages) && messages.length === 2);
  return JSON.parse(messages[1].content);
}
/** Cites every policy sent: supports the ones containing the statement, refutes the rest. */
function citeEveryPolicy(): AIClient {
  return {
    async run(_model, input) {
      const request = payload(input);
      return {
        response: JSON.stringify({
          statements: request.statements.map((s) => ({
            index: s.index,
            notApplicable: false,
            evidence: request.documents.map((d) => ({
              source: d.ref,
              stance: d.text.includes(s.text) ? "supports" : "refutes",
              quote: d.text.slice(0, 60),
            })),
          })),
        }),
      };
    },
  };
}

test("a conflicting active policy cannot be left out of the request", async () => {
  const f = await fixture(citeEveryPolicy());
  const first = await approvedPolicy(
    f.env,
    f.aliceToken,
    "Refund policy",
    "v1",
    refund,
  );
  // With one active policy the draft looks ready.
  const ready = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(ready.status, 201);
  const readyBody = await ready.json();
  assert.equal(readyBody.review.status, "ready_for_review");
  assert.equal(readyBody.review.scope, "all_active_workspace_policies");
  assert.deepEqual(readyBody.review.policyScope.documentIds, [first]);
  // A second administrator approves a conflicting version.
  const second = await approvedPolicy(
    f.env,
    f.aliceToken,
    "Refund policy",
    "v2",
    conflict,
  );
  // Naming only the convenient policy is refused, not quietly honoured.
  const narrowed = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
    documentIds: [first],
  });
  assert.equal(narrowed.status, 409);
  const narrowedBody = await narrowed.json();
  assert.equal(narrowedBody.code, "POLICY_SCOPE_INCOMPLETE");
  assert.match(narrowedBody.error, /every active approved policy/);
  // The complete set sees the conflict.
  const full = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(full.status, 201);
  const fullBody = await full.json();
  assert.equal(fullBody.review.status, "requires_changes");
  assert.deepEqual(
    fullBody.review.policyScope.documentIds,
    [first, second].sort(),
  );
  assert.equal(fullBody.review.receipts[0].counterEvidence.length, 1);
});
test("a policy approved while the model runs stops the review from being saved", async () => {
  const f = await fixture();
  await approvedPolicy(f.env, f.aliceToken, "Refund policy", "v1", refund);
  f.env.AI = {
    async run(_model, input) {
      // Another administrator approves a policy mid-inference.
      f.sqlite
        .prepare(
          "INSERT INTO support_documents(id,workspace_id,user_id,title,version,content,content_hash,status,approved_at,approved_by) VALUES(?,?,?,?,?,?,?,'approved',datetime('now'),?)",
        )
        .run(
          crypto.randomUUID(),
          f.alice,
          f.alice,
          "Exceptions",
          "v1",
          conflict,
          "hash-mid-flight",
          f.alice,
        );
      return {
        response: JSON.stringify({
          statements: payload(input).statements.map((s) => ({
            index: s.index,
            notApplicable: false,
            evidence: [{ source: "d0", stance: "supports", quote: refund }],
          })),
        }),
      };
    },
  };
  const response = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "REVIEW_STALE");
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get().n,
    0,
  );
});
test("a new active policy makes a saved receipt stale and blocks its approval", async () => {
  const f = await fixture(
    fakeAI({
      notApplicable: false,
      evidence: [{ source: "d0", stance: "supports", quote: refund }],
    }),
  );
  await approvedPolicy(f.env, f.aliceToken, "Refund policy", "v1", refund);
  const saved = await (
    await call(f.env, "/api/reviews", f.aliceToken, { draft: refund })
  ).json();
  assert.equal(saved.review.status, "ready_for_review");
  let record = await (
    await call(f.env, `/api/reviews/${saved.id}`, f.aliceToken)
  ).json();
  assert.equal(record.fullWorkspaceScope, true);
  assert.equal(record.policiesCurrent, true);
  await approvedPolicy(f.env, f.aliceToken, "Exceptions", "v1", conflict);
  record = await (
    await call(f.env, `/api/reviews/${saved.id}`, f.aliceToken)
  ).json();
  assert.equal(record.policiesCurrent, false);
  const refused = await call(
    f.env,
    `/api/reviews/${saved.id}/decision`,
    f.aliceToken,
    {
      decision: "approved",
      note: "Looks right to me.",
      expectedRevision: 0,
      attestation: ATTESTED,
    },
  );
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "DECISION_CONFLICT");
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM review_attestations").get().n,
    0,
  );
});
test("an exact quote the model misapplied is still only a model finding, and approval needs an explicit human attestation", async () => {
  const enterprise =
    "Enterprise customers may request an exception through their account manager.";
  const f = await fixture(
    fakeAI({
      notApplicable: false,
      evidence: [{ source: "d0", stance: "supports", quote: enterprise }],
    }),
  );
  await approvedPolicy(
    f.env,
    f.aliceToken,
    "Enterprise exceptions",
    "v1",
    enterprise,
  );
  const saved = await (
    await call(f.env, "/api/reviews", f.aliceToken, {
      draft: "Your Starter plan includes the same exception.",
    })
  ).json();
  // The quote is genuine policy text; whether it establishes the claim is not.
  assert.equal(saved.review.status, "ready_for_review");
  assert.equal(saved.review.receipts[0].evidence[0].quote, enterprise);
  assert.deepEqual(saved.review.guarantees, {
    quoteProvenance: "exact_text",
    semanticEntailment: "model_assessed",
    accountFacts: "not_verified",
    applicability: "human_confirmation_required",
  });
  assert.match(saved.review.statusMeaning, /Nothing has been verified/);
  assert.match(saved.review.receipts[0].reviewNote, /model assessed/);
  for (const attestation of [
    undefined,
    {},
    { policyApplicabilityConfirmed: true },
    { ...ATTESTED, evidenceInspected: false },
    { ...ATTESTED, accountFactsChecked: "yes" },
    { ...ATTESTED, extra: true },
  ]) {
    const refused = await call(
      f.env,
      `/api/reviews/${saved.id}/decision`,
      f.aliceToken,
      {
        decision: "approved",
        note: "Shipping it.",
        expectedRevision: 0,
        ...(attestation === undefined ? {} : { attestation }),
      },
    );
    assert.equal(refused.status, 400, JSON.stringify(attestation));
    const body = await refused.json();
    assert.equal(body.code, "INPUT_INVALID");
    assert.match(body.error, /policyApplicabilityConfirmed/);
  }
  const approved = await call(
    f.env,
    `/api/reviews/${saved.id}/decision`,
    f.aliceToken,
    {
      decision: "approved",
      note: "Checked the plan on the account before sending.",
      expectedRevision: 0,
      attestation: ATTESTED,
    },
  );
  assert.equal(approved.status, 200);
  const record = await (
    await call(f.env, `/api/reviews/${saved.id}`, f.aliceToken)
  ).json();
  assert.equal(record.decision, "approved");
  assert.equal(record.attestation.revision, 1);
  assert.equal(record.attestation.policyApplicabilityConfirmed, 1);
  assert.equal(record.attestation.accountFactsChecked, 1);
  assert.equal(record.attestation.evidenceInspected, 1);
  // The recorded attestation cannot be edited after the fact.
  const stored = f.sqlite
    .prepare("SELECT id FROM review_attestations")
    .get() as { id: string };
  assert.throws(() =>
    f.sqlite
      .prepare("UPDATE review_attestations SET evidence_inspected=0 WHERE id=?")
      .run(stored.id),
  );
});
test("a legacy receipt without a full-workspace scope marker cannot be approved", async () => {
  const f = await fixture();
  const id = await approvedPolicy(
    f.env,
    f.aliceToken,
    "Refund policy",
    "v1",
    refund,
  );
  const reviewId = crypto.randomUUID();
  const legacy = {
    schemaVersion: 1,
    scope: "approved_documents",
    status: "ready_for_review",
    receipts: [
      {
        statement: refund,
        verdict: "supported",
        evidence: [],
        counterEvidence: [],
        reviewNote: "",
        evaluationFailed: false,
      },
    ],
    documents: [
      {
        id,
        title: "Refund policy",
        version: "v1",
        contentHash: "hash-legacy",
        sourceUrl: null,
      },
    ],
    summary: "",
  };
  f.sqlite
    .prepare(
      "INSERT INTO support_reviews(id,user_id,workspace_id,draft_text,review_json,status) VALUES(?,?,?,?,?,?)",
    )
    .run(
      reviewId,
      f.alice,
      f.alice,
      refund,
      JSON.stringify(legacy),
      "ready_for_review",
    );
  const record = await (
    await call(f.env, `/api/reviews/${reviewId}`, f.aliceToken)
  ).json();
  assert.equal(record.fullWorkspaceScope, false);
  assert.equal(record.policiesCurrent, false);
  const refused = await call(
    f.env,
    `/api/reviews/${reviewId}/decision`,
    f.aliceToken,
    {
      decision: "approved",
      note: "Approving the old receipt.",
      expectedRevision: 0,
      attestation: ATTESTED,
    },
  );
  assert.equal(refused.status, 409);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.code, "REVIEW_SCOPE_LEGACY");
  assert.match(refusedBody.error, /Run a new review/);
  // Rejection stays available, and it takes no attestation.
  const rejectedWithAttestation = await call(
    f.env,
    `/api/reviews/${reviewId}/decision`,
    f.aliceToken,
    {
      decision: "rejected",
      note: "Superseded by a new review.",
      expectedRevision: 0,
      attestation: ATTESTED,
    },
  );
  assert.equal(rejectedWithAttestation.status, 400);
  const rejected = await call(
    f.env,
    `/api/reviews/${reviewId}/decision`,
    f.aliceToken,
    {
      decision: "rejected",
      note: "Superseded by a new review.",
      expectedRevision: 0,
    },
  );
  assert.equal(rejected.status, 200);
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM review_attestations").get().n,
    0,
  );
});
test("no active policy, or more policies than the cap, fails closed with an action", async () => {
  const f = await fixture();
  const empty = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(empty.status, 409);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.code, "NO_ACTIVE_POLICIES");
  assert.match(emptyBody.error, /Approve a policy version/);
  const emptyChat = await call(
    f.env,
    "/api/chat",
    f.aliceToken,
    { question: "What is the refund window?" },
    { "idempotency-key": "no-active-policy-chat-key" },
  );
  assert.equal(emptyChat.status, 409);
  assert.equal((await emptyChat.json()).code, "NO_ACTIVE_POLICIES");
  for (let i = 0; i < 11; i++)
    await approvedPolicy(
      f.env,
      f.aliceToken,
      `Policy ${i}`,
      "v1",
      `${refund} Section ${i}.`,
    );
  const capped = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(capped.status, 409);
  const cappedBody = await capped.json();
  assert.equal(cappedBody.code, "POLICY_SCOPE_OVER_CAP");
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get().n,
    0,
  );
});
test("an AI capacity refusal keeps its own code instead of a generic failure", async () => {
  const f = await fixture({
    async run() {
      throw new HttpError(
        429,
        "Shared AI allowance reached for today.",
        "AI_BUDGET_EXCEEDED",
        60,
      );
    },
  });
  await approvedPolicy(f.env, f.aliceToken, "Refund policy", "v1", refund);
  const review = await call(f.env, "/api/reviews", f.aliceToken, {
    draft: refund,
  });
  assert.equal(review.status, 429);
  assert.equal((await review.json()).code, "AI_BUDGET_EXCEEDED");
  const chat = await call(
    f.env,
    "/api/chat",
    f.aliceToken,
    { question: "What is the refund window?" },
    { "idempotency-key": "capacity-refusal-chat-key" },
  );
  assert.equal(chat.status, 429);
  assert.equal((await chat.json()).code, "AI_BUDGET_EXCEEDED");
});
test("a batch answer that repeats one index and drops another fails closed and cannot be approved", async () => {
  const f = await fixture({
    async run(_model, input) {
      const { statements } = payload(input);
      return {
        response: JSON.stringify({
          statements: statements.map(() => ({
            index: statements[0].index,
            notApplicable: false,
            evidence: [{ source: "d0", stance: "supports", quote: refund }],
          })),
        }),
      };
    },
  });
  await approvedPolicy(f.env, f.aliceToken, "Refund policy", "v1", refund);
  const saved = await (
    await call(f.env, "/api/reviews", f.aliceToken, {
      draft: `${refund} We will refund you tomorrow.`,
    })
  ).json();
  assert.equal(saved.review.status, "needs_review");
  assert.equal(saved.review.receipts.length, 2);
  assert.ok(
    saved.review.receipts.every(
      (r: { evaluationFailed: boolean }) => r.evaluationFailed,
    ),
  );
  const refused = await call(
    f.env,
    `/api/reviews/${saved.id}/decision`,
    f.aliceToken,
    {
      decision: "approved",
      note: "Approving despite the failure.",
      expectedRevision: 0,
      attestation: ATTESTED,
    },
  );
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "REVIEW_NOT_READY");
});
test("chat answers from every active policy and refuses a narrowed policy set", async () => {
  const f = await fixture({
    async run(_model, input) {
      assert.ok(input && typeof input === "object" && "messages" in input);
      const { messages } = input;
      assert.ok(Array.isArray(messages));
      const request = JSON.parse(messages[1].content);
      if (!request.statements)
        return { response: JSON.stringify({ answer: refund }) };
      return {
        response: JSON.stringify({
          statements: request.statements.map((s: { index: number }) => ({
            index: s.index,
            notApplicable: false,
            evidence: [{ source: "d0", stance: "supports", quote: refund }],
          })),
        }),
      };
    },
  });
  const first = await approvedPolicy(
    f.env,
    f.aliceToken,
    "Refund policy",
    "v1",
    refund,
  );
  const created = await call(
    f.env,
    "/api/chat",
    f.aliceToken,
    { question: "What is the refund window?" },
    { "idempotency-key": "chat-full-scope-key-1" },
  );
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.turn.state, "completed");
  assert.deepEqual(JSON.parse(body.turn.document_ids_json), [first]);
  await approvedPolicy(f.env, f.aliceToken, "Exceptions", "v1", conflict);
  const narrowed = await call(
    f.env,
    "/api/chat",
    f.aliceToken,
    { question: "What is the refund window?", documentIds: [first] },
    { "idempotency-key": "chat-narrowed-scope-key-2" },
  );
  assert.equal(narrowed.status, 409);
  assert.equal((await narrowed.json()).code, "POLICY_SCOPE_INCOMPLETE");
});

const labelsFile = new URL(
  "../apps/api/evaluation/examples/cases.example.jsonl",
  import.meta.url,
);
const reviewsFile = new URL(
  "../apps/api/evaluation/examples/reviews.example.jsonl",
  import.meta.url,
);
test("the offline evaluator counts false-ready, citation gaps and unscored cases", () => {
  const labels = readLabels(readFileSync(labelsFile, "utf8"), "cases");
  const observations = readObservations(
    readFileSync(reviewsFile, "utf8"),
    labels,
    "reviews",
  );
  const report = evaluate(labels, observations);
  assert.equal(report.labelSource, "fictional_fixture");
  assert.match(report.accuracyClaim, /^None\./);
  assert.equal(report.totals.labeled, 5);
  assert.equal(report.totals.scored, 3);
  assert.equal(report.totals.unscored, 2);
  assert.equal(report.totals.agreed, 2);
  assert.equal(report.falseReady.count, 1);
  assert.deepEqual(report.falseReady.cases, [
    {
      id: "refund-window-stretched",
      expected: "requires_changes",
      actual: "ready_for_review",
    },
  ]);
  assert.equal(report.falseReady.rate, 1 / 3);
  assert.equal(report.confusion.ready_for_review.ready_for_review, 1);
  assert.equal(report.confusion.requires_changes.ready_for_review, 1);
  assert.equal(report.confusion.requires_changes.requires_changes, 0);
  assert.equal(report.confusion.needs_review.needs_review, 1);
  assert.equal(report.citationCoverage.required, 2);
  assert.equal(report.citationCoverage.matched, 1);
  assert.deepEqual(report.citationCoverage.missing, [
    { id: "refund-window-stretched", quote: "within 30 days of purchase" },
  ]);
  // A refused capture and an absent capture are both named, never counted as agreement.
  assert.deepEqual(report.unscored, [
    { id: "quota-refused", reason: "review_error", code: "QUOTA_EXCEEDED" },
    { id: "never-captured", reason: "missing_review" },
  ]);
});
test("the evaluator rejects duplicate ids, missing ids and unlabeled captures", () => {
  const header = '{"datasetVersion":1,"labelSource":"fictional_fixture"}';
  const labels = readLabels(
    `${header}\n{"id":"a","expected":"needs_review"}`,
    "cases",
  );
  assert.equal(labels.cases.size, 1);
  for (const bad of [
    "",
    '{"labelSource":"fictional_fixture"}',
    '{"datasetVersion":1,"labelSource":"guesswork"}\n{"id":"a","expected":"needs_review"}',
    header,
    `${header}\n{"expected":"needs_review"}`,
    `${header}\n{"id":"a","expected":"needs_review"}\n{"id":"a","expected":"needs_review"}`,
    `${header}\n{"id":"a","expected":"maybe"}`,
    `${header}\n{"id":"a","expected":"needs_review","requiredQuotes":[""]}`,
    `${header}\nnot json`,
    `${header}\n["a"]`,
  ])
    assert.throws(() => readLabels(bad, "cases"), EvaluationInputError, bad);
  const good = '{"status":"needs_review","receipts":[]}';
  for (const bad of [
    `{"review":${good}}`,
    '{"id":"a"}',
    `{"id":"a","review":${good},"error":{"code":"X"}}`,
    `{"id":"b","review":${good}}`,
    '{"id":"a","review":{"status":"ok","receipts":[]}}',
    '{"id":"a","review":{"status":"needs_review"}}',
    '{"id":"a","error":{}}',
    `{"id":"a","review":${good}}\n{"id":"a","review":${good}}`,
  ])
    assert.throws(
      () => readObservations(bad, labels, "reviews"),
      EvaluationInputError,
      bad,
    );
});
test("the evaluator CLI reports a partial capture instead of hiding it", () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = {
    log: (message: string) => lines.push(message),
    error: (message: string) => errors.push(message),
  };
  const argv = [
    "--labels",
    fileURLToPath(labelsFile),
    "--reviews",
    fileURLToPath(reviewsFile),
  ];
  assert.equal(run(argv, io), 2);
  assert.match(errors.join("\n"), /2 labeled case\(s\) were never scored/);
  assert.match(lines.join("\n"), /False ready: 1 of 3 scored \(33\.3%\)/);
  assert.match(lines.join("\n"), /Citation coverage: 1 of 2/);
  assert.match(lines.join("\n"), /fictional fixture/);
  assert.match(
    lines.join("\n"),
    /quota-refused: review_error \(QUOTA_EXCEEDED\)/,
  );
  assert.equal(run([...argv, "--allow-unscored"], io), 0);
  assert.equal(run([...argv, "--json", "--allow-unscored"], io), 0);
  assert.match(lines.join("\n"), /"falseReady"/);
  assert.equal(run(["--labels", fileURLToPath(labelsFile)], io), 1);
  assert.equal(run([...argv, "--bogus"], io), 1);
  assert.equal(run([...argv, "--labels"], io), 1);
});

test("concurrent approvals with the same expected revision create one decision and one attestation", async () => {
  const f = await fixture(fakeAI({ notApplicable: false, evidence: [{ source: "d0", stance: "supports", quote: refund }] }));
  try {
    await approvedPolicy(f.env, f.aliceToken, "Refund", "v1", refund);
    const saved = await (await call(f.env, "/api/reviews", f.aliceToken, { draft: refund })).json();
    const decision = { decision: "approved", note: "Human inspected the exact quote and case facts.", expectedRevision: 0, attestation: ATTESTED };
    const results = await Promise.all([
      call(f.env, `/api/reviews/${saved.id}/decision`, f.aliceToken, decision),
      call(f.env, `/api/reviews/${saved.id}/decision`, f.aliceToken, decision),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM review_attestations WHERE review_id=?").get(saved.id)!.n, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='review.approved' AND object_id=?").get(saved.id)!.n, 1);
    assert.equal(f.sqlite.prepare("SELECT revision FROM support_reviews WHERE id=?").get(saved.id)!.revision, 1);
  } finally { f.sqlite.close(); }
});
