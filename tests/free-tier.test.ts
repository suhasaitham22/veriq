import { test } from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api/src/index.ts";
import { fixture, mediaBucket } from "./helpers.ts";

test("AI fails closed without an exact Free-plan attestation, before model calls or quota reservations", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      throw new Error("Must not call a model");
    },
  });
  try {
    for (const value of [undefined, "false", "TRUE", "paid"]) {
      f.env.WORKERS_FREE_PLAN_CONFIRMED = value;
      for (const path of ["/api/chat", "/api/reviews"]) {
        const response = await api.fetch(
          new Request(`https://veriq-api.example.test${path}`, {
            method: "POST",
            headers: {
              cookie: `veriq_session=${f.aliceToken}`,
              "content-type": "application/json",
              "idempotency-key": "free-policy-test-0001",
            },
            body: "{}",
          }),
          f.env,
        );
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "FREE_PLAN_UNCONFIRMED");
      }
    }
    assert.equal(calls, 0);
    for (const table of [
      "request_limits",
      "review_requests",
      "chat_turns",
      "support_reviews",
    ])
      assert.equal(
        f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
        0,
      );
  } finally {
    f.sqlite.close();
  }
});

test("pausing AI retains authenticated documents, bookmarks and private history access", async () => {
  const f = await fixture();
  delete f.env.WORKERS_FREE_PLAN_CONFIRMED;
  try {
    for (const [path, body] of [
      [
        "/api/documents",
        {
          title: "Refund",
          version: "v1",
          content: "Refund requests must be submitted within 30 days.",
        },
      ],
      [
        "/api/evidence/links",
        {
          title: "Approved help centre",
          url: "https://example.test/help",
          note: "Inspect the approved refund policy here.",
        },
      ],
    ] as const) {
      const response = await api.fetch(
        new Request(`https://veriq-api.example.test${path}`, {
          method: "POST",
          headers: {
            cookie: `veriq_session=${f.aliceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        f.env,
      );
      assert.equal(response.status, 201, JSON.stringify(await response.json()));
    }
    for (const path of [
      "/api/documents",
      "/api/evidence",
      "/api/reviews",
      "/api/chat",
    ]) {
      assert.equal(
        (
          await api.fetch(
            new Request(`https://veriq-api.example.test${path}`, {
              headers: { cookie: `veriq_session=${f.aliceToken}` },
            }),
            f.env,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await api.fetch(
            new Request(`https://veriq-api.example.test${path}`),
            f.env,
          )
        ).status,
        401,
      );
    }
  } finally {
    f.sqlite.close();
  }
});

test("remote media fails closed even with a bucket and local-demo flag; no storage IO or quota use", async () => {
  const f = await fixture();
  let operations = 0;
  f.env.MEDIA = new Proxy(mediaBucket().bucket, {
    get() {
      operations++;
      throw new Error("Remote R2 must not be used");
    },
  });
  try {
    for (const origin of [
      "https://veriq-api.example.test",
      "http://veriq-api.example.test",
      "https://localhost",
      "http://localhost.example.test",
    ]) {
      const health = await (
        await api.fetch(new Request(`${origin}/api/health`), f.env)
      ).json();
      assert.equal(health.mediaAvailable, false);
      const response = await api.fetch(
        new Request(`${origin}/api/evidence/media`, {
          method: "POST",
          headers: { cookie: `veriq_session=${f.aliceToken}` },
          body: "No upload should be read",
        }),
        f.env,
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "MEDIA_UNAVAILABLE");
    }
    assert.equal(operations, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM request_limits").get()!.n,
      0,
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM evidence_items").get()!.n,
      0,
    );
  } finally {
    f.sqlite.close();
  }
});

test("health reports AI and local-media capabilities independently; local media requires explicit opt-in", async () => {
  const f = await fixture();
  f.env.MEDIA = mediaBucket().bucket;
  try {
    for (const origin of [
      "http://localhost",
      "http://127.0.0.1",
      "http://[::1]",
    ]) {
      let health = await (
        await api.fetch(new Request(`${origin}/api/health`), f.env)
      ).json();
      assert.equal(health.v, 8);
      assert.equal(health.billingMode, "free_only");
      assert.equal(health.aiAvailable, true);
      assert.equal(health.mediaAvailable, true);
      delete f.env.LOCAL_MEDIA_DEMO;
      health = await (
        await api.fetch(new Request(`${origin}/api/health`), f.env)
      ).json();
      assert.equal(health.mediaAvailable, false);
      f.env.LOCAL_MEDIA_DEMO = "true";
    }
  } finally {
    f.sqlite.close();
  }
});
