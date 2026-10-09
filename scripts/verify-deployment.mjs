/** Read-only release check. Rejects SPA fallbacks, stale APIs and retired public routes. */
export async function verifyDeployment(baseUrl, fetcher = fetch) {
  const origin = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("Provide an HTTP(S) app URL without credentials.");
  async function get(path) {
    const response = await fetcher(new URL(path, origin), {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: { "cache-control": "no-cache" },
    });
    return response;
  }
  const response = await get("/api/health");
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new Error(
      "The app /api/health must return JSON. An HTML response usually means the Pages API proxy was not deployed.",
    );
  const health = await response.json();
  if (
    health.service !== "veriq-api" ||
    health.mode !== "support_review" ||
    health.v < 7 ||
    ![
      "workspaces",
      "pilot_feedback",
      "sample_demo",
      "evidence_store",
      "ai_chat",
      "free_tier_policy",
    ].every((f) => health.features?.includes(f))
  )
    throw new Error(
      "The API is an older release. Deploy the support-review API and web app together.",
    );
  if (
    health.billingMode !== "free_only" ||
    health.aiAvailable !== true ||
    health.mediaAvailable !== false
  )
    throw new Error(
      "Free-only demo is not ready: verify the Workers Free plan and enable AI, keeping production media disabled. Health reflects operator configuration; verify billing in Cloudflare separately.",
    );
  const auth = await get("/api/auth/me");
  if (
    auth.status !== 401 ||
    !auth.headers.get("content-type")?.includes("application/json") ||
    auth.headers.get("cache-control") !== "no-store"
  )
    throw new Error(
      "Unauthenticated private API access did not fail with non-cacheable JSON.",
    );
  const retired = await get("/api/r/11111111-1111-4111-8111-111111111111");
  if (retired.status !== 410)
    throw new Error(
      "Legacy public receipt routes are still active or the API proxy is missing.",
    );
  const page = await get("/app.html"),
    html = await page.text();
  if (
    page.status !== 200 ||
    !html.includes("workspace-select") ||
    !html.includes("feedback-dialog") ||
    !html.includes("demo-scenario") ||
    !html.includes("evidence-form") ||
    !html.includes("chat-form") ||
    !html.includes("billing-status")
  )
    throw new Error(
      "The deployed frontend does not contain this release’s workspace/demo/feedback interface.",
    );
  if (
    !page.headers.get("content-security-policy")?.includes("script-src 'self'")
  )
    throw new Error(
      "The frontend security headers are missing. Deploy the Pages worker as well as the static files.",
    );
  return {
    origin: origin.origin,
    apiVersion: health.v,
    features: health.features,
    billingMode: health.billingMode,
    aiAvailable: health.aiAvailable,
    mediaAvailable: !!health.mediaAvailable,
  };
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.argv[2]) {
    console.error(
      "Usage: npm run verify:deployment -- https://your-app.pages.dev",
    );
    process.exitCode = 1;
  } else
    try {
      console.log(
        "Release check passed:",
        JSON.stringify(await verifyDeployment(process.argv[2])),
      );
      console.log(
        "Next: sign in and run the sample scenarios with live AI before the company demo.",
      );
    } catch (error) {
      console.error("Release check failed:", error.message);
      process.exitCode = 1;
    }
}
