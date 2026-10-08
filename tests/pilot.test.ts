import { test } from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api/src/index.ts";
import { fixture, fakeAI } from "./helpers.ts";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(
  f: Fixture,
  path: string,
  body?: unknown,
  token = f.aliceToken,
  ws?: string,
) {
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `veriq_session=${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(ws ? { "x-workspace-id": ws } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
  );
}
const feedback = {
  rating: 4,
  kind: "usability",
  note: "The exact quotes helped our review process.",
};
test("sample setup requires explicit confirmation, is idempotent and uses the real review pipeline", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      return {
        response: JSON.stringify({
          notApplicable: false,
          evidence: [
            {
              passageId: "d0p0",
              stance: "supports",
              quote:
                "Refund requests must be submitted within 30 days of purchase.",
            },
          ],
        }),
      };
    },
  });
  try {
    assert.equal((await request(f, "/api/demo/setup", {})).status, 400);
    const first = await (
      await request(f, "/api/demo/setup", { confirmSamplePolicies: true })
    ).json();
    const again = await (
      await request(f, "/api/demo/setup", { confirmSamplePolicies: true })
    ).json();
    assert.deepEqual(first.documentIds, again.documentIds);
    assert.equal(first.scenarios.length, 3);
    assert.equal(calls, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_documents").get()!.n,
      1,
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action='document.sample_approved'",
        )
        .get()!.n,
      1,
    );
    const review = await request(f, "/api/reviews", {
      draft: first.scenarios[0].draft,
      documentIds: first.documentIds,
    });
    assert.equal(review.status, 201);
    assert.equal((await review.json()).review.status, "ready_for_review");
    assert.equal(calls, 1);
  } finally {
    f.sqlite.close();
  }
});
test("sample policies cannot bypass team approval or revive archived versions", async () => {
  const f = await fixture();
  try {
    const ws = (
      await (await request(f, "/api/workspaces", { name: "Company" })).json()
    ).id;
    assert.equal(
      (
        await request(
          f,
          "/api/demo/setup",
          { confirmSamplePolicies: true },
          f.aliceToken,
          ws,
        )
      ).status,
      409,
    );
    const seed = await (
      await request(f, "/api/demo/setup", { confirmSamplePolicies: true })
    ).json();
    await request(f, `/api/documents/${seed.documentIds[0]}/archive`, {});
    assert.equal(
      (await request(f, "/api/demo/setup", { confirmSamplePolicies: true }))
        .status,
      409,
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM support_documents WHERE workspace_id=?",
        )
        .get(ws)!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});
test("sample setup never silently approves an existing version with different content", async () => {
  const f = await fixture();
  try {
    const sample = (await (await request(f, "/api/demo")).json()).samplePolicy;
    await request(f, "/api/documents", {
      ...sample,
      content: "Unrelated company text.",
    });
    assert.equal(
      (await request(f, "/api/demo/setup", { confirmSamplePolicies: true }))
        .status,
      409,
    );
    assert.equal(
      f.sqlite.prepare("SELECT status FROM support_documents").get()!.status,
      "draft",
    );
  } finally {
    f.sqlite.close();
  }
});
test("feedback is tenant-scoped, linked only to local reviews and audit metadata excludes notes", async () => {
  const f = await fixture(fakeAI());
  try {
    const seed = await (
      await request(f, "/api/demo/setup", { confirmSamplePolicies: true })
    ).json();
    const review = (
      await (
        await request(f, "/api/reviews", {
          draft: "An unsupported promise.",
          documentIds: seed.documentIds,
        })
      ).json()
    ).id;
    assert.equal(
      (
        await request(
          f,
          "/api/feedback",
          { ...feedback, reviewId: review },
          f.bobToken,
        )
      ).status,
      404,
    );
    const r = await request(f, "/api/feedback", {
      ...feedback,
      reviewId: review,
    });
    assert.equal(r.status, 201);
    const list = await (await request(f, "/api/feedback")).json();
    assert.equal(list.feedback[0].review_id, review);
    assert.equal(list.summary.averageRating, 4);
    assert.deepEqual(
      (await (await request(f, "/api/feedback", undefined, f.bobToken)).json())
        .feedback,
      [],
    );
    const exported = await (await request(f, "/api/feedback/export")).json();
    assert.equal(exported.feedback.length, 1);
    const audit = f.sqlite
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE action='feedback.created'",
      )
      .get()!;
    assert.equal(String(audit.metadata_json).includes(feedback.note), false);
    assert.throws(
      () =>
        f.sqlite
          .prepare("UPDATE pilot_feedback SET note=?")
          .run("Changed text"),
      /append-only/,
    );
  } finally {
    f.sqlite.close();
  }
});
test("viewers can leave feedback; only administrators can list or export it", async () => {
  const f = await fixture();
  try {
    const ws = (
      await (
        await request(f, "/api/workspaces", { name: "Company pilot" })
      ).json()
    ).id;
    await request(f, `/api/workspaces/${ws}/members`, {
      email: "bob@example.test",
      role: "viewer",
    });
    assert.equal(
      (await request(f, "/api/feedback", feedback, f.bobToken, ws)).status,
      201,
    );
    for (const path of ["/api/feedback", "/api/feedback/export"])
      assert.equal(
        (await request(f, path, undefined, f.bobToken, ws)).status,
        403,
      );
    const data = await (
      await request(f, "/api/feedback", undefined, f.aliceToken, ws)
    ).json();
    assert.equal(data.feedback[0].author_email, "bob@example.test");
    await request(f, `/api/workspaces/${ws}/members/${f.bob}`, {
      remove: true,
    });
    assert.equal(
      (await request(f, "/api/feedback", feedback, f.bobToken, ws)).status,
      404,
    );
  } finally {
    f.sqlite.close();
  }
});
test("feedback validates inputs and daily capacity is atomic under concurrent submissions", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { rating: 0 },
      { rating: 1.5 },
      { note: "short" },
      { kind: "unrecognized" },
    ])
      assert.equal(
        (await request(f, "/api/feedback", { ...feedback, ...change })).status,
        400,
      );
    const results = await Promise.all(
      Array.from({ length: 12 }, () => request(f, "/api/feedback", feedback)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 2);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM pilot_feedback").get()!.n,
      10,
    );
  } finally {
    f.sqlite.close();
  }
});
