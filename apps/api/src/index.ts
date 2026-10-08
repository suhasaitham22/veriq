/** Workspace-scoped support review API. */
import { InputError } from "./pipeline.ts";
import type { AIClient } from "./pipeline.ts";
import { getSessionUser } from "./auth.ts";
import { authRoutes } from "./auth-routes.ts";
import { HttpError, json } from "./http.ts";
import { workspaceRoutes, resolveScope } from "./workspaces.ts";
import { documentRoutes } from "./documents.ts";
import { reviewRoutes } from "./reviews.ts";
import { pilotRoutes } from "./pilot.ts";
import { evidenceRoutes } from "./evidence.ts";
import { chatRoutes } from "./chat.ts";
export interface Env {
  MEDIA?: R2Bucket;
  AI: AIClient;
  DB: D1Database;
  CACHE?: KVNamespace;
  WEB_ORIGIN?: string;
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url),
      origin = req.headers.get("origin"),
      allowed = env.WEB_ORIGIN ?? "https://veriq-1q9.pages.dev",
      requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      ...(origin === allowed ? { "access-control-allow-origin": allowed } : {}),
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, x-workspace-id, idempotency-key",
      "access-control-expose-headers": "x-request-id",
      vary: "Origin",
      "cache-control": "no-store",
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    };
    try {
      if (origin && origin !== allowed)
        throw new HttpError(403, "Origin is not allowed.", "ORIGIN_FORBIDDEN");
      if (
        req.method === "POST" &&
        req.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new HttpError(
          403,
          "Cross-site mutations are not allowed.",
          "ORIGIN_FORBIDDEN",
        );
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (req.method === "GET" && url.pathname === "/api/health")
        return json(
          {
            ok: true,
            service: "veriq-api",
            v: 6,
            mode: "support_review",
            features: [
              "workspaces",
              "pilot_feedback",
              "sample_demo",
              "evidence_store",
              "ai_chat",
            ],
            mediaAvailable: !!env.MEDIA,
          },
          200,
          headers,
        );
      if (
        /^\/api\/r\//.test(url.pathname) ||
        /^\/api\/verify(?:\/|$)/.test(url.pathname)
      )
        return json(
          {
            error:
              "Public verification is retired. Use authenticated workspace reviews.",
            code: "API_RETIRED",
            requestId,
          },
          410,
          headers,
        );
      const user = await getSessionUser(req, env.DB);
      const auth = await authRoutes(req, url, env.DB, user);
      if (auth)
        return json(auth.data, auth.status ?? 200, {
          ...headers,
          ...auth.headers,
        });
      if (!user)
        throw new HttpError(
          401,
          "Your session has expired. Sign in again.",
          "AUTH_REQUIRED",
        );
      const workspace = await workspaceRoutes(req, url, env.DB, user);
      if (workspace)
        return json(
          workspace,
          req.method === "POST" && url.pathname === "/api/workspaces"
            ? 201
            : 200,
          headers,
        );
      if (
        !/^\/api\/(documents|reviews|demo|feedback|evidence|chat)(?:\/|$)/.test(
          url.pathname,
        )
      )
        throw new HttpError(404, "Endpoint not found.", "NOT_FOUND");
      const scope = await resolveScope(
        env.DB,
        user,
        req.headers.get("x-workspace-id"),
      );
      const result =
        (await documentRoutes(req, url, scope)) ??
        (await reviewRoutes(req, url, scope, env.AI)) ??
        (await pilotRoutes(req, url, scope)) ??
        (await evidenceRoutes(req, url, scope, env.MEDIA)) ??
        (await chatRoutes(req, url, scope, env.AI));
      if (result instanceof Response) {
        const h = new Headers(result.headers);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        return new Response(result.body, { status: result.status, headers: h });
      }
      if (!result) throw new HttpError(404, "Endpoint not found.", "NOT_FOUND");
      const attachment: Record<string, string> =
        /^\/api\/reviews\/[a-f0-9-]{36}\/export$/.test(url.pathname)
          ? {
              "content-disposition": `attachment; filename="veriq-review-${url.pathname.split("/")[3]}.json"`,
            }
          : {};
      return json(
        result,
        req.method === "POST" &&
          [
            "/api/documents",
            "/api/reviews",
            "/api/feedback",
            "/api/evidence/links",
            "/api/evidence/media",
            "/api/chat",
          ].includes(url.pathname)
          ? 201
          : 200,
        { ...headers, ...attachment },
      );
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: error.message, code: error.code, requestId },
          error.status,
          {
            ...headers,
            ...(error.status === 429 ? { "retry-after": "60" } : {}),
          },
        );
      if (error instanceof InputError)
        return json(
          { error: error.message, code: "INPUT_INVALID", requestId },
          400,
          headers,
        );
      // No drafts, documents, cookies, emails or exception messages go to application logs.
      console.error(
        JSON.stringify({
          level: "error",
          event: "request.failed",
          requestId,
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
      return json(
        {
          error:
            "Request could not be completed. Retry or contact your administrator with the request ID.",
          code: "INTERNAL_ERROR",
          requestId,
        },
        500,
        headers,
      );
    }
  },
};
