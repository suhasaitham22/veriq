/**
 * index.ts — Veriq API. Three routes, that's it.
 * Heavy lifting lives in pipeline.ts; credibility in credibility.ts.
 */
import { verify } from "./pipeline";

interface Env {
  AI: Ai;
  DB: D1Database;
  CACHE: KVNamespace;
  SNAPSHOTS: R2Bucket;
  SEARCH_API_KEY: string;
}

const DAILY_CAP = 20; // free-tier hygiene: verifications per IP per day

async function checkQuota(ip: string, env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "SELECT count FROM usage WHERE ip = ? AND day = ?").bind(ip, day).first<{ count: number }>();
  const used = row?.count ?? 0;
  if (used >= DAILY_CAP) return false;
  await env.DB.prepare(
    "INSERT INTO usage (ip, day, count) VALUES (?, ?, 1) ON CONFLICT (ip, day) DO UPDATE SET count = count + 1")
    .bind(ip, day).run();
  return true;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "veriq-api" });
    }

    if (req.method === "POST" && url.pathname === "/api/verify") {
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await checkQuota(ip, env))) return json({ error: "daily limit reached" }, 429);

      const { text } = await req.json() as { text?: string };
      if (!text || text.length < 10) return json({ error: "text too short" }, 400);

      const key = `v:${hash(text)}`;
      const cached = await env.CACHE.get(key, "json");
      if (cached) return json({ cached: true, receipts: cached });

      const receipts = await verify(text.slice(0, 4000), { ai: env.AI, searchKey: env.SEARCH_API_KEY });
      await env.CACHE.put(key, JSON.stringify(receipts), { expirationTtl: 604800 });
      return json({ cached: false, receipts });
    }

    return json({ error: "not found" }, 404);
  },
};
