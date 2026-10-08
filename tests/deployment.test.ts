import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
const health = {
  ok: true,
  service: "veriq-api",
  mode: "support_review",
  v: 6,
  features: [
    "workspaces",
    "pilot_feedback",
    "sample_demo",
    "evidence_store",
    "ai_chat",
  ],
};
function responses(extra: any = {}) {
  return async (url: any) => {
    const path = new URL(url).pathname;
    if (path === "/api/health") return extra.health ?? Response.json(health);
    if (path === "/api/auth/me")
      return (
        extra.auth ??
        Response.json(
          { error: "Sign in" },
          { status: 401, headers: { "cache-control": "no-store" } },
        )
      );
    if (path.startsWith("/api/r/"))
      return (
        extra.receipt ?? Response.json({ error: "Retired" }, { status: 410 })
      );
    return new Response(
      "workspace-select feedback-dialog demo-scenario evidence-form chat-form",
      {
        headers: { "content-security-policy": "script-src 'self'" },
      },
    );
  };
}
test("release check validates the deployed API, private access, retired sharing and matching frontend", async () => {
  const result = await verifyDeployment(
    "https://demo.example.test",
    responses(),
  );
  assert.equal(result.apiVersion, 6);
});
test("release check rejects an HTML SPA fallback instead of treating HTTP 200 as success", async () => {
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ health: new Response("<html>old homepage</html>") }),
    ),
    /proxy was not deployed/,
  );
});
test("release check rejects an old API and publicly accessible private routes", async () => {
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ health: Response.json({ v: 2 }) }),
    ),
    /older release/,
  );
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ auth: Response.json({ ok: true }) }),
    ),
    /private API access/,
  );
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ receipt: Response.json({ receipt: "public" }) }),
    ),
    /public receipt/,
  );
});
