import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
const health = {
  ok: true,
  service: "veriq-api",
  mode: "support_review",
  v: 9,
  billingMode: "free_only",
  aiAvailable: true,
  mfaAvailable: true,
  mediaAvailable: false,
  features: [
    "workspaces",
    "pilot_feedback",
    "sample_demo",
    "evidence_store",
    "ai_chat",
    "free_tier_policy",
    "usage_status",
    "invitation_admission",
    "offline_recovery",
    "workspace_lifecycle",
    "full_policy_scope",
    "shared_ai_capacity",
    "totp_mfa",
  ],
};
function responses(extra: any = {}) {
  return async (url: any) => {
    const path = new URL(url).pathname;
    if (path === "/api/health") return extra.health ?? Response.json(health);
    if (path === "/request.js")
      return (
        extra.transport ??
        new Response(
          "export function requestJSON() { return new AbortController(); }",
          { headers: { "content-type": "text/javascript" } },
        )
      );
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
      "workspace-select feedback-dialog demo-scenario evidence-form chat-form billing-status usage-status",
      {
        headers: { "content-security-policy": "script-src 'self'" },
      },
    );
  };
}
test("release check rejects a missing JavaScript module hidden by an HTML fallback", async () => {
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ transport: new Response("<html>old app</html>") }),
    ),
  );
});
test("release check rejects an HTML SPA fallback instead of treating HTTP 200 as success", async () => {
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ health: new Response("<html>old homepage</html>") }),
    ),
  );
});
test("release check rejects an old API and publicly accessible private routes", async () => {
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ health: Response.json({ v: 2 }) }),
    ),
  );
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ auth: Response.json({ ok: true }) }),
    ),
  );
  await assert.rejects(
    verifyDeployment(
      "https://demo.example.test",
      responses({ receipt: Response.json({ receipt: "public" }) }),
    ),
  );
});
test("release check refuses a company demo with paused AI or production media enabled", async () => {
  for (const patch of [
    { aiAvailable: false },
    { mediaAvailable: true },
    { billingMode: "paid" },
  ])
    await assert.rejects(
      verifyDeployment(
        "https://demo.example.test",
        responses({ health: Response.json({ ...health, ...patch }) }),
      ),
    );
});
