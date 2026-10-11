import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import api from "../apps/api/src/index.ts";
import { fixture, fakeAI, admit } from "./helpers.ts";
const text = "Refund requests must be submitted within 30 days of purchase.";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function req(
  f: Fixture,
  path: string,
  token = f.aliceToken,
  body?: unknown,
  workspace?: string,
  key?: string,
) {
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `__Host-veriq_session=${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(workspace ? { "X-Workspace-ID": workspace } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
  );
}
async function doc(
  f: Fixture,
  workspace?: string,
  token = f.aliceToken,
  extra = {},
) {
  const r = await req(
    f,
    "/api/documents",
    token,
    {
      title: "Refund policy",
      version: crypto.randomUUID(),
      content: text,
      ...extra,
    },
    workspace,
  );
  assert.equal(r.status, 201);
  return (await r.json()).id as string;
}
async function team(f: Fixture) {
  const r = await req(f, "/api/workspaces", f.aliceToken, {
    name: "Support operations",
  });
  assert.equal(r.status, 201);
  const id = (await r.json()).id as string;
  await admit(f.env, id, f.aliceToken, f.bobToken);
  return id;
}
async function ready(f: Fixture, workspace?: string) {
  const id = await doc(f, workspace);
  assert.equal(
    (
      await req(
        f,
        `/api/documents/${id}/approve`,
        workspace ? f.bobToken : f.aliceToken,
        {},
        workspace,
      )
    ).status,
    200,
  );
  f.env.AI = fakeAI({
    notApplicable: false,
    evidence: [{ source: "d0", stance: "supports", quote: text }],
  });
  const r = await req(
    f,
    "/api/reviews",
    f.aliceToken,
    { draft: text, documentIds: [id] },
    workspace,
  );
  assert.equal(r.status, 201);
  return { id, review: (await r.json()).id as string };
}
test("team workspace is private and enforces two-person document approval", async () => {
  const f = await fixture();
  try {
    const ws = await team(f);
    const id = await doc(f, ws);
    assert.equal(
      (await req(f, `/api/documents/${id}/approve`, f.aliceToken, {}, ws))
        .status,
      403,
    );
    assert.equal(
      (await req(f, `/api/documents/${id}/approve`, f.bobToken, {}, ws)).status,
      200,
    );
    assert.equal(
      (await req(f, `/api/documents/${id}`, f.aliceToken)).status,
      404,
    );
    const row = f.sqlite
      .prepare("SELECT approved_by FROM support_documents WHERE id=?")
      .get(id)!;
    assert.equal(row.approved_by, f.bob);
    const events = (await (await req(f, `/api/workspaces/${ws}/audit`)).json())
      .events;
    assert.equal(
      events.filter((e: any) => e.action === "document.approved").length,
      1,
    );
  } finally {
    f.sqlite.close();
  }
});
test("viewer cannot mutate and reviewer cannot approve documents or manage members", async () => {
  const f = await fixture();
  try {
    const ws = await team(f);
    await req(f, `/api/workspaces/${ws}/members/${f.bob}`, f.aliceToken, {
      role: "viewer",
    });
    const id = await doc(f, ws);
    for (const [path, body] of [
      ["/api/documents", { title: "Blocked", version: "v", content: text }],
      ["/api/reviews", { draft: text, documentIds: [id] }],
      [`/api/documents/${id}/approve`, {}],
      [
        `/api/workspaces/${ws}/invitations`,
        { recipientLabel: "Known teammate", role: "admin" },
      ],
    ] as const)
      assert.equal((await req(f, path, f.bobToken, body, ws)).status, 403);
    assert.equal(
      (await req(f, "/api/documents", f.bobToken, undefined, ws)).status,
      200,
    );
    assert.equal(
      (await req(f, `/api/workspaces/${ws}/audit`, f.bobToken)).status,
      403,
    );
    await req(f, `/api/workspaces/${ws}/members/${f.bob}`, f.aliceToken, {
      role: "reviewer",
    });
    assert.ok(await doc(f, ws, f.bobToken));
    assert.equal(
      (await req(f, `/api/documents/${id}/approve`, f.bobToken, {}, ws)).status,
      403,
    );
  } finally {
    f.sqlite.close();
  }
});
test("owner is protected; admins cannot appoint or demote admins; removal revokes access", async () => {
  const f = await fixture();
  try {
    const ws = await team(f);
    assert.equal(
      (
        await req(f, `/api/workspaces/${ws}/members/${f.alice}`, f.bobToken, {
          remove: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(f, `/api/workspaces/${ws}/members/${f.bob}`, f.bobToken, {
          role: "viewer",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(f, `/api/workspaces/${ws}/invitations`, f.bobToken, {
          recipientAccountId: crypto.randomUUID(),
          recipientLabel: "Known teammate",
          role: "admin",
        })
      ).status,
      403,
    );
    assert.throws(
      () =>
        f.sqlite
          .prepare(
            "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?",
          )
          .run(ws, f.alice),
      /protected/,
    );
    await req(f, `/api/workspaces/${ws}/members/${f.bob}`, f.aliceToken, {
      remove: true,
    });
    assert.equal(
      (await req(f, "/api/documents", f.bobToken, undefined, ws)).status,
      404,
    );
    assert.equal(
      (
        await (await req(f, "/api/workspaces", f.bobToken)).json()
      ).workspaces.some((w: any) => w.id === ws),
      false,
    );
  } finally {
    f.sqlite.close();
  }
});
test("expiry, scheduled dates and invalid calendar dates fail closed", async () => {
  const f = await fixture();
  try {
    for (const extra of [
      { validFrom: "2026-02-30" },
      { validFrom: "2030-01-01", validUntil: "2029-01-01" },
    ])
      assert.equal(
        (
          await req(f, "/api/documents", f.aliceToken, {
            title: "x",
            version: "v",
            content: text,
            ...extra,
          })
        ).status,
        400,
      );
    const expired = await doc(f, undefined, f.aliceToken, {
      validUntil: "2000-01-01",
    });
    assert.equal(
      (await req(f, `/api/documents/${expired}/approve`, f.aliceToken, {}))
        .status,
      409,
    );
    const future = await doc(f, undefined, f.aliceToken, {
      validFrom: "2099-01-01",
    });
    assert.equal(
      (await req(f, `/api/documents/${future}/approve`, f.aliceToken, {}))
        .status,
      200,
    );
    assert.equal(
      (
        await req(f, "/api/reviews", f.aliceToken, {
          draft: text,
          documentIds: [future],
        })
      ).status,
      409,
    );
    const listed = (
      await (await req(f, "/api/documents")).json()
    ).documents.find((d: any) => d.id === future);
    assert.equal(listed.eligible, 0);
  } finally {
    f.sqlite.close();
  }
});
test("human decisions require readiness, active policies and optimistic revisions", async () => {
  const f = await fixture();
  try {
    const { id, review } = await ready(f);
    const decide = (body: unknown) =>
      req(f, `/api/reviews/${review}/decision`, f.aliceToken, body);
    assert.equal(
      (
        await decide({
          decision: "approved",
          attestation: { policyApplicabilityConfirmed: true, accountFactsChecked: true, evidenceInspected: true },
          note: "Verified the policy.",
          expectedRevision: 0,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await decide({
          decision: "rejected",
          note: "Concurrent edit.",
          expectedRevision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (await decide({ decision: "rejected", note: "x", expectedRevision: 1 }))
        .status,
      400,
    );
    await req(f, `/api/documents/${id}/archive`, f.aliceToken, {});
    assert.equal(
      (
        await decide({
          decision: "approved",
          attestation: { policyApplicabilityConfirmed: true, accountFactsChecked: true, evidenceInspected: true },
          note: "Trying old policy.",
          expectedRevision: 1,
        })
      ).status,
      409,
    );
    const exported = await req(f, `/api/reviews/${review}/export`);
    assert.match(exported.headers.get("content-disposition")!, /attachment/);
    const data = await exported.json();
    assert.equal(data.decision, "approved");
    assert.equal(data.policiesCurrent, false);
    assert.equal(data.review.receipts[0].evidence[0].quote, text);
    assert.equal(
      (await req(f, `/api/reviews/${review}/export`, f.bobToken)).status,
      404,
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action='review.approved'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.sqlite.close();
  }
});
test("missing evidence cannot receive an approved human decision", async () => {
  const f = await fixture();
  try {
    const id = await doc(f);
    await req(f, `/api/documents/${id}/approve`, f.aliceToken, {});
    const data = await (
      await req(f, "/api/reviews", f.aliceToken, {
        draft: text,
        documentIds: [id],
      })
    ).json();
    assert.equal(
      (
        await req(f, `/api/reviews/${data.id}/decision`, f.aliceToken, {
          decision: "approved",
          attestation: { policyApplicabilityConfirmed: true, accountFactsChecked: true, evidenceInspected: true },
          note: "Ignoring missing evidence.",
          expectedRevision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(f, `/api/reviews/${data.id}/decision`, f.aliceToken, {
          decision: "rejected",
          note: "Evidence is missing.",
          expectedRevision: 0,
        })
      ).status,
      200,
    );
  } finally {
    f.sqlite.close();
  }
});
test("retry keys replay exactly once, conflict on changed payload and fence concurrent workers", async () => {
  const f = await fixture();
  try {
    const id = await doc(f);
    await req(f, `/api/documents/${id}/approve`, f.aliceToken, {});
    let unblock!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (unblock = r));
    let calls = 0;
    f.env.AI = {
      async run(model, input) {
        calls++;
        entered();
        await gate;
        return fakeAI().run(model, input);
      },
    };
    const body = { draft: text, documentIds: [id] },
      key = "retry-key-for-this-draft";
    const running = req(f, "/api/reviews", f.aliceToken, body, undefined, key);
    await started;
    assert.equal(
      (await req(f, "/api/reviews", f.aliceToken, body, undefined, key)).status,
      409,
    );
    unblock();
    const first = await (await running).json();
    const replay = await (
      await req(f, "/api/reviews", f.aliceToken, body, undefined, key)
    ).json();
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
    assert.equal(f.sqlite.prepare("SELECT count FROM usage").get()!.count, 1);
    assert.equal(
      (
        await req(
          f,
          "/api/reviews",
          f.aliceToken,
          { ...body, draft: "Changed promise." },
          undefined,
          key,
        )
      ).status,
      409,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get()!.n,
      1,
    );
  } finally {
    f.sqlite.close();
  }
});
test("permission removal during inference prevents persisting the review", async () => {
  const f = await fixture();
  try {
    const ws = await team(f),
      id = await doc(f, ws);
    await req(f, `/api/documents/${id}/approve`, f.bobToken, {}, ws);
    f.env.AI = {
      async run(model, input) {
        f.sqlite
          .prepare(
            "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?",
          )
          .run(ws, f.bob);
        return fakeAI().run(model, input);
      },
    };
    assert.equal(
      (
        await req(
          f,
          "/api/reviews",
          f.bobToken,
          { draft: text, documentIds: [id] },
          ws,
        )
      ).status,
      409,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get()!.n,
      0,
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action='review.created'",
        )
        .get()!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});
test("a failed audit insertion rolls back its associated document mutation", async () => {
  const f = await fixture();
  try {
    await req(f, "/api/workspaces");
    f.sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    const r = await req(f, "/api/documents", f.aliceToken, {
      title: "Rollback",
      version: "v1",
      content: text,
    });
    assert.equal(r.status, 500);
    const error = await r.json();
    assert.equal(error.code, "INTERNAL_ERROR");
    assert.ok(error.requestId);
    assert.equal(error.error.includes("test failure"), false);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_documents").get()!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});
test("cursor pagination has no duplicates for timestamp ties and search escapes wildcards", async () => {
  const f = await fixture();
  try {
    for (const title of ["A", "B", "Literal % policy", "D"])
      await doc(f, undefined, f.aliceToken, { title });
    const first = await (await req(f, "/api/documents?limit=2")).json();
    const second = await (
      await req(
        f,
        `/api/documents?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json();
    assert.equal(
      new Set([...first.documents, ...second.documents].map((d: any) => d.id))
        .size,
      4,
    );
    assert.equal(second.nextCursor, null);
    const search = await (await req(f, "/api/documents?q=%25")).json();
    assert.equal(search.documents.length, 1);
    assert.equal((await req(f, "/api/documents?cursor=invalid")).status, 400);
    assert.equal((await req(f, "/api/documents?limit=101")).status, 400);
  } finally {
    f.sqlite.close();
  }
});
test("document provenance and review evidence are protected at the database level", async () => {
  const f = await fixture();
  try {
    const { id, review } = await ready(f);
    assert.throws(
      () =>
        f.sqlite
          .prepare("UPDATE support_documents SET content=? WHERE id=?")
          .run("replacement", id),
      /new document version/,
    );
    assert.throws(
      () =>
        f.sqlite
          .prepare("UPDATE support_reviews SET review_json=? WHERE id=?")
          .run("{}", review),
      /immutable/,
    );
  } finally {
    f.sqlite.close();
  }
});
test("revoke sessions invalidates both device tokens", async () => {
  const f = await fixture();
  try {
    const { createSession } = await import("../apps/api/src/auth.ts");
    const second = await createSession(f.env.DB, f.alice);
    assert.equal(
      (await req(f, "/api/auth/revoke-sessions", f.aliceToken, {})).status,
      200,
    );
    for (const token of [f.aliceToken, second])
      assert.equal((await req(f, "/api/auth/me", token)).status, 401);
  } finally {
    f.sqlite.close();
  }
});
test("migration preserves existing users, approved policies and historical review evidence", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const n of ["0001_existing_auth.sql", "0002_support_review.sql"])
      sqlite.exec(
        readFileSync(
          new URL(`../apps/api/migrations/${n}`, import.meta.url),
          "utf8",
        ),
      );
    const user = crypto.randomUUID(),
      id = crypto.randomUUID(),
      review = crypto.randomUUID();
    sqlite
      .prepare(
        "INSERT INTO users(id,email,password_hash,salt) VALUES(?,'legacy@test.example','hash','salt')",
      )
      .run(user);
    sqlite
      .prepare(
        "INSERT INTO support_documents(id,user_id,title,version,content,content_hash,status,approved_at) VALUES(?,?,'Legacy','v1',?,'fingerprint','approved','2026-01-01')",
      )
      .run(id, user, text);
    const payload = JSON.stringify({
      status: "ready_for_review",
      documents: [{ id }],
      receipts: [{ quote: text }],
    });
    sqlite
      .prepare(
        "INSERT INTO support_reviews(id,user_id,draft_text,review_json) VALUES(?,?,?,?)",
      )
      .run(review, user, text, payload);
    sqlite.exec(
      readFileSync(
        new URL("../apps/api/migrations/0003_workspaces.sql", import.meta.url),
        "utf8",
      ),
    );
    const d = sqlite
      .prepare("SELECT * FROM support_documents WHERE id=?")
      .get(id)!;
    assert.equal(d.workspace_id, user);
    assert.equal(d.content_hash, "fingerprint");
    assert.equal(d.approved_by, user);
    const r = sqlite
      .prepare("SELECT * FROM support_reviews WHERE id=?")
      .get(review)!;
    assert.equal(r.workspace_id, user);
    assert.equal(r.review_json, payload);
    assert.equal(r.status, "ready_for_review");
    assert.equal(
      sqlite
        .prepare("SELECT role FROM workspace_members WHERE user_id=?")
        .get(user)!.role,
      "owner",
    );
  } finally {
    sqlite.close();
  }
});

test("new account passwords, duplicate signup and hashed session cookies are validated", async () => {
  const f = await fixture();
  try {
    const signup = (password: string) =>
      req(f, "/api/auth/signup", f.aliceToken, {
        email: "enterprise@example.test",
        password,
      });
    assert.equal((await signup("short-pass")).status, 400);
    const response = await signup("long-pilot-password");
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
    assert.match(cookie, /Max-Age=43200/);
    assert.equal((await signup("long-pilot-password")).status, 409);
    const token = cookie.match(/__Host-veriq_session=([^;]+)/)![1];
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT token_hash FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)",
        )
        .get("enterprise@example.test")!.token_hash === token,
      false,
    );
    const bad = await req(f, "/api/auth/login", f.aliceToken, {
      email: "enterprise@example.test",
      password: "wrong-password",
    });
    assert.equal(bad.status, 401);
    const good = await req(f, "/api/auth/login", f.aliceToken, {
      email: "enterprise@example.test",
      password: "long-pilot-password",
    });
    assert.equal(good.status, 200);
  } finally {
    f.sqlite.close();
  }
});
test("auth rate limits are atomic under concurrent requests", async () => {
  const f = await fixture();
  try {
    const { rateLimit } = await import("../apps/api/src/http.ts");
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rateLimit(f.env.DB, "concurrent-auth-ip", 10, 60),
      ),
    );
    assert.equal(results.filter(Boolean).length, 10);
    assert.equal(
      f.sqlite
        .prepare("SELECT count FROM request_limits WHERE key=?")
        .get("concurrent-auth-ip")!.count,
      10,
    );
  } finally {
    f.sqlite.close();
  }
});

test("a reclaimed lease fences the older worker from saving a second review", async () => {
  const f = await fixture();
  try {
    const id = await doc(f);
    await req(f, `/api/documents/${id}/approve`, f.aliceToken, {});
    const body = { draft: text, documentIds: [id] },
      key = "reclaimed-running-request";
    let calls = 0,
      secondId = "";
    f.env.AI = {
      async run(model, input) {
        calls++;
        if (calls === 1) {
          f.sqlite
            .prepare("UPDATE review_requests SET expires_at=0 WHERE key=?")
            .run(key);
          const second = await req(
            f,
            "/api/reviews",
            f.aliceToken,
            body,
            undefined,
            key,
          );
          assert.equal(second.status, 201);
          secondId = (await second.json()).id;
        }
        return fakeAI().run(model, input);
      },
    };
    assert.equal(
      (await req(f, "/api/reviews", f.aliceToken, body, undefined, key)).status,
      409,
    );
    const replay = await (
      await req(f, "/api/reviews", f.aliceToken, body, undefined, key)
    ).json();
    assert.equal(replay.id, secondId);
    assert.equal(calls, 2);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get()!.n,
      1,
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action='review.created'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.sqlite.close();
  }
});
