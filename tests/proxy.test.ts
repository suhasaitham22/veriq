import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import worker from "../apps/web/_worker.js";

async function listen(server: Server) {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
}
function port(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port.");
  return address.port;
}
async function close(server: Server) {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(resolve);
  await promise;
}

test("Pages proxy preserves authenticated body, method, query and Set-Cookie on the first-party origin", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (request: Request | URL | string) => {
    assert.ok(request instanceof Request);
    assert.equal(request.url, "https://api.example.test/api/auth/login?next=review");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("cookie"), "__Host-veriq_session=token");
    assert.equal(request.headers.get("origin"), "https://web.example.test");
    assert.equal(await request.text(), '{"email":"alice@example.test"}');
    return new Response('{"ok":true}', { headers: { "set-cookie": "__Host-veriq_session=new; HttpOnly; Secure; Path=/" } });
  };
  try {
    const response = await worker.fetch(
      new Request("https://web.example.test/api/auth/login?next=review", {
        method: "POST",
        headers: { cookie: "__Host-veriq_session=token", origin: "https://web.example.test" },
        body: '{"email":"alice@example.test"}',
      }),
      { API_ORIGIN: "https://api.example.test", ASSETS: { fetch() { throw new Error("Static fallback was used"); } } },
    );
    assert.equal(response.headers.get("set-cookie"), "__Host-veriq_session=new; HttpOnly; Secure; Path=/");
    assert.equal(await response.text(), '{"ok":true}');
  } finally { globalThis.fetch = original; }
});

test("Pages proxy serves ordinary assets without forwarding to the API", async () => {
  let called = false;
  const response = await worker.fetch(new Request("https://web.example.test/app.html"), {
    ASSETS: { async fetch() { called = true; return new Response("dashboard"); } },
  });
  assert.equal(called, true);
  assert.equal(await response.text(), "dashboard");
  assert.match(response.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("missing API_ORIGIN fails closed without forwarding or caching", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  try {
    const response = await worker.fetch(new Request("https://web.example.test/api/reviews"), {});
    assert.equal(response.status, 503);
    assert.equal(called, false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = original; }
});

test("invalid API_ORIGIN fails closed without forwarding", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  try {
    const response = await worker.fetch(new Request("https://web.example.test/api/reviews"), { API_ORIGIN: "https://api.example.test/path" });
    assert.equal(response.status, 503);
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test("proxy connection failure returns a non-cacheable error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unavailable"); };
  try {
    const response = await worker.fetch(new Request("https://web.example.test/api/reviews"), { API_ORIGIN: "https://api.example.test" });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = original; }
});

test("proxy refuses upstream redirects", async () => {
  let destinationCalled = false;
  const destination = createServer((_request, response) => {
    destinationCalled = true;
    response.end("should not receive");
  });
  await listen(destination);
  const destinationOrigin = `http://127.0.0.1:${port(destination)}`;
  const upstream = createServer((_request, response) => {
    response.statusCode = 307;
    response.setHeader("location", `${destinationOrigin}/sink`);
    response.end();
  });
  await listen(upstream);
  try {
    const upstreamOrigin = `http://127.0.0.1:${port(upstream)}`;
    const response = await worker.fetch(
      new Request(`${upstreamOrigin}/api/auth/login`, {
        method: "POST",
        body: "synthetic-login-body",
      }),
      { API_ORIGIN: upstreamOrigin },
    );
    assert.equal(response.status, 502);
    assert.equal(destinationCalled, false);
  } finally {
    await close(upstream);
    await close(destination);
  }
});
