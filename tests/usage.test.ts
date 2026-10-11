import { test } from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api/src/index.ts";
import { fixture } from "./helpers.ts";
import { windowRetryAfter } from "../apps/api/src/http.ts";

type F = Awaited<ReturnType<typeof fixture>>;
function request(
  f: F,
  path = "/api/usage",
  body?: unknown,
  token = f.aliceToken,
  workspace?: string,
  key?: string,
) {
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `__Host-veriq_session=${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(workspace ? { "x-workspace-id": workspace } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
  );
}

test("usage is authenticated, account scoped, non-cacheable and remains available with AI paused", async () => {
  const f = await fixture();
  f.env.WORKERS_FREE_PLAN_CONFIRMED = "false";
  try {
    const today = new Date().toISOString().slice(0, 10),
      window = Math.floor(Date.now() / 86400000);
    f.sqlite
      .prepare("INSERT INTO usage(ip,day,count) VALUES(?,?,?)")
      .run(`support:${f.alice}`, today, 7);
    f.sqlite
      .prepare("INSERT INTO usage(ip,day,count) VALUES(?,?,?)")
      .run(`support:${f.alice}`, "2020-01-01", 50);
    f.sqlite
      .prepare(
        "INSERT INTO request_limits(key,window,count,expires_at) VALUES(?,?,?,?)",
      )
      .run(`chat:${f.alice}`, window, 3, (window + 1) * 86400 + 5);
    const response = await request(f),
      data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(data.reviews, { used: 7, limit: 50, remaining: 43 });
    assert.deepEqual(data.chat, { used: 3, limit: 50, remaining: 47 });
    assert.equal(new Date(data.resetAt).getUTCHours(), 0);
    assert.ok(data.retryAfter >= 1 && data.retryAfter <= 86400);
    const bob = await (
      await request(f, "/api/usage", undefined, f.bobToken)
    ).json();
    assert.equal(bob.reviews.used, 0);
    assert.equal(bob.chat.used, 0);
    assert.equal(
      (await api.fetch(new Request("http://localhost/api/usage"), f.env))
        .status,
      401,
    );
    assert.equal(
      (await request(f, "/api/usage", undefined, f.aliceToken, f.bob)).status,
      404,
    );
  } finally {
    f.sqlite.close();
  }
});

test("daily wait duration reaches the next UTC boundary, including the last second", () => {
  assert.equal(
    windowRetryAfter(86400, Date.parse("2026-10-09T00:00:00Z")),
    86400,
  );
  assert.equal(
    windowRetryAfter(86400, Date.parse("2026-10-09T12:30:00Z")),
    41400,
  );
  assert.equal(
    windowRetryAfter(86400, Date.parse("2026-10-09T23:59:59.900Z")),
    1,
  );
});

test("daily review and chat rejections expose the UTC reset, and rejected attempts do not inflate counts", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      throw new Error("Quota must stop inference");
    },
  });
  try {
    const policy =
      "Refund requests must be submitted within 30 days of purchase.";
    const docResponse = await request(f, "/api/documents", {
      title: "Refund",
      version: "v1",
      content: policy,
    });
    assert.equal(docResponse.status, 201);
    const id = (await docResponse.json()).id;
    assert.equal(
      (await request(f, `/api/documents/${id}/approve`, {})).status,
      200,
    );
    f.sqlite
      .prepare("INSERT INTO usage(ip,day,count) VALUES(?,?,50)")
      .run(`support:${f.alice}`, new Date().toISOString().slice(0, 10));
    const window = Math.floor(Date.now() / 86400000);
    f.sqlite
      .prepare(
        "INSERT INTO request_limits(key,window,count,expires_at) VALUES(?,?,50,?)",
      )
      .run(`chat:${f.alice}`, window, (window + 1) * 86400 + 5);
    for (const [path, body, code] of [
      ["/api/reviews", { draft: policy, documentIds: [id] }, "QUOTA_EXCEEDED"],
      [
        "/api/chat",
        { question: "What is the refund deadline?", documentIds: [id] },
        "CHAT_LIMIT",
      ],
    ] as const) {
      const response = await request(
        f,
        path,
        body,
        f.aliceToken,
        undefined,
        "usage-test-retry-0001",
      );
      assert.equal(response.status, 429);
      assert.equal((await response.json()).code, code);
      const retryAfter = Number(response.headers.get("retry-after"));
      assert.ok(Math.abs(retryAfter - windowRetryAfter(86400)) <= 1);
    }
    assert.equal(calls, 0);
    const data = await (await request(f)).json();
    assert.equal(data.reviews.used, 50);
    assert.equal(data.chat.used, 50);
    assert.equal(data.reviews.remaining, 0);
    assert.equal(data.chat.remaining, 0);
  } finally {
    f.sqlite.close();
  }
});
