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
    const configured = env.API_ORIGIN;
    let origin;
    try {
      if (!configured) throw new Error("API_ORIGIN is required");
      const candidate = new URL(configured);
      const loopback =
        candidate.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(candidate.hostname);
      if (
        (candidate.protocol !== "https:" && !loopback) ||
        candidate.username ||
        candidate.password ||
        candidate.pathname !== "/" ||
        candidate.search ||
        candidate.hash
      )
        throw new Error("API_ORIGIN must be a canonical HTTPS origin");
      origin = candidate.origin;
    } catch {
      return Response.json(
        { error: "Review API is not configured for this deployment." },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const target = `${origin}${url.pathname}${url.search}`;
    try {
      return await fetch(new Request(target, request), { redirect: "error" });
    } catch {
      return Response.json(
        { error: "Review API is unavailable. Please retry." },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
  },
};
