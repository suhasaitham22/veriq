import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/web/_worker.js";

test("Pages proxy preserves authenticated body, method, query and Set-Cookie on the first-party origin", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (request: Request | URL | string) => {
    assert.ok(request instanceof Request);
    assert.equal(request.url, "https://api.example.test/api/auth/login?next=review");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("cookie"), "veriq_session=token");
    assert.equal(request.headers.get("origin"), "https://web.example.test");
    assert.equal(await request.text(), '{"email":"alice@example.test"}');
    return new Response('{"ok":true}', { headers: { "set-cookie": "veriq_session=new; HttpOnly; Secure; Path=/" } });
  };
  try {
    const response = await worker.fetch(new Request("https://web.example.test/api/auth/login?next=review", {
      method: "POST", headers: { cookie: "veriq_session=token", origin: "https://web.example.test" }, body: '{"email":"alice@example.test"}',
    }), { API_ORIGIN: "https://api.example.test", ASSETS: { fetch() { throw new Error("Static fallback was used"); } } });
    assert.equal(response.headers.get("set-cookie"), "veriq_session=new; HttpOnly; Secure; Path=/");
    assert.equal(await response.text(), '{"ok":true}');
  } finally { globalThis.fetch = original; }
});
test("Pages proxy serves ordinary assets without forwarding to the API", async () => {
  let called = false;
  const response = await worker.fetch(new Request("https://web.example.test/app.html"), { ASSETS: { async fetch() { called = true; return new Response("dashboard"); } } });
  assert.equal(called, true); assert.equal(await response.text(), "dashboard");
});
test("proxy connection failure returns a non-cacheable error", async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error("unavailable"); };
  try {
    const response = await worker.fetch(new Request("https://web.example.test/api/reviews"), {});
    assert.equal(response.status, 502); assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = original; }
});
