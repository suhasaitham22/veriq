import { test } from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api/src/index.ts";
import { fixture, mediaBucket } from "./helpers.ts";
const policy = "Refund requests must be submitted within 30 days of purchase.";
type F = Awaited<ReturnType<typeof fixture>>;
async function req(
  f: F,
  path: string,
  body?: unknown,
  token = f.aliceToken,
  workspace?: string,
  key?: string,
) {
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `veriq_session=${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(workspace ? { "x-workspace-id": workspace } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
  );
}
async function json201(r: Response) {
  const data = await r.json();
  assert.equal(r.status, 201, JSON.stringify(data));
  return data;
}
async function setup(f: F, team = false) {
  let workspace: string | undefined;
  if (team) {
    workspace = (
      await json201(await req(f, "/api/workspaces", { name: "Support" }))
    ).id;
    assert.equal(
      (
        await req(f, `/api/workspaces/${workspace}/members`, {
          email: "bob@example.test",
          role: "admin",
        })
      ).status,
      200,
    );
  }
  const id = (
    await json201(
      await req(
        f,
        "/api/documents",
        { title: "Refund", version: "v1", content: policy },
        f.aliceToken,
        workspace,
      ),
    )
  ).id;
  assert.equal(
    (
      await req(
        f,
        `/api/documents/${id}/approve`,
        {},
        team ? f.bobToken : f.aliceToken,
        workspace,
      )
    ).status,
    200,
  );
  return { workspace, id };
}
function aiAnswer(answer = policy) {
  let generates = 0,
    checks = 0;
  return {
    get generates() {
      return generates;
    },
    get checks() {
      return checks;
    },
    async run(_model: string, input: any) {
      const data = JSON.parse(input.messages[1].content);
      if (data.question) {
        generates++;
        return { response: JSON.stringify({ answer }) };
      }
      checks++;
      return {
        response: JSON.stringify({
          notApplicable: false,
          evidence:
            data.statement === policy
              ? [{ passageId: "d0p0", stance: "supports", quote: policy }]
              : [],
        }),
      };
    },
  };
}
const link = {
  title: "Refund reference",
  url: "https://docs.example.test/refunds",
  note: "Supporting public refund window reference.",
};
async function upload(
  f: F,
  bytes = Buffer.from("%PDF-1.7\nprivate sample"),
  type = "application/pdf",
  token = f.aliceToken,
  workspace?: string,
) {
  const form = new FormData();
  form.set("title", "Private sample");
  form.set("note", "Supporting refund reference document.");
  form.set("file", new Blob([bytes], { type }), "sample.pdf");
  return api.fetch(
    new Request("http://localhost:8787/api/evidence/media", {
      method: "POST",
      headers: {
        cookie: `veriq_session=${token}`,
        ...(workspace ? { "x-workspace-id": workspace } : {}),
      },
      body: form,
    }),
    f.env,
  );
}
test("links are private immutable drafts; unsafe schemes and credentialed URLs are rejected", async () => {
  const f = await fixture();
  try {
    const { id } = await json201(await req(f, "/api/evidence/links", link));
    assert.equal(
      (await req(f, `/api/evidence/${id}`, undefined, f.bobToken)).status,
      404,
    );
    assert.equal(
      (await (await req(f, "/api/evidence", undefined, f.bobToken)).json())
        .items.length,
      0,
    );
    assert.equal(
      (
        await req(f, `/api/evidence/${id}/attach`, {
          reviewId: crypto.randomUUID(),
          note: "Policy support",
        })
      ).status,
      409,
    );
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pass@example.test",
    ])
      assert.equal(
        (await req(f, "/api/evidence/links", { ...link, url })).status,
        400,
      );
    assert.throws(
      () =>
        f.sqlite
          .prepare("UPDATE evidence_items SET note='Changed' WHERE id=?")
          .run(id),
      /immutable/,
    );
    assert.equal((await req(f, `/api/evidence/${id}/approve`, {})).status, 200);
    assert.equal((await req(f, `/api/evidence/${id}/approve`, {})).status, 409);
  } finally {
    f.sqlite.close();
  }
});
test("team references require a different administrator and viewers cannot save or attach", async () => {
  const f = await fixture();
  try {
    const { workspace } = await setup(f, true);
    const { id } = await json201(
      await req(f, "/api/evidence/links", link, f.aliceToken, workspace),
    );
    assert.equal(
      (await req(f, `/api/evidence/${id}/approve`, {}, f.aliceToken, workspace))
        .status,
      403,
    );
    assert.equal(
      (await req(f, `/api/evidence/${id}/approve`, {}, f.bobToken, workspace))
        .status,
      200,
    );
    f.sqlite
      .prepare(
        "UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?",
      )
      .run(workspace, f.bob);
    assert.equal(
      (await req(f, "/api/evidence/links", link, f.bobToken, workspace)).status,
      403,
    );
    assert.equal(
      (await req(f, `/api/evidence/${id}/attach`, {}, f.bobToken, workspace))
        .status,
      403,
    );
  } finally {
    f.sqlite.close();
  }
});
test("approved attachments survive archival, appear in private exports and cannot change claim verdicts", async () => {
  const ai = aiAnswer("I issued your refund today."),
    f = await fixture(ai);
  try {
    const { id: doc } = await setup(f);
    const review = await json201(
      await req(f, "/api/reviews", {
        draft: "I issued your refund today.",
        documentIds: [doc],
      }),
    );
    const { id } = await json201(await req(f, "/api/evidence/links", link));
    await req(f, `/api/evidence/${id}/approve`, {});
    const body = {
      reviewId: review.id,
      note: "This link documents policy only, not customer actions.",
    };
    assert.equal(
      (await req(f, `/api/evidence/${id}/attach`, body)).status,
      200,
    );
    assert.equal(
      (await req(f, `/api/evidence/${id}/attach`, body)).status,
      409,
    );
    const foreign = (
      await json201(
        await req(
          f,
          "/api/documents",
          { title: "B", version: "1", content: policy },
          f.bobToken,
        ),
      )
    ).id;
    assert.equal(
      (
        await req(f, `/api/evidence/${id}/attach`, {
          ...body,
          reviewId: foreign,
        })
      ).status,
      409,
    );
    await req(f, `/api/evidence/${id}/archive`, {});
    const saved = await (
      await req(f, `/api/reviews/${review.id}/export`)
    ).json();
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.attachments[0].status, "archived");
    assert.equal(saved.review.receipts[0].verdict, "unsupported");
    assert.equal(
      (
        await req(f, `/api/reviews/${review.id}/decision`, {
          decision: "approved",
          note: "Human approved",
          expectedRevision: 0,
        })
      ).status,
      409,
    );
    assert.equal((await req(f, `/api/evidence/${id}/approve`, {})).status, 409);
  } finally {
    f.sqlite.close();
  }
});
test("private media round-trips exact bytes with fingerprints, forced downloads, no caching or bucket keys", async () => {
  const f = await fixture(),
    store = mediaBucket();
  f.env.MEDIA = store.bucket;
  try {
    const bytes = Buffer.from("%PDF-1.7\nprivate sample"),
      { id } = await json201(await upload(f, bytes));
    const metadata = await (await req(f, `/api/evidence/${id}`)).json();
    assert.equal(metadata.item.object_key, undefined);
    assert.equal(metadata.item.content_hash.length, 64);
    assert.equal((await req(f, `/api/evidence/${id}/approve`, {})).status, 200);
    const r = await req(f, `/api/evidence/${id}/download`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition")!, /^attachment/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    assert.equal(
      (await req(f, `/api/evidence/${id}/download`, undefined, f.bobToken))
        .status,
      404,
    );
    const o = [...store.objects.values()][0];
    o.customMetadata.hash = "tampered";
    assert.equal((await req(f, `/api/evidence/${id}/download`)).status, 409);
  } finally {
    f.sqlite.close();
  }
});
test("media rejects absent storage, false MIME signatures, empty and oversized files before storage IO", async () => {
  const f = await fixture(),
    store = mediaBucket();
  try {
    assert.equal((await upload(f)).status, 503);
    f.env.MEDIA = store.bucket;
    assert.equal(
      (await upload(f, Buffer.from("<script>alert(1)</script>"), "image/png"))
        .status,
      400,
    );
    assert.equal((await upload(f, Buffer.alloc(0))).status, 400);
    assert.equal(
      (await upload(f, Buffer.alloc(5 * 1024 * 1024 + 1))).status,
      413,
    );
    assert.equal(store.objects.size, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM evidence_items").get()!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});
test("failed uploads release their reserved quota and cannot be approved", async () => {
  const f = await fixture();
  f.env.MEDIA = {
    async put() {
      throw new Error("Unavailable");
    },
  } as unknown as R2Bucket;
  try {
    assert.equal((await upload(f)).status, 503);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM evidence_items").get()!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});
test("reference quota is atomic and membership loss during approval prevents mutation", async () => {
  const f = await fixture();
  try {
    const { workspace } = await setup(f, true);
    const { id } = await json201(
      await req(f, "/api/evidence/links", link, f.aliceToken, workspace),
    );
    const original = f.env.DB.batch.bind(f.env.DB);
    let calls = 0;
    f.env.DB.batch = async (stmts: any[]) => {
      if (++calls === 2 && stmts.length === 2)
        f.sqlite
          .prepare(
            "UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?",
          )
          .run(workspace, f.bob);
      return original(stmts);
    };
    assert.equal(
      (await req(f, `/api/evidence/${id}/approve`, {}, f.bobToken, workspace))
        .status,
      409,
    );
    assert.equal(
      f.sqlite.prepare("SELECT status FROM evidence_items WHERE id=?").get(id)!
        .status,
      "draft",
    );
  } finally {
    f.sqlite.close();
  }
});
test("AI chat saves conversation and canonical claim review; retries replay without more model calls", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id } = await setup(f),
      body = { question: "What is the refund window?", documentIds: [id] },
      key = crypto.randomUUID();
    const data = await json201(
      await req(f, "/api/chat", body, f.aliceToken, undefined, key),
    );
    assert.equal(data.turn.answer, policy);
    assert.equal(ai.generates, 1);
    assert.equal(ai.checks, 1);
    const review = await (
      await req(f, `/api/reviews/${data.turn.review_id}`)
    ).json();
    assert.equal(review.review.receipts[0].verdict, "supported");
    assert.equal(review.decision, "pending");
    const replay = await json201(
      await req(f, "/api/chat", body, f.aliceToken, undefined, key),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.turn.id, data.turn.id);
    assert.equal(replay.turn.lease, undefined);
    assert.equal(ai.generates, 1);
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { ...body, question: "Different question" },
          f.aliceToken,
          undefined,
          key,
        )
      ).status,
      409,
    );
    assert.equal(
      (await req(f, `/api/chat/${data.turn.id}`, undefined, f.bobToken)).status,
      404,
    );
    const next = await json201(
      await req(
        f,
        "/api/chat",
        { ...body, parentId: data.turn.id },
        f.aliceToken,
        undefined,
        crypto.randomUUID(),
      ),
    );
    assert.equal(next.turn.parent_id, data.turn.id);
    assert.equal(
      (await (await req(f, "/api/chat?limit=1")).json()).nextCursor !== null,
      true,
    );
  } finally {
    f.sqlite.close();
  }
});
test("invented chat facts remain unsupported and cannot be approved", async () => {
  const f = await fixture(aiAnswer("I issued your refund today."));
  try {
    const { id } = await setup(f),
      data = await json201(
        await req(
          f,
          "/api/chat",
          { question: "Refund status?", documentIds: [id] },
          f.aliceToken,
          undefined,
          crypto.randomUUID(),
        ),
      );
    const saved = await (
      await req(f, `/api/reviews/${data.turn.review_id}`)
    ).json();
    assert.equal(saved.review.receipts[0].verdict, "unsupported");
    assert.equal(
      (
        await req(f, `/api/reviews/${saved.id}/decision`, {
          decision: "approved",
          note: "Approved now",
          expectedRevision: 0,
        })
      ).status,
      409,
    );
  } finally {
    f.sqlite.close();
  }
});
test("chat rejects invalid inputs, unapproved/foreign policies and foreign parent before inference", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id } = await setup(f);
    for (const body of [
      { question: "hi", documentIds: [] },
      { question: "hi", documentIds: [id, id] },
      { question: "hi", documentIds: [crypto.randomUUID()] },
      { question: "hi", documentIds: [id], parentId: crypto.randomUUID() },
    ])
      assert.ok(
        (
          await req(
            f,
            "/api/chat",
            body,
            f.aliceToken,
            undefined,
            crypto.randomUUID(),
          )
        ).status >= 400,
      );
    assert.equal(
      (await req(f, "/api/chat", { question: "hi", documentIds: [id] })).status,
      400,
    );
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { question: "hi", documentIds: [id] },
          f.bobToken,
          undefined,
          crypto.randomUUID(),
        )
      ).status,
      409,
    );
    await req(f, `/api/documents/${id}/archive`, {});
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { question: "hi", documentIds: [id] },
          f.aliceToken,
          undefined,
          crypto.randomUUID(),
        )
      ).status,
      409,
    );
    assert.equal(ai.generates, 0);
  } finally {
    f.sqlite.close();
  }
});
test("incomplete/invalid AI generation creates no answer or review and remains retryable", async () => {
  const f = await fixture({
    async run() {
      return {
        status: "incomplete",
        response: JSON.stringify({ answer: policy }),
      };
    },
  });
  try {
    const { id } = await setup(f),
      body = { question: "Refund?", documentIds: [id] },
      key = crypto.randomUUID();
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      502,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM support_reviews").get()!.n,
      0,
    );
    assert.equal(
      f.sqlite.prepare("SELECT answer,state FROM chat_turns").get()!.answer,
      null,
    );
    f.env.AI = aiAnswer();
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      201,
    );
  } finally {
    f.sqlite.close();
  }
});
test("concurrent duplicate chat requests invoke generation once and fence in-progress retries", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    wait = new Promise<void>((r) => (release = r));
  const ai = aiAnswer();
  const f = await fixture({
    async run(m, input: any) {
      if (JSON.parse(input.messages[1].content).question) {
        started();
        await wait;
      }
      return ai.run(m, input);
    },
  });
  try {
    const { id } = await setup(f),
      body = { question: "Refund?", documentIds: [id] },
      key = crypto.randomUUID();
    const first = req(f, "/api/chat", body, f.aliceToken, undefined, key);
    await ready;
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      409,
    );
    release();
    assert.equal((await first).status, 201);
    assert.equal(ai.generates, 1);
  } finally {
    release();
    f.sqlite.close();
  }
});
test("policy archival or membership revocation during generation prevents saving its answer", async () => {
  for (const mode of ["archive", "revoke"]) {
    const f = await fixture();
    try {
      const { id, workspace } = await setup(f, true),
        ai = aiAnswer();
      f.env.AI = {
        async run(m, input: any) {
          if (mode === "archive")
            f.sqlite
              .prepare(
                "UPDATE support_documents SET status='archived' WHERE id=?",
              )
              .run(id);
          else
            f.sqlite
              .prepare(
                "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?",
              )
              .run(workspace, f.bob);
          return ai.run(m, input);
        },
      };
      assert.equal(
        (
          await req(
            f,
            "/api/chat",
            { question: "Refund?", documentIds: [id] },
            f.bobToken,
            workspace,
            crypto.randomUUID(),
          )
        ).status,
        409,
      );
      assert.equal(
        f.sqlite.prepare("SELECT answer FROM chat_turns").get()!.answer,
        null,
      );
      assert.equal(
        f.sqlite.prepare("SELECT COUNT(*) n FROM support_reviews").get()!.n,
        0,
      );
    } finally {
      f.sqlite.close();
    }
  }
});
test("chat viewer access is read-only and daily generation quota rejects before calling AI", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id, workspace } = await setup(f, true);
    f.sqlite
      .prepare(
        "UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?",
      )
      .run(workspace, f.bob);
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { question: "Refund?", documentIds: [id] },
          f.bobToken,
          workspace,
          crypto.randomUUID(),
        )
      ).status,
      403,
    );
    const window = Math.floor(Date.now() / 1000 / 86400);
    f.sqlite
      .prepare(
        "INSERT INTO request_limits(key,window,count,expires_at) VALUES(?,?,50,?)",
      )
      .run(`chat:${f.alice}`, window, (window + 1) * 86400 + 5);
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { question: "Refund?", documentIds: [id] },
          f.aliceToken,
          workspace,
          crypto.randomUUID(),
        )
      ).status,
      429,
    );
    assert.equal(ai.generates, 0);
  } finally {
    f.sqlite.close();
  }
});
test("a retry after review quota failure reuses the saved draft instead of regenerating it", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id } = await setup(f),
      key = crypto.randomUUID(),
      body = { question: "Refund?", documentIds: [id] },
      day = new Date().toISOString().slice(0, 10);
    f.sqlite
      .prepare("INSERT INTO usage(ip,day,count) VALUES(?,?,50)")
      .run(`support:${f.alice}`, day);
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      429,
    );
    f.sqlite.prepare("UPDATE usage SET count=0").run();
    const data = await json201(
      await req(f, "/api/chat", body, f.aliceToken, undefined, key),
    );
    assert.ok(data.turn.review_id);
    assert.equal(ai.generates, 1);
  } finally {
    f.sqlite.close();
  }
});

test("reference item and byte quotas reject concurrent over-capacity saves without object writes", async () => {
  const f = await fixture(),
    store = mediaBucket();
  f.env.MEDIA = store.bucket;
  try {
    await req(f, "/api/workspaces");
    const insert = f.sqlite.prepare(
      "INSERT INTO evidence_items(id,workspace_id,user_id,kind,title,note,source_url,content_hash) VALUES(?,?,?,'link','seed','seed context','https://example.test','hash')",
    );
    for (let i = 0; i < 499; i++)
      insert.run(crypto.randomUUID(), f.alice, f.alice);
    const pair = await Promise.all([
      req(f, "/api/evidence/links", link),
      req(f, "/api/evidence/links", link),
    ]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM evidence_items").get()!.n,
      500,
    );
    assert.equal((await upload(f)).status, 409);
    assert.equal(store.objects.size, 0);
    f.sqlite.prepare("DELETE FROM evidence_items").run();
    const files = f.sqlite.prepare(
      "INSERT INTO evidence_items(id,workspace_id,user_id,kind,title,note,object_key,byte_size,content_hash) VALUES(?,?,?,'media','seed','context',?,4194304,'hash')",
    );
    for (let i = 0; i < 25; i++)
      files.run(crypto.randomUUID(), f.alice, f.alice, `seed-${i}`);
    assert.equal((await upload(f)).status, 409);
    assert.equal(store.objects.size, 0);
  } finally {
    f.sqlite.close();
  }
});
test("membership removal during object lookup prevents private media download", async () => {
  const f = await fixture(),
    store = mediaBucket();
  f.env.MEDIA = store.bucket;
  try {
    const { workspace } = await setup(f, true),
      { id } = await json201(
        await upload(f, undefined, undefined, f.aliceToken, workspace),
      );
    const get = store.bucket.get.bind(store.bucket);
    f.env.MEDIA = {
      ...store.bucket,
      async get(key: string) {
        f.sqlite
          .prepare(
            "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?",
          )
          .run(workspace, f.bob);
        return get(key);
      },
    } as R2Bucket;
    assert.equal(
      (
        await req(
          f,
          `/api/evidence/${id}/download`,
          undefined,
          f.bobToken,
          workspace,
        )
      ).status,
      404,
    );
  } finally {
    f.sqlite.close();
  }
});
test("chat completion audit failure rolls back the turn and retry recovers the already saved review", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id } = await setup(f),
      body = { question: "Refund deadline?", documentIds: [id] },
      key = crypto.randomUUID();
    f.sqlite.exec(
      "CREATE TRIGGER fail_chat_audit BEFORE INSERT ON audit_events WHEN NEW.action='chat.completed' BEGIN SELECT RAISE(ABORT,'fail audit'); END;",
    );
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      500,
    );
    const failed = f.sqlite
      .prepare("SELECT state,review_id,answer FROM chat_turns")
      .get()!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.review_id, null);
    assert.equal(failed.answer, policy);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM support_reviews").get()!.n,
      1,
    );
    f.sqlite.exec("DROP TRIGGER fail_chat_audit");
    assert.equal(
      (await req(f, "/api/chat", body, f.aliceToken, undefined, key)).status,
      201,
    );
    assert.equal(ai.generates, 1);
    assert.equal(ai.checks, 1);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM support_reviews").get()!.n,
      1,
    );
  } finally {
    f.sqlite.close();
  }
});
test("a reclaimed chat lease prevents an older generation from overwriting the completed turn", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    wait = new Promise<void>((r) => (release = r));
  let calls = 0;
  const normal = aiAnswer();
  const f = await fixture({
    async run(m, input: any) {
      if (JSON.parse(input.messages[1].content).question && ++calls === 1) {
        started();
        await wait;
      }
      return normal.run(m, input);
    },
  });
  try {
    const { id } = await setup(f),
      body = { question: "Refund?", documentIds: [id] },
      key = crypto.randomUUID();
    const first = req(f, "/api/chat", body, f.aliceToken, undefined, key);
    await ready;
    f.sqlite.prepare("UPDATE chat_turns SET lease_until=0").run();
    const next = await json201(
      await req(f, "/api/chat", body, f.aliceToken, undefined, key),
    );
    release();
    assert.equal((await first).status, 409);
    assert.equal(
      f.sqlite.prepare("SELECT state,review_id FROM chat_turns").get()!.state,
      "completed",
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM support_reviews").get()!.n,
      1,
    );
    assert.ok(next.turn.review_id);
  } finally {
    release();
    f.sqlite.close();
  }
});
test("workspace chat capacity is bounded atomically, including failed attempts, without generation", async () => {
  const ai = aiAnswer(),
    f = await fixture(ai);
  try {
    const { id } = await setup(f);
    const insert = f.sqlite.prepare(
      "INSERT INTO chat_turns(id,workspace_id,user_id,request_key,request_hash,question,document_ids_json,state,lease,lease_until) VALUES(?,?,?,?,'hash','seed','[]','failed','lease',0)",
    );
    for (let i = 0; i < 1000; i++)
      insert.run(crypto.randomUUID(), f.alice, f.alice, `seed-${i}`);
    assert.equal(
      (
        await req(
          f,
          "/api/chat",
          { question: "Refund?", documentIds: [id] },
          f.aliceToken,
          undefined,
          crypto.randomUUID(),
        )
      ).status,
      409,
    );
    assert.equal(ai.generates, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM chat_turns").get()!.n,
      1000,
    );
  } finally {
    f.sqlite.close();
  }
});
test("reference search escapes wildcards and timestamp-tied cursor pages have no duplicates", async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        (
          await json201(
            await req(f, "/api/evidence/links", {
              ...link,
              title: i === 0 ? "Literal 100% reference" : `Reference ${i}`,
            }),
          )
        ).id,
      );
    const found = await (await req(f, "/api/evidence?q=%25")).json();
    assert.equal(found.items.length, 1);
    const first = await (await req(f, "/api/evidence?limit=2")).json(),
      second = await (
        await req(
          f,
          `/api/evidence?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).json();
    assert.equal(
      new Set([...first.items, ...second.items].map((i) => i.id)).size,
      4,
    );
    assert.equal(second.nextCursor, null);
  } finally {
    f.sqlite.close();
  }
});
