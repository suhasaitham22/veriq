import { test } from "node:test";
import assert from "node:assert/strict";
import { requestJSON, requestBlob, RequestError } from "../apps/web/request.js";

test("JSON transport preserves cookies, retry key and bounded signal without automatic retries", async () => {
  let calls = 0;
  const result = await requestJSON(
    "https://example.test/api/chat",
    {
      method: "POST",
      headers: {
        "idempotency-key": "stable-key",
        "X-Workspace-ID": "workspace",
      },
      body: "draft",
    },
    async (url: string, options: RequestInit) => {
      calls++;
      assert.equal(url, "https://example.test/api/chat");
      assert.equal(options.credentials, "include");
      assert.equal(options.body, "draft");
      assert.equal(
        new Headers(options.headers).get("idempotency-key"),
        "stable-key",
      );
      assert.equal(options.signal!.aborted, false);
      return Response.json({ ok: true });
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test("structured API failures preserve status, request reference and Retry-After", async () => {
  await assert.rejects(
    requestJSON("https://example.test", {}, async () =>
      Response.json(
        {
          error: "Daily limit reached",
          code: "CHAT_LIMIT",
          requestId: "request-123",
        },
        { status: 429, headers: { "retry-after": "3600" } },
      ),
    ),
    (e: any) => {
      assert.ok(e instanceof RequestError);
      assert.equal(e.status, 429);
      assert.equal(e.code, "CHAT_LIMIT");
      assert.equal(e.retryAfter, 3600);
      assert.match(e.message, /Try again after/);
      return true;
    },
  );
  await assert.rejects(
    requestJSON("https://example.test", {}, async () =>
      Response.json(
        { error: "Service unavailable" },
        { status: 503, headers: { "x-request-id": "request-123" } },
      ),
    ),
    (e: any) => {
      assert.equal(e.requestId, "request-123");
      assert.match(e.message, /Reference: request-123/);
      return true;
    },
  );
});

test("response validation rejects HTML, broken JSON and non-object JSON without displaying page contents", async () => {
  for (const response of [
    new Response("<script>secret data</script>"),
    new Response('{"broken":', {
      headers: { "content-type": "application/json" },
    }),
    Response.json(null),
    Response.json([]),
  ])
    await assert.rejects(
      requestJSON("https://example.test", {}, async () => response),
      (e: any) => {
        assert.equal(e.code, "API_RESPONSE_INVALID");
        assert.doesNotMatch(e.message, /secret data/);
        return true;
      },
    );
});

test("network failure makes one attempt and distinguishes safe recovery from a possibly completed mutation", async () => {
  let calls = 0;
  const offline = async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  };
  const cases = [
    [{}, /connection recovers/],
    [{ method: "POST", body: "draft" }, /Check the saved records/],
    [
      {
        method: "POST",
        headers: { "idempotency-key": "stable-key" },
        body: "draft",
      },
      /Retry without changing/,
    ],
  ] as const;
  for (const [options, expected] of cases)
    await assert.rejects(
      requestJSON("https://example.test", options, offline),
      (e: any) => {
        assert.equal(e.code, "NETWORK_ERROR");
        assert.match(e.message, expected);
        return true;
      },
    );
  assert.equal(calls, 3);
});

test("deadline aborts a hanging request and warns that an idempotent mutation may have completed", async () => {
  let calls = 0;
  await assert.rejects(
    requestJSON(
      "https://example.test",
      {
        method: "POST",
        headers: { "idempotency-key": "stable-key" },
        timeoutMs: 10,
      },
      async (_url: string, options: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) =>
          options.signal!.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
            { once: true },
          ),
        );
      },
    ),
    (e: any) => {
      assert.equal(e.code, "REQUEST_TIMEOUT");
      assert.match(e.message, /may have completed/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("deadline covers stalled response bodies as well as response headers", async () => {
  await assert.rejects(
    requestJSON(
      "https://example.test",
      { timeoutMs: 10 },
      async (_url: string, options: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options.signal!.addEventListener(
                "abort",
                () => controller.error(options.signal!.reason),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
    (e: any) => {
      assert.equal(e.code, "REQUEST_TIMEOUT");
      return true;
    },
  );
});

test("file transport returns exact private bytes and surfaces authorization failures as typed errors", async () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  const blob = await requestBlob(
    "https://example.test/file",
    {},
    async () => new Response(bytes),
  );
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await assert.rejects(
    requestBlob("https://example.test/file", {}, async () =>
      Response.json(
        { error: "Sign in", code: "AUTH_REQUIRED" },
        { status: 401 },
      ),
    ),
    (e: any) => {
      assert.equal(e.status, 401);
      return true;
    },
  );
});
