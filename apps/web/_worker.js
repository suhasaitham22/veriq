/** Keep browser authentication on the Pages origin; the API cookie is never third-party. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set(
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
      );
      if (url.pathname === "/app.html" || url.pathname === "/login.html")
        response.headers.set("cache-control", "no-store");
      return response;
    }
    // This is deployment configuration, never an input supplied by the browser.
    const origin = new URL(
      env.API_ORIGIN || "https://veriq-api.suhasaitham22.workers.dev",
    ).origin;
    const target = `${origin}${url.pathname}${url.search}`;
    try {
      return await fetch(new Request(target, request));
    } catch {
      return Response.json(
        { error: "Review API is unavailable. Please retry." },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
  },
};
