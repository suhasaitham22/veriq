import { InputError } from "./pipeline.ts";
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "REQUEST_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? ""))
    throw new InputError("Send application/json.");
  const reader = req.body?.getReader();
  if (!reader) throw new InputError("A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 100000) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large.", "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InputError("Invalid JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new InputError("Send a JSON object.");
  return parsed as Record<string, unknown>;
}
export function string(
  value: unknown,
  name: string,
  max: number,
  min = 1,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw new InputError(`${name} must be ${min}–${max} characters.`);
  return value.trim();
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export function page(url: URL) {
  const raw = url.searchParams.get("limit") ?? "25";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)
    throw new InputError("Page size must be 1–100.");
  let cursor: { time: string; id: string } | null = null;
  const encoded = url.searchParams.get("cursor");
  if (encoded) {
    try {
      if (encoded.length > 512) throw new Error();
      const p = JSON.parse(atob(encoded));
      if (
        !uuid(p.id) ||
        typeof p.time !== "string" ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p.time)
      )
        throw new Error();
      cursor = p;
    } catch {
      throw new InputError("Invalid page cursor.");
    }
  }
  const query = url.searchParams.get("q") ?? "";
  if (query.length > 120) throw new InputError("Search is too long.");
  return { limit: Number(raw), cursor, query };
}
export function nextCursor(
  rows: { id: string; created_at: string }[],
  limit: number,
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  return btoa(JSON.stringify({ time: last.created_at, id: last.id }));
}
export function like(query: string): string {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}
/** Atomic across concurrent requests, unlike a KV read/increment/write. */
export async function rateLimit(
  db: D1Database,
  key: string,
  limit: number,
  seconds: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / seconds);
  await db
    .prepare("DELETE FROM request_limits WHERE expires_at < ?")
    .bind(now)
    .run();
  return !!(await db
    .prepare(
      "INSERT INTO request_limits(key,window,count,expires_at) VALUES(?,?,1,?) ON CONFLICT(key,window) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count",
    )
    .bind(key, window, now + seconds + 5, limit)
    .first());
}
