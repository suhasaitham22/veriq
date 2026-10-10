import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUARANTEES,
  LIMITS,
  POLICY_SCOPE,
  STATUS_MEANING,
  InputError,
  capacitySignal,
  reviewDraft,
  splitStatements,
  sha256,
} from "../apps/api/src/pipeline.ts";
import type {
  ActivePolicySet,
  AIClient,
  ApprovedDocument,
  PolicyScope,
} from "../apps/api/src/pipeline.ts";
const policy = "Refund requests must be submitted within 30 days of purchase.";
const docs: ApprovedDocument[] = [
  {
    id: "policy-a",
    title: "Refund policy",
    version: "2026-10",
    content: policy,
    contentHash: "hash-a",
    sourceUrl: null,
  },
];
const evidence = { source: "d0", stance: "supports", quote: policy };
/** Stands in for the complete active set that policy-scope.ts mints in production. */
function policySet(documents: ApprovedDocument[]): ActivePolicySet {
  return {
    documents,
    scope: {
      kind: POLICY_SCOPE,
      documentCount: documents.length,
      documentIds: documents.map((d) => d.id),
      corpusChars: documents.reduce((n, d) => n + d.content.length, 0),
      capturedAt: "2026-10-09T00:00:00.000Z",
    },
  };
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
/** One batched request; every supplied statement gets the same answer. */
function uniformAI(
  answer: object = { notApplicable: false, evidence: [] },
): AIClient {
  return {
    async run(_model, input) {
      return {
        response: JSON.stringify({
          statements: payload(input).statements.map((s) => ({
            index: s.index,
            ...answer,
          })),
        }),
      };
    },
  };
}
/** Answers each statement individually; `undefined` means "omit this index". */
function perStatementAI(
  answers: Record<string, object>,
  record?: { requests: BatchRequest[] },
): AIClient {
  return {
    async run(_model, input) {
      const request = payload(input);
      record?.requests.push(request);
      return {
        response: JSON.stringify({
          statements: request.statements
            .map((s) => {
              const answer = answers[s.text];
              if (answer === undefined) return null;
              return { index: s.index, ...answer };
            })
            .filter((entry) => entry !== null),
        }),
      };
    },
  };
}

test("supported draft records exact quotes, full-workspace scope and honest guarantees", async () => {
  const result = await reviewDraft(
    policy,
    policySet(docs),
    uniformAI({ notApplicable: false, evidence: [evidence] }),
  );
  assert.equal(result.status, "ready_for_review");
  assert.equal(result.scope, "all_active_workspace_policies");
  assert.equal(result.coverage, "full_active_workspace_policies");
  assert.deepEqual(result.guarantees, {
    quoteProvenance: "exact_text",
    semanticEntailment: "model_assessed",
    accountFacts: "not_verified",
    applicability: "human_confirmation_required",
  });
  assert.equal(result.policyScope.kind, POLICY_SCOPE);
  assert.deepEqual(result.policyScope.documentIds, ["policy-a"]);
  assert.equal(result.policyScope.documentCount, 1);
  assert.equal(result.statusMeaning, STATUS_MEANING.ready_for_review);
  assert.match(result.statusMeaning, /model finding for a person to inspect/);
  assert.match(result.statusMeaning, /Nothing has been verified, sent or acted/);
  assert.equal(result.receipts[0].verdict, "supported");
  assert.equal(result.receipts[0].evidence[0].version, "2026-10");
  assert.equal(result.receipts[0].evidence[0].contentHash, "hash-a");
  assert.equal(result.receipts[0].evidence[0].quote, policy);
  assert.equal("confidence" in result.receipts[0], false);
  assert.equal("content" in result.documents[0], false);
});
test("an exact quote is still only a model assessment and still demands human confirmation", async () => {
  const result = await reviewDraft(
    policy,
    policySet(docs),
    uniformAI({ notApplicable: false, evidence: [evidence] }),
  );
  assert.equal(result.guarantees.quoteProvenance, "exact_text");
  assert.equal(result.guarantees.semanticEntailment, "model_assessed");
  assert.equal(result.guarantees.accountFacts, "not_verified");
  assert.equal(result.guarantees.applicability, "human_confirmation_required");
  assert.match(result.receipts[0].reviewNote, /model assessed/);
  assert.match(
    result.receipts[0].reviewNote,
    /Confirm the policy applies to this customer/,
  );
  assert.match(
    result.summary,
    /provenance, not semantic correctness; human inspection is required/,
  );
});
test("contradiction requires changes", async () => {
  const result = await reviewDraft(
    "Refunds are available within 60 days.",
    policySet(docs),
    uniformAI({
      notApplicable: false,
      evidence: [{ ...evidence, stance: "refutes" }],
    }),
  );
  assert.equal(result.status, "requires_changes");
  assert.equal(result.receipts[0].verdict, "contradicted");
  assert.equal(result.receipts[0].counterEvidence.length, 1);
});
test("conflicting approved versions retain both sides instead of choosing the newer version", async () => {
  const other = "Refund requests must be submitted within 60 days of purchase.";
  const result = await reviewDraft(
    policy,
    policySet([
      ...docs,
      { ...docs[0], id: "policy-b", version: "2026-11", content: other },
    ]),
    uniformAI({
      notApplicable: false,
      evidence: [evidence, { source: "d1", stance: "refutes", quote: other }],
    }),
  );
  assert.equal(result.receipts[0].verdict, "conflicting");
  assert.equal(result.status, "requires_changes");
  assert.equal(result.receipts[0].evidence.length, 1);
  assert.equal(result.receipts[0].counterEvidence.length, 1);
});
test("missing evidence cannot approve a draft", async () => {
  const result = await reviewDraft(
    "Your account has unlimited exports.",
    policySet(docs),
    uniformAI(),
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].verdict, "unsupported");
});
for (const invalid of [
  { ...evidence, quote: "Every customer gets a full refund within 60 days." },
  { ...evidence, source: "outside-library" },
  { ...evidence, source: "d1" },
  { ...evidence, stance: "definitely_true" },
  { ...evidence, quote: "30 days" },
  {
    ...evidence,
    quote: "Refund requests must be submitted  within 30 days of purchase.",
  },
]) {
  test(`invalid evidence is rejected: ${JSON.stringify(invalid)}`, async () => {
    const result = await reviewDraft(
      policy,
      policySet(docs),
      uniformAI({ notApplicable: false, evidence: [invalid] }),
    );
    assert.equal(result.status, "needs_review");
    assert.equal(result.receipts[0].evidence.length, 0);
    assert.equal(result.receipts[0].evaluationFailed, true);
  });
}
test("valid support plus an invalid citation still requires review", async () => {
  const result = await reviewDraft(
    policy,
    policySet(docs),
    uniformAI({
      notApplicable: false,
      evidence: [evidence, { ...evidence, source: "bad" }],
    }),
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].verdict, "unsupported");
});
for (const result of [
  { response: "not JSON" },
  { response: "null" },
  { response: JSON.stringify({ evidence: [] }) },
  { response: JSON.stringify({ statements: {} }) },
  { response: JSON.stringify({ statements: [] }) },
  { reasoning_content: "supports" },
]) {
  test("malformed or missing model content fails closed", async () => {
    const review = await reviewDraft(policy, policySet(docs), {
      async run() {
        return result;
      },
    });
    assert.equal(review.status, "needs_review");
    assert.equal(review.receipts[0].evaluationFailed, true);
  });
}
test("AI service failure produces a private reviewable failure receipt", async () => {
  const result = await reviewDraft(policy, policySet(docs), {
    async run() {
      throw new Error("model unavailable");
    },
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].evaluationFailed, true);
});
test("a capacity refusal surfaces with its own code instead of becoming a model finding", async () => {
  const refusal = Object.assign(new Error("Daily AI allowance reached."), {
    status: 429,
    code: "AI_BUDGET_EXCEEDED",
  });
  assert.deepEqual(capacitySignal(refusal), {
    status: 429,
    code: "AI_BUDGET_EXCEEDED",
  });
  assert.equal(capacitySignal(new Error("Truncated answer")), null);
  assert.equal(capacitySignal(new InputError("bad draft")), null);
  await assert.rejects(
    reviewDraft(policy, policySet(docs), {
      async run() {
        throw refusal;
      },
    }),
    (error: unknown) => error === refusal,
  );
});
test("OpenAI-style model envelope is supported", async () => {
  const result = await reviewDraft(policy, policySet(docs), {
    async run() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                statements: [
                  { index: 0, notApplicable: false, evidence: [evidence] },
                ],
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.status, "ready_for_review");
});
test("every sentence is checked in one batched request, not one request per sentence", async () => {
  let calls = 0;
  const ai: AIClient = {
    async run(_model, input) {
      calls++;
      return {
        response: JSON.stringify({
          statements: payload(input).statements.map((s) => ({
            index: s.index,
            notApplicable: false,
            evidence: [],
          })),
        }),
      };
    },
  };
  const draft =
    "It is free. It works. We promise. You qualify. We will refund you.";
  const result = await reviewDraft(draft, policySet(docs), ai);
  assert.equal(calls, 1);
  assert.equal(result.receipts.length, 5);
  assert.equal(result.receipts[4].statement, "We will refund you.");
  assert.ok(result.receipts.every((r) => r.verdict === "unsupported"));
});
test("a batch that repeats, omits or invents a statement index fails every statement closed", async () => {
  const draft = "First factual claim. Second factual claim.";
  for (const statements of [
    [
      { index: 0, notApplicable: false, evidence: [] },
      { index: 0, notApplicable: false, evidence: [] },
    ],
    [{ index: 0, notApplicable: false, evidence: [] }],
    [
      { index: 0, notApplicable: false, evidence: [] },
      { index: 7, notApplicable: false, evidence: [] },
    ],
    [
      { index: 0, notApplicable: false, evidence: [] },
      { index: 1, notApplicable: false, evidence: [] },
      { index: 2, notApplicable: false, evidence: [] },
    ],
    [
      { index: 0, notApplicable: "no", evidence: [] },
      { index: 1, notApplicable: false, evidence: [] },
    ],
    [
      { index: 0, notApplicable: false },
      { index: 1, notApplicable: false, evidence: [] },
    ],
  ]) {
    const result = await reviewDraft(draft, policySet(docs), {
      async run() {
        return { response: JSON.stringify({ statements }) };
      },
    });
    assert.equal(result.receipts.length, 2);
    assert.ok(
      result.receipts.every((r) => r.evaluationFailed),
      JSON.stringify(statements),
    );
    assert.equal(result.status, "needs_review");
  }
});
test("more citations than the per-statement cap fails the batch closed", async () => {
  const result = await reviewDraft(
    policy,
    policySet(docs),
    uniformAI({
      notApplicable: false,
      evidence: Array(LIMITS.evidencePerStatement + 1).fill(evidence),
    }),
  );
  assert.equal(result.receipts[0].evaluationFailed, true);
  assert.equal(result.status, "needs_review");
});
test("one statement's invalid citation does not change its neighbour's verdict", async () => {
  const second = "Refunds reach the original payment method.";
  const documents = [{ ...docs[0], content: `${policy} ${second}` }];
  const result = await reviewDraft(
    `${policy} ${second}`,
    policySet(documents),
    perStatementAI({
      [policy]: { notApplicable: false, evidence: [evidence] },
      [second]: {
        notApplicable: false,
        evidence: [{ ...evidence, quote: "Refunds reach any card you like." }],
      },
    }),
  );
  assert.equal(result.receipts[0].verdict, "supported");
  assert.equal(result.receipts[0].evaluationFailed, false);
  assert.equal(result.receipts[1].evaluationFailed, true);
  assert.equal(result.receipts[1].evidence.length, 0);
  assert.equal(result.status, "needs_review");
});
test("compound statements stay intact so partial support cannot silently drop a promise", () => {
  assert.deepEqual(
    splitStatements("Exports are included and refunds are guaranteed."),
    ["Exports are included and refunds are guaranteed."],
  );
});
test("known courtesies never reach the model, and the model cannot mark a promise not applicable", async () => {
  const record = { requests: [] as BatchRequest[] };
  const promise = "We will refund you tomorrow.";
  const result = await reviewDraft(
    `Hello. ${policy} ${promise}`,
    policySet(docs),
    perStatementAI(
      {
        [policy]: { notApplicable: false, evidence: [evidence] },
        [promise]: { notApplicable: true, evidence: [] },
      },
      record,
    ),
  );
  assert.deepEqual(
    result.receipts.map((r) => r.verdict),
    ["not_applicable", "supported", "unsupported"],
  );
  assert.equal(result.status, "needs_review");
  assert.deepEqual(
    record.requests[0].statements.map((s) => s.text),
    [policy, promise],
  );
  assert.deepEqual(
    record.requests[0].statements.map((s) => s.index),
    [1, 2],
  );
});
test("courtesy-only drafts spend no model call and never reach a ready status", async () => {
  let calls = 0;
  const result = await reviewDraft("Hello. Thank you!", policySet(docs), {
    async run() {
      calls++;
      throw new Error("should not be called");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "needs_review");
  assert.ok(result.receipts.every((r) => r.verdict === "not_applicable"));
});
test("an unreviewable draft or policy set is rejected before any model call; no silent truncation", async () => {
  let called = false;
  const ai: AIClient = {
    async run() {
      called = true;
      throw new Error();
    },
  };
  for (const draft of [
    "X".repeat(LIMITS.draft + 1),
    "Policy applies. ".repeat(13),
    " ",
  ]) {
    await assert.rejects(reviewDraft(draft, policySet(docs), ai), InputError);
  }
  await assert.rejects(reviewDraft(policy, policySet([]), ai), InputError);
  await assert.rejects(
    reviewDraft(policy, policySet(Array(11).fill(docs[0])), ai),
    InputError,
  );
  await assert.rejects(
    reviewDraft(
      policy,
      policySet([{ ...docs[0], content: "X".repeat(LIMITS.document + 1) }]),
      ai,
    ),
    InputError,
  );
  await assert.rejects(
    reviewDraft(
      policy,
      policySet(Array(4).fill({ ...docs[0], content: "X".repeat(16000) })),
      ai,
    ),
    InputError,
  );
  assert.equal(called, false);
});
test("a scope snapshot that does not match the policy set is rejected", async () => {
  const ai = uniformAI({ notApplicable: false, evidence: [evidence] });
  const complete = policySet(docs);
  // A legacy or tampered marker is deliberately not representable in PolicyScope.
  const legacyKind = {
    ...complete.scope,
    kind: "approved_documents",
  } as unknown as PolicyScope;
  for (const scope of [
    { ...complete.scope, documentCount: 2 },
    { ...complete.scope, documentIds: ["policy-z"] },
    { ...complete.scope, corpusChars: 1 },
    legacyKind,
  ]) {
    await assert.rejects(
      reviewDraft(policy, { documents: docs, scope }, ai),
      InputError,
    );
  }
});
test("every active policy is sent once, whole, with no retrieval window to hide an exception", async () => {
  const content = `${policy} ${"Ordinary product documentation. ".repeat(180)}Exception: discounted annual subscriptions are not refundable.`;
  const documents = [
    { ...docs[0], content },
    { ...docs[0], id: "policy-b", content: "Enterprise exceptions apply." },
  ];
  let sent: BatchRequest | null = null;
  const result = await reviewDraft(policy, policySet(documents), {
    async run(_model, input) {
      sent = payload(input);
      assert.ok(input && typeof input === "object" && "max_tokens" in input);
      assert.equal(input.max_tokens, 4096);
      return {
        response: JSON.stringify({
          statements: [{ index: 0, notApplicable: false, evidence: [] }],
        }),
      };
    },
  });
  assert.ok(sent);
  assert.deepEqual(
    sent!.documents.map((d) => d.ref),
    ["d0", "d1"],
  );
  assert.equal(sent!.documents[0].text, content);
  assert.equal(sent!.documents[1].text, "Enterprise exceptions apply.");
  assert.ok(sent!.documents[0].text.includes("not refundable"));
  assert.equal(result.receipts[0].verdict, "unsupported");
});
test("duplicate citations do not multiply evidence", async () => {
  const result = await reviewDraft(
    policy,
    policySet(docs),
    uniformAI({ notApplicable: false, evidence: [evidence, evidence] }),
  );
  assert.equal(result.receipts[0].evidence.length, 1);
});
test("a quote assembled from noncontiguous sentences is rejected", async () => {
  const source = `${policy} Some products are excluded. Refunds are returned to the original payment method.`;
  const result = await reviewDraft(
    policy,
    policySet([{ ...docs[0], content: source }]),
    uniformAI({
      notApplicable: false,
      evidence: [
        {
          ...evidence,
          quote: `${policy} Refunds are returned to the original payment method.`,
        },
      ],
    }),
  );
  assert.equal(result.status, "needs_review");
});
test("SHA-256 fingerprints change with policy content", async () => {
  assert.match(await sha256(policy), /^[a-f0-9]{64}$/);
  assert.notEqual(await sha256(policy), await sha256(`${policy} Updated.`));
});
test("a stalled model and exhausted review budget leave explicit failure receipts for every sentence", async () => {
  const started = Date.now();
  const result = await reviewDraft(
    "First factual claim. Second factual claim.",
    policySet(docs),
    {
      async run() {
        // Never settles, so only the review timeout can end this call.
        return Promise.withResolvers<never>().promise;
      },
    },
    { budgetMs: 10, modelTimeoutMs: 10 },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.receipts.length, 2);
  assert.ok(result.receipts.every((r) => r.evaluationFailed));
  assert.equal(result.status, "needs_review");
});
test("Responses API assistant output is parsed while reasoning is ignored", async () => {
  const answer = JSON.stringify({
    statements: [{ index: 0, notApplicable: false, evidence: [evidence] }],
  });
  const result = await reviewDraft(policy, policySet(docs), {
    async run() {
      return {
        status: "completed",
        output: [
          {
            type: "reasoning",
            content: [{ type: "output_text", text: "not evidence" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer }],
          },
        ],
      };
    },
  });
  assert.equal(result.status, "ready_for_review");
});
for (const output of [
  { status: "incomplete", output: [] },
  {
    choices: [
      {
        finish_reason: "length",
        message: {
          content: JSON.stringify({
            statements: [
              { index: 0, notApplicable: false, evidence: [evidence] },
            ],
          }),
        },
      },
    ],
  },
  {
    output: [
      {
        type: "reasoning",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              statements: [
                { index: 0, notApplicable: false, evidence: [evidence] },
              ],
            }),
          },
        ],
      },
    ],
  },
])
  test("truncated or reasoning-only output never approves", async () => {
    const result = await reviewDraft(policy, policySet(docs), {
      async run() {
        return output;
      },
    });
    assert.equal(result.status, "needs_review");
    assert.equal(result.receipts[0].evaluationFailed, true);
  });
test("GUARANTEES never promises verified account facts or applicability", () => {
  assert.equal(GUARANTEES.accountFacts, "not_verified");
  assert.equal(GUARANTEES.applicability, "human_confirmation_required");
  assert.equal(Object.values(GUARANTEES).includes("verified"), false);
});
