/** Keep browser authentication on the Pages origin; the API cookie is never third-party. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    // This is deployment configuration, never an input supplied by the browser.
    const origin = new URL(env.API_ORIGIN || "https://veriq-api.suhasaitham22.workers.dev").origin;
    const target = `${origin}${url.pathname}${url.search}`;
    try {
      return await fetch(new Request(target, request));
    } catch {
      return Response.json({ error: "Review API is unavailable. Please retry." }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  },
};
