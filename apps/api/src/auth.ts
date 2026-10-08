/**
 * auth.ts — Veriq authentication. Email + password, sessions in D1.
 *
 * Security notes:
 * - Passwords: PBKDF2-SHA256, per-user 128-bit salt. Iterations tuned to fit
 *   the Worker's CPU budget (see ITERATIONS).
 * - Sessions: 256-bit random token; only SHA-256(token) is stored in D1.
 *   Cookie is HttpOnly, Secure, SameSite=Lax (first-party Pages proxy).
 * - Timing-safe comparison for password checks.
 * - Auth endpoints are rate-limited per IP in index.ts.
 */

const ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 12 * 3600;

export interface User {
  id: string;
  email: string;
  created_at: string;
}

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(
  password: string,
  saltB64: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: unb64(saltB64),
      iterations: ITERATIONS,
    },
    key,
    256,
  );
  return b64(bits);
}

export function newSalt(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

export function newUserId(): string {
  return crypto.randomUUID();
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyPassword(
  password: string,
  saltB64: string,
  expectedHash: string,
): Promise<boolean> {
  const h = await hashPassword(password, saltB64);
  return timingSafeEqual(h, expectedHash);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function isValidPassword(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 128;
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tokenHash = await sha256hex(token);
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(tokenHash, userId, expiresAt)
    .run();
  return token;
}

export async function getSessionUser(
  req: Request,
  db: D1Database,
): Promise<User | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)veriq_session=([a-f0-9]{64})(?:;|$)/);
  if (!m) return null;
  const tokenHash = await sha256hex(m[1]);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.created_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(tokenHash)
    .first<User>();
  return row ?? null;
}

export async function destroySession(
  req: Request,
  db: D1Database,
): Promise<void> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)veriq_session=([a-f0-9]{64})(?:;|$)/);
  if (!m) return;
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256hex(m[1]))
    .run();
}

export function sessionCookie(token: string): string {
  return `veriq_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `veriq_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
