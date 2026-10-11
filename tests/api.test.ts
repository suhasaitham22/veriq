import { test } from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api/src/index.ts";
import { fixture, fakeAI, database } from "./helpers.ts";
import { readFileSync } from "node:fs";

async function request(
  f: Awaited<ReturnType<typeof fixture>>,
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
    f.env,
  );
}
const text = "Refund requests must be submitted within 30 days of purchase.";
async function add(
  f: Awaited<ReturnType<typeof fixture>>,
  token = f.aliceToken,
  version = "v1",
) {
  const res = await request(f, "/api/documents", token, {
    title: "Refund policy",
    version,
    content: text,
  });
  assert.equal(res.status, 201);
  return (await res.json()).id as string;
}

test("full document draft → approve → review → private history flow uses real SQL", async () => {
  const f = await fixture();
  const id = await add(f);
  let response = await request(f, "/api/reviews", f.aliceToken, {
    draft: text,
    documentIds: [id],
  });
  assert.equal(response.status, 409);
  assert.equal(
    (await request(f, `/api/documents/${id}/approve`, f.aliceToken, {})).status,
    200,
  );
  f.env.AI = fakeAI({
    notApplicable: false,
    evidence: [{ source: "d0", stance: "supports", quote: text }],
  });
  response = await request(f, "/api/reviews", f.aliceToken, {
    draft: text,
    documentIds: [id],
  });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.review.status, "ready_for_review");
  const receipt = await (
    await request(f, `/api/reviews/${saved.id}`, f.aliceToken)
  ).json();
  assert.equal(receipt.draft, text);
  assert.equal(receipt.review.documents[0].version, "v1");
  assert.equal(
    (await (await request(f, "/api/reviews", f.aliceToken)).json()).reviews
      .length,
    1,
  );
  assert.equal(
    (await request(f, `/api/reviews/${saved.id}`, f.bobToken)).status,
    404,
  );
  assert.equal((await request(f, `/api/reviews/${saved.id}`)).status, 401);
  assert.deepEqual(
    (await (await request(f, "/api/reviews", f.bobToken)).json()).reviews,
    [],
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  f.sqlite.close();
});
test("account isolation blocks document listing, approval, archival, and review use", async () => {
  const f = await fixture();
  const id = await add(f);
  for (const action of ["approve", "archive"])
    assert.equal(
      (await request(f, `/api/documents/${id}/${action}`, f.bobToken, {}))
        .status,
      404,
    );
  await request(f, `/api/documents/${id}/approve`, f.aliceToken, {});
  assert.deepEqual(
    (await (await request(f, "/api/documents", f.bobToken)).json()).documents,
    [],
  );
  assert.equal(
    (
      await request(f, "/api/reviews", f.bobToken, {
        draft: text,
        documentIds: [id],
      })
    ).status,
    409,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get()!.n,
    0,
  );
  f.sqlite.close();
});
test("archiving excludes future reviews, preserves historical quotes, and disallows reapproval", async () => {
  const f = await fixture(
    fakeAI({
      notApplicable: false,
      evidence: [{ source: "d0", stance: "supports", quote: text }],
    }),
  );
  const id = await add(f);
  await request(f, `/api/documents/${id}/approve`, f.aliceToken, {});
  const saved = await (
    await request(f, "/api/reviews", f.aliceToken, {
      draft: text,
      documentIds: [id],
    })
  ).json();
  await request(f, `/api/documents/${id}/archive`, f.aliceToken, {});
  assert.equal(
    (
      await request(f, "/api/reviews", f.aliceToken, {
        draft: text,
        documentIds: [id],
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(f, `/api/documents/${id}/approve`, f.aliceToken, {})).status,
    409,
  );
  const historical = await (
    await request(f, `/api/reviews/${saved.id}`, f.aliceToken)
  ).json();
  assert.equal(historical.review.receipts[0].evidence[0].quote, text);
  assert.equal(
    (
      await request(f, "/api/documents", f.aliceToken, {
        title: "Refund policy",
        version: "v1",
        content: "Different text",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(f, "/api/documents", f.aliceToken, {
        title: "Refund policy",
        version: "v2",
        content: "Different text",
      })
    ).status,
    201,
  );
  f.sqlite.close();
});
test("approval changing while a model is running invalidates the review", async () => {
  const f = await fixture();
  const id = await add(f);
  await request(f, `/api/documents/${id}/approve`, f.aliceToken, {});
  f.env.AI = {
    async run(model, input) {
      f.sqlite
        .prepare(
          "UPDATE support_documents SET status = 'archived' WHERE id = ?",
        )
        .run(id);
      return fakeAI().run(model, input);
    },
  };
  assert.equal(
    (
      await request(f, "/api/reviews", f.aliceToken, {
        draft: text,
        documentIds: [id],
      })
    ).status,
    409,
  );
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get()!.n,
    0,
  );
  f.sqlite.close();
});
test("legacy routes cannot expose public receipts", async () => {
  const f = await fixture();
  for (const path of [
    "/api/r/11111111-1111-4111-8111-111111111111",
    "/api/verify",
    "/api/verify/history",
  ]) {
    const response = await request(f, path);
    assert.equal(response.status, 410);
    assert.equal("receipts" in (await response.json()), false);
  }
  f.sqlite.close();
});
test("invalid draft and document IDs do not consume review quota or invoke AI", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      return {};
    },
  });
  const id = await add(f);
  await request(f, `/api/documents/${id}/approve`, f.aliceToken, {});
  for (const [body, status] of [
    [{ draft: " ", documentIds: [id] }, 400],
    [{ draft: 42, documentIds: [id] }, 400],
    [{ draft: text, documentIds: [id, id] }, 409],
    [{ draft: text, documentIds: ["' OR 1=1 --"] }, 409],
    [{ draft: "Policy. ".repeat(13), documentIds: [id] }, 400],
  ] as const) {
    assert.equal((await request(f, "/api/reviews", f.aliceToken, body)).status, status);
  }
  assert.equal(calls, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM usage").get()!.n, 0);
  f.sqlite.close();
});
test("daily quota rejects review 51 atomically", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      return {};
    },
  });
  const id = await add(f);
  await request(f, `/api/documents/${id}/approve`, f.aliceToken, {});
  f.sqlite
    .prepare("INSERT INTO usage (ip, day, count) VALUES (?, ?, 50)")
    .run(`support:${f.alice}`, new Date().toISOString().slice(0, 10));
  assert.equal(
    (
      await request(f, "/api/reviews", f.aliceToken, {
        draft: text,
        documentIds: [id],
      })
    ).status,
    429,
  );
  assert.equal(calls, 0);
  assert.equal(f.sqlite.prepare("SELECT count FROM usage").get()!.count, 50);
  f.sqlite.close();
});
test("untrusted origins are rejected and allowed origins get credentialed CORS", async () => {
  const f = await fixture();
  assert.equal(
    (
      await request(f, "/api/documents", f.aliceToken, undefined, {
        origin: "https://attacker.test",
      })
    ).status,
    403,
  );
  const res = await request(f, "/api/documents", f.aliceToken, undefined, {
    origin: "http://localhost:8788",
  });
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    "http://localhost:8788",
  );
  assert.equal(res.headers.get("vary"), "Origin");
  f.sqlite.close();
});
test("expired sessions are rejected even when expiry is earlier today", async () => {
  const f = await fixture();
  f.sqlite
    .prepare("UPDATE sessions SET expires_at = ?")
    .run(new Date(Date.now() - 60_000).toISOString());
  assert.equal((await request(f, "/api/documents", f.aliceToken)).status, 401);
  f.sqlite.close();
});
test("document validation rejects non-HTTP links, empty text, and wrong types", async () => {
  const f = await fixture();
  for (const input of [
    { sourceUrl: "javascript:alert(1)" },
    { sourceUrl: "https://user:pass@example.com" },
    { content: " " },
    { title: 123 },
    { content: "x".repeat(20001) },
  ]) {
    assert.equal(
      (
        await request(f, "/api/documents", f.aliceToken, {
          title: "Policy",
          version: "v1",
          content: text,
          ...input,
        })
      ).status,
      400,
    );
  }
  f.sqlite.close();
});
test("malformed, oversized, or non-object JSON is a validation error", async () => {
  const f = await fixture();
  for (const body of ["{broken", "null", "[]", " ".repeat(100001)]) {
    const response = await api.fetch(
      new Request("http://localhost:8787/api/documents", {
        method: "POST",
        headers: {
          cookie: `__Host-veriq_session=${f.aliceToken}`,
          "content-type": "application/json",
        },
        body,
      }),
      f.env,
    );
    assert.equal(response.status, body.length > 100000 ? 413 : 400);
  }
  f.sqlite.close();
});
test("fresh migrations and existing-account bootstrap preserve users", () => {
  const { sqlite } = database();
  sqlite
    .prepare(
      "INSERT INTO users (id, email, password_hash, salt) VALUES ('legacy', 'legacy@example.test', 'hash', 'salt')",
    )
    .run();
  sqlite.exec(
    readFileSync(
      new URL("../apps/api/migrations/0001_existing_auth.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 1);
  sqlite.close();
});
