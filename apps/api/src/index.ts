/** Private support-draft review API. Every library and review belongs to an account. */
import { InputError, LIMITS, reviewDraft, sha256, splitStatements } from "./pipeline.ts";
import type { AIClient, ApprovedDocument } from "./pipeline.ts";
import {
  hashPassword, newSalt, newUserId, verifyPassword, isValidEmail, isValidPassword,
  createSession, getSessionUser, destroySession, sessionCookie, clearSessionCookie,
} from "./auth.ts";

export interface Env { AI: AIClient; DB: D1Database; CACHE: KVNamespace; WEB_ORIGIN?: string }
const DAILY_CAP = 50;
const MAX_BODY_BYTES = 100_000;
interface DocumentRow {
  id: string; title: string; version: string; content: string; content_hash: string;
  source_url: string | null; status: "draft" | "approved" | "archived";
  created_at: string; approved_at: string | null;
}

function origins(env: Env): string[] {
  return [env.WEB_ORIGIN ?? "https://veriq-1q9.pages.dev"];
}
function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    ...(origins(env).includes(origin) ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-credentials": "true", "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type", vary: "Origin", "cache-control": "no-store",
  };
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new InputError("Send application/json.");
  const reader = req.body?.getReader();
  if (!reader) throw new InputError("A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new InputError("Request body is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new InputError("Invalid JSON body."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("Send a JSON object.");
  return parsed as Record<string, unknown>;
}
async function rateLimit(kv: KVNamespace, key: string, limit: number, seconds: number): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / seconds);
  const k = `rl:${key}:${window}`;
  const used = Number(await kv.get(k) ?? 0);
  if (used >= limit) return false;
  await kv.put(k, String(used + 1), { expirationTtl: seconds + 5 });
  return true;
}
async function dailyQuota(db: D1Database, userId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.prepare(
    `INSERT INTO usage (ip, day, count) VALUES (?, ?, 1)
     ON CONFLICT (ip, day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`
  ).bind(`support:${userId}`, day, DAILY_CAP).first();
  return !!result;
}
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new InputError(`${name} must be 1–${max} characters.`);
  return value.trim();
}
function documentInput(body: Record<string, unknown>) {
  const title = requiredString(body.title, "Title", 120);
  const version = requiredString(body.version, "Version", 60);
  const content = requiredString(body.content, "Document text", LIMITS.document);
  let sourceUrl: string | null = null;
  if (body.sourceUrl !== undefined && body.sourceUrl !== null && body.sourceUrl !== "") {
    const value = requiredString(body.sourceUrl, "Source URL", 2000);
    let url: URL;
    try { url = new URL(value); } catch { throw new InputError("Source URL must be an HTTP or HTTPS link."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new InputError("Source URL must be an HTTP or HTTPS link without credentials.");
    sourceUrl = url.href;
  }
  return { title, version, content, sourceUrl };
}
function snapshot(row: DocumentRow): ApprovedDocument {
  return { id: row.id, title: row.title, version: row.version, content: row.content,
    contentHash: row.content_hash, sourceUrl: row.source_url };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = cors(req, env);
    const origin = req.headers.get("origin");
    if (origin && !origins(env).includes(origin)) return json({ error: "Origin is not allowed." }, 403, headers);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, service: "veriq-api", v: 3, mode: "support_review" }, 200, headers);
      const authAction = url.pathname.match(/^\/api\/auth\/(signup|login)$/)?.[1];
      if (authAction && req.method === "POST") {
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        if (!(await rateLimit(env.CACHE, `auth:${ip}`, 10, 60))) return json({ error: "Too many attempts." }, 429, headers);
        const body = await readBody(req);
        if (typeof body.email !== "string" || !isValidEmail(body.email)) throw new InputError("Invalid email.");
        if (typeof body.password !== "string" || !isValidPassword(body.password)) throw new InputError("Password must be 8–128 characters.");
        const email = body.email.toLowerCase();
        const row = await env.DB.prepare("SELECT id, email, password_hash, salt FROM users WHERE email = ?").bind(email)
          .first<{ id: string; email: string; password_hash: string; salt: string }>();
        if (authAction === "signup") {
          if (row) return json({ error: "Email already registered." }, 409, headers);
          const salt = newSalt();
          const id = newUserId();
          await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
            .bind(id, email, await hashPassword(body.password, salt), salt).run();
          const token = await createSession(env.DB, id);
          return json({ user: { id, email } }, 201, { ...headers, "set-cookie": sessionCookie(token) });
        }
        if (!row || !(await verifyPassword(body.password, row.salt, row.password_hash))) return json({ error: "Invalid credentials." }, 401, headers);
        return json({ user: { id: row.id, email } }, 200, { ...headers, "set-cookie": sessionCookie(await createSession(env.DB, row.id)) });
      }
      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        await destroySession(req, env.DB);
        return json({ ok: true }, 200, { ...headers, "set-cookie": clearSessionCookie() });
      }
      // Remove the public share route: old receipts may contain private drafts.
      if (/^\/api\/r\//.test(url.pathname) || /^\/api\/verify(?:\/|$)/.test(url.pathname)) {
        return json({ error: "Public verification has been retired. Use authenticated /api/reviews with approved documents." }, 410, headers);
      }
      const user = await getSessionUser(req, env.DB);
      if (!user) return json({ error: "Unauthorized." }, 401, headers);
      if (url.pathname === "/api/auth/me" && req.method === "GET") return json({ user }, 200, headers);

      if (url.pathname === "/api/documents" && req.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM support_documents WHERE user_id = ? ORDER BY created_at DESC, id").bind(user.id).all<DocumentRow>();
        return json({ documents: rows.results }, 200, headers);
      }
      if (url.pathname === "/api/documents" && req.method === "POST") {
        const input = documentInput(await readBody(req));
        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM support_documents WHERE user_id = ?").bind(user.id).first<{ count: number }>();
        if ((count?.count ?? 0) >= 50) throw new InputError("This pilot library supports 50 document versions per account.");
        const exists = await env.DB.prepare("SELECT id FROM support_documents WHERE user_id = ? AND title = ? AND version = ?")
          .bind(user.id, input.title, input.version).first();
        if (exists) return json({ error: "That title and version already exist. Create a new version to change its text." }, 409, headers);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO support_documents (id, user_id, title, version, content, content_hash, source_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
        ).bind(id, user.id, input.title, input.version, input.content, await sha256(input.content), input.sourceUrl).run();
        return json({ id, status: "draft" }, 201, headers);
      }
      const documentAction = url.pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/(approve|archive)$/);
      if (documentAction && req.method === "POST") {
        const row = await env.DB.prepare("SELECT * FROM support_documents WHERE id = ? AND user_id = ?").bind(documentAction[1], user.id).first<DocumentRow>();
        if (!row) return json({ error: "Document not found." }, 404, headers);
        if (documentAction[2] === "approve") {
          if (row.status !== "draft") return json({ error: "Only draft documents can be approved. Archived documents need a new version." }, 409, headers);
          const updated = await env.DB.prepare("UPDATE support_documents SET status = 'approved', approved_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'draft'").bind(row.id, user.id).run();
          if (!updated.meta.changes) return json({ error: "Document status changed. Refresh the library." }, 409, headers);
        } else {
          await env.DB.prepare("UPDATE support_documents SET status = 'archived' WHERE id = ? AND user_id = ?").bind(row.id, user.id).run();
        }
        return json({ id: row.id, status: documentAction[2] === "approve" ? "approved" : "archived" }, 200, headers);
      }
      if (url.pathname === "/api/reviews" && req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.draft !== "string") throw new InputError("A draft string is required.");
        splitStatements(body.draft);
        if (!Array.isArray(body.documentIds) || body.documentIds.length < 1 || body.documentIds.length > LIMITS.documents
          || body.documentIds.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
          || new Set(body.documentIds).size !== body.documentIds.length) throw new InputError(`Select 1–${LIMITS.documents} distinct approved document IDs.`);
        const ids = body.documentIds as string[];
        const placeholders = ids.map(() => "?").join(",");
        const query = `SELECT * FROM support_documents WHERE user_id = ? AND status = 'approved' AND id IN (${placeholders}) ORDER BY id`;
        const rows = await env.DB.prepare(query).bind(user.id, ...ids).all<DocumentRow>();
        if (rows.results.length !== ids.length) return json({ error: "Selected documents are unavailable or not approved in your library." }, 400, headers);
        const documents = rows.results.map(snapshot);
        if (documents.reduce((total, d) => total + d.content.length, 0) > LIMITS.corpus) throw new InputError("Selected documents exceed the review budget. Select a smaller policy set.");
        if (!(await dailyQuota(env.DB, user.id))) return json({ error: "Daily review limit reached." }, 429, headers);
        const review = await reviewDraft(body.draft, documents, env.AI);
        // If a policy was archived while AI was running, require a fresh review.
        const current = await env.DB.prepare(query).bind(user.id, ...ids).all<DocumentRow>();
        if (current.results.length !== ids.length) return json({ error: "Document approval changed during review. Select current documents and retry." }, 409, headers);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO support_reviews (id, user_id, draft_text, review_json) VALUES (?, ?, ?, ?)")
          .bind(id, user.id, body.draft, JSON.stringify(review)).run();
        return json({ id, review }, 201, headers);
      }
      if (url.pathname === "/api/reviews" && req.method === "GET") {
        const rows = await env.DB.prepare("SELECT id, substr(draft_text, 1, 120) AS preview, created_at FROM support_reviews WHERE user_id = ? ORDER BY created_at DESC, id LIMIT 30")
          .bind(user.id).all();
        return json({ reviews: rows.results }, 200, headers);
      }
      const reviewId = url.pathname.match(/^\/api\/reviews\/([a-f0-9-]{36})$/)?.[1];
      if (reviewId && req.method === "GET") {
        const row = await env.DB.prepare("SELECT draft_text, review_json, created_at FROM support_reviews WHERE id = ? AND user_id = ?")
          .bind(reviewId, user.id).first<{ draft_text: string; review_json: string; created_at: string }>();
        if (!row) return json({ error: "Review not found." }, 404, headers);
        return json({ id: reviewId, draft: row.draft_text, review: JSON.parse(row.review_json), created_at: row.created_at }, 200, headers);
      }
      return json({ error: "Not found." }, 404, headers);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, 400, headers);
      return json({ error: "Request could not be completed. Please retry." }, 500, headers);
    }
  },
};
