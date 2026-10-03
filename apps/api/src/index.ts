/**
 * index.ts — Veriq API.
 *
 * Public:  GET  /api/health, GET /api/r/:id (shareable receipt)
 * Auth:    POST /api/auth/signup, /api/auth/login, /api/auth/logout, GET /api/auth/me
 * Private: POST /api/verify, GET /api/verify/history
 *
 * Quotas: auth endpoints 10 req/min/IP; verify 50/day per user (free-tier hygiene).
 */
import { verify } from "./pipeline";
import {
  hashPassword, newSalt, newUserId, verifyPassword, isValidEmail, isValidPassword,
  createSession, getSessionUser, destroySession, sessionCookie, clearSessionCookie,
} from "./auth";

interface Env {
  AI: Ai;
  DB: D1Database;
  CACHE: KVNamespace;
  SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
  WEB_ORIGIN?: string;
}

const VERIFY_DAILY_CAP = 50;

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = [env.WEB_ORIGIN ?? "", "https://veriq-1q9.pages.dev"].filter(Boolean);
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] ?? "",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Simple fixed-window rate limit in D1. Returns true if allowed. */
async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const k = `${key}:${windowStart}`;
  const row = await db.prepare("SELECT count FROM usage WHERE ip = ? AND day = ?").bind(k, "rl").first<{ count: number }>();
  const used = row?.count ?? 0;
  if (used >= limit) return false;
  await db.prepare(
    "INSERT INTO usage (ip, day, count) VALUES (?, 'rl', 1) ON CONFLICT (ip, day) DO UPDATE SET count = count + 1"
  ).bind(k).run();
  return true;
}

async function dailyQuota(db: D1Database, userId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const k = `verify:${userId}`;
  const row = await db.prepare("SELECT count FROM usage WHERE ip = ? AND day = ?").bind(k, day).first<{ count: number }>();
  if ((row?.count ?? 0) >= VERIFY_DAILY_CAP) return false;
  await db.prepare(
    "INSERT INTO usage (ip, day, count) VALUES (?, ?, 1) ON CONFLICT (ip, day) DO UPDATE SET count = count + 1"
  ).bind(k, day).run();
  return true;
}

function hashStr(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { headers });
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "veriq-api", v: 2 }, 200, headers);
    }

    if (url.pathname === "/api/auth/signup" && req.method === "POST") {
      if (!(await rateLimit(env.DB, `auth:${ip}`, 10, 60))) return json({ error: "too many attempts" }, 429, headers);
      const { email, password } = await req.json() as { email?: string; password?: string };
      if (!email || !isValidEmail(email)) return json({ error: "invalid email" }, 400, headers);
      if (!password || !isValidPassword(password)) return json({ error: "password must be 8–128 characters" }, 400, headers);
      const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
      if (exists) return json({ error: "email already registered" }, 409, headers);
      const salt = newSalt();
      const id = newUserId();
      await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
        .bind(id, email.toLowerCase(), await hashPassword(password, salt), salt).run();
      const token = await createSession(env.DB, id);
      return json({ user: { id, email: email.toLowerCase() } }, 201,
        { ...headers, "set-cookie": sessionCookie(token) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!(await rateLimit(env.DB, `auth:${ip}`, 10, 60))) return json({ error: "too many attempts" }, 429, headers);
      const { email, password } = await req.json() as { email?: string; password?: string };
      if (!email || !password) return json({ error: "email and password required" }, 400, headers);
      const row = await env.DB.prepare("SELECT id, email, password_hash, salt FROM users WHERE email = ?")
        .bind(email.toLowerCase()).first<{ id: string; email: string; password_hash: string; salt: string }>();
      const ok = row ? await verifyPassword(password, row.salt, row.password_hash) : false;
      if (!row || !ok) return json({ error: "invalid credentials" }, 401, headers);
      const token = await createSession(env.DB, row.id);
      return json({ user: { id: row.id, email: row.email } }, 200,
        { ...headers, "set-cookie": sessionCookie(token) });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      await destroySession(req, env.DB);
      return json({ ok: true }, 200, { ...headers, "set-cookie": clearSessionCookie() });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const user = await getSessionUser(req, env.DB);
      if (!user) return json({ error: "unauthorized" }, 401, headers);
      return json({ user }, 200, headers);
    }

    const rMatch = url.pathname.match(/^\/api\/r\/([a-f0-9-]{36})$/);
    if (rMatch && req.method === "GET") {
      const row = await env.DB.prepare("SELECT input_text, receipts_json, created_at FROM receipts WHERE id = ?")
        .bind(rMatch[1]).first<{ input_text: string; receipts_json: string; created_at: string }>();
      if (!row) return json({ error: "not found" }, 404, headers);
      return json({ id: rMatch[1], input: row.input_text, receipts: JSON.parse(row.receipts_json), created_at: row.created_at }, 200, headers);
    }

    const user = await getSessionUser(req, env.DB);
    if (!user) return json({ error: "unauthorized" }, 401, headers);

    if (url.pathname === "/api/verify" && req.method === "POST") {
      if (!(await dailyQuota(env.DB, user.id))) return json({ error: "daily limit reached" }, 429, headers);
      const { text } = await req.json() as { text?: string };
      if (!text || text.length < 10 || text.length > 8000) return json({ error: "text must be 10–8000 characters" }, 400, headers);

      const key = `v:${hashStr(text)}`;
      const cached = await env.CACHE.get(key, "json");
      let receipts: unknown;
      let cachedFlag = false;
      if (cached) { receipts = cached; cachedFlag = true; }
      else {
        try {
          receipts = await verify(text, { ai: env.AI, tavilyKey: env.TAVILY_API_KEY });
        } catch (e) {
          return json({ error: "verification failed", detail: String(e).slice(0, 300) }, 500, headers);
        }
        await env.CACHE.put(key, JSON.stringify(receipts), { expirationTtl: 604800 });
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO receipts (id, user_id, input_hash, input_text, receipts_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).bind(id, user.id, key, text.slice(0, 8000), JSON.stringify(receipts)).run();
      return json({ id, cached: cachedFlag, receipts }, 200, headers);
    }

    if (url.pathname === "/api/verify/history" && req.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id, substr(input_text, 1, 120) AS preview, created_at FROM receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT 30"
      ).bind(user.id).all<{ id: string; preview: string; created_at: string }>();
      return json({ history: rows.results }, 200, headers);
    }

    return json({ error: "not found" }, 404, headers);
  },
};
