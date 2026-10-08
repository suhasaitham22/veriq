import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  InputError,
  reviewDraft,
  splitStatements,
  retrievePassages,
  sha256,
} from "../apps/api/src/pipeline.ts";
import type { ApprovedDocument, AIClient } from "../apps/api/src/pipeline.ts";
import { fakeAI } from "./helpers.ts";
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
const evidence = { passageId: "d0p0", stance: "supports", quote: policy };

test("supported draft records exact quotes and immutable version metadata without a confidence percentage", async () => {
  const result = await reviewDraft(
    policy,
    docs,
    fakeAI({ notApplicable: false, evidence: [evidence] }),
  );
  assert.equal(result.status, "ready_for_review");
  assert.equal(result.scope, "approved_documents");
  assert.equal(result.receipts[0].verdict, "supported");
  assert.equal(result.receipts[0].evidence[0].version, "2026-10");
  assert.equal(result.receipts[0].evidence[0].contentHash, "hash-a");
  assert.equal(result.receipts[0].evidence[0].quote, policy);
  assert.equal("confidence" in result.receipts[0], false);
  assert.equal("content" in result.documents[0], false);
});
test("contradiction requires changes", async () => {
  const result = await reviewDraft(
    "Refunds are available within 60 days.",
    docs,
    fakeAI({
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
    [
      ...docs,
      { ...docs[0], id: "policy-b", version: "2026-11", content: other },
    ],
    fakeAI({
      notApplicable: false,
      evidence: [
        evidence,
        { passageId: "d1p0", stance: "refutes", quote: other },
      ],
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
    docs,
    fakeAI(),
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].verdict, "unsupported");
});
for (const invalid of [
  { ...evidence, quote: "Every customer gets a full refund within 60 days." },
  { ...evidence, passageId: "outside-library" },
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
      docs,
      fakeAI({ notApplicable: false, evidence: [invalid] }),
    );
    assert.equal(result.status, "needs_review");
    assert.equal(result.receipts[0].evidence.length, 0);
    assert.equal(result.receipts[0].evaluationFailed, true);
  });
}
test("valid support plus an invalid citation still requires review", async () => {
  const result = await reviewDraft(
    policy,
    docs,
    fakeAI({
      notApplicable: false,
      evidence: [evidence, { ...evidence, passageId: "bad" }],
    }),
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].verdict, "unsupported");
});
for (const result of [
  { response: "not JSON" },
  { response: "null" },
  { response: JSON.stringify({ evidence: [] }) },
  { reasoning_content: "supports" },
]) {
  test("malformed or missing model content fails closed", async () => {
    const review = await reviewDraft(policy, docs, {
      async run() {
        return result;
      },
    });
    assert.equal(review.status, "needs_review");
    assert.equal(review.receipts[0].evaluationFailed, true);
  });
}
test("AI service failure produces a private reviewable failure receipt", async () => {
  const result = await reviewDraft(policy, docs, {
    async run() {
      throw new Error("quota exhausted");
    },
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.receipts[0].evaluationFailed, true);
});
test("OpenAI-style model envelope is supported", async () => {
  const result = await reviewDraft(policy, docs, {
    async run() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                notApplicable: false,
                evidence: [evidence],
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.status, "ready_for_review");
});
test("every sentence, including short promises and the fifth statement, is checked", async () => {
  let calls = 0;
  const ai: AIClient = {
    async run() {
      calls++;
      return {
        response: JSON.stringify({ notApplicable: false, evidence: [] }),
      };
    },
  };
  const draft =
    "It is free. It works. We promise. You qualify. We will refund you.";
  const result = await reviewDraft(draft, docs, ai);
  assert.equal(calls, 5);
  assert.equal(result.receipts.length, 5);
  assert.equal(result.receipts[4].statement, "We will refund you.");
});
test("compound statements stay intact so partial support cannot silently drop a promise", () => {
  assert.deepEqual(
    splitStatements("Exports are included and refunds are guaranteed."),
    ["Exports are included and refunds are guaranteed."],
  );
});
test("known courtesies are skipped, but model cannot mark arbitrary promises not applicable", async () => {
  const result = await reviewDraft(
    `Hello. ${policy} We will refund you tomorrow.`,
    docs,
    {
      async run(_model, input) {
        const statement = JSON.parse(
          (input as any).messages[1].content,
        ).statement;
        return {
          response: JSON.stringify(
            statement === policy
              ? { notApplicable: false, evidence: [evidence] }
              : { notApplicable: true, evidence: [] },
          ),
        };
      },
    },
  );
  assert.deepEqual(
    result.receipts.map((r) => r.verdict),
    ["not_applicable", "supported", "unsupported"],
  );
  assert.equal(result.status, "needs_review");
});
test("courtesy-only drafts do not produce a ready status", async () => {
  assert.equal(
    (await reviewDraft("Hello. Thank you!", docs, fakeAI())).status,
    "needs_review",
  );
});
test("over-budget input is rejected before any model call; no silent truncation", async () => {
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
    await assert.rejects(reviewDraft(draft, docs, ai), InputError);
  }
  await assert.rejects(reviewDraft(policy, [], ai), InputError);
  await assert.rejects(
    reviewDraft(policy, Array(11).fill(docs[0]), ai),
    InputError,
  );
  await assert.rejects(
    reviewDraft(
      policy,
      [{ ...docs[0], content: "X".repeat(LIMITS.document + 1) }],
      ai,
    ),
    InputError,
  );
  await assert.rejects(
    reviewDraft(
      policy,
      Array(4).fill({ ...docs[0], content: "X".repeat(16000) }),
      ai,
    ),
    InputError,
  );
  assert.equal(called, false);
});
test("retrieval includes every selected document and only contiguous source text", () => {
  const corpus = [
    ...docs,
    {
      ...docs[0],
      id: "other",
      content:
        "Enterprise customers may request an exception through their account manager.",
    },
  ];
  const passages = retrievePassages(policy, corpus);
  assert.equal(new Set(passages.map((p) => p.document.id)).size, 2);
  for (const p of passages) assert.ok(p.document.content.includes(p.text));
});
test("duplicate citations do not multiply evidence", async () => {
  const result = await reviewDraft(
    policy,
    docs,
    fakeAI({ notApplicable: false, evidence: [evidence, evidence] }),
  );
  assert.equal(result.receipts[0].evidence.length, 1);
});
test("a quote assembled from noncontiguous sentences is rejected", async () => {
  const source = `${policy} Some products are excluded. Refunds are returned to the original payment method.`;
  const result = await reviewDraft(
    policy,
    [{ ...docs[0], content: source }],
    fakeAI({
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
    docs,
    {
      async run() {
        return new Promise(() => {});
      },
    },
    { budgetMs: 10, modelTimeoutMs: 10 },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.receipts.length, 2);
  assert.ok(result.receipts.every((r) => r.evaluationFailed));
  assert.equal(result.status, "needs_review");
});

test("full selected document coverage includes distant exceptions and every character", async () => {
  const content =
    policy +
    " Ordinary product documentation. ".repeat(180) +
    "Exception: discounted annual subscriptions are not refundable.";
  const corpus = [{ ...docs[0], content }];
  const passages = retrievePassages(policy, corpus);
  assert.ok(passages.length > 2);
  const covered = new Uint8Array(content.length);
  for (const p of passages) {
    const offset = Number(p.id.match(/p(\d+)$/)![1]) * 900;
    covered.fill(1, offset, offset + p.text.length);
  }
  assert.ok(covered.every((v) => v === 1));
  let sawException = false;
  await reviewDraft(policy, corpus, {
    async run(_model, input) {
      const payload = JSON.parse((input as any).messages[1].content);
      sawException = payload.passages.some((p: any) =>
        p.text.includes("discounted annual subscriptions"),
      );
      assert.equal((input as any).max_tokens, 4096);
      return {
        response: JSON.stringify({ notApplicable: false, evidence: [] }),
      };
    },
  });
  assert.equal(sawException, true);
});
test("Responses API assistant output is parsed while reasoning is ignored", async () => {
  const answer = JSON.stringify({ notApplicable: false, evidence: [evidence] });
  const result = await reviewDraft(policy, docs, {
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
            notApplicable: false,
            evidence: [evidence],
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
              notApplicable: false,
              evidence: [evidence],
            }),
          },
        ],
      },
    ],
  },
])
  test("truncated or reasoning-only output never approves", async () => {
    const result = await reviewDraft(policy, docs, {
      async run() {
        return output;
      },
    });
    assert.equal(result.status, "needs_review");
    assert.equal(result.receipts[0].evaluationFailed, true);
  });
