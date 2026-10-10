/**
 * auth.ts — Veriq authentication. Email + password, sessions in D1.
 *
 * Security notes:
 * - Passwords: PBKDF2-SHA256, per-user 128-bit salt. Iterations tuned to fit
 *   the Worker's CPU budget (see ITERATIONS).
 * - Sessions: 256-bit random token; only SHA-256(token) is stored in D1.
 *   Cookie is HttpOnly, Secure, SameSite=Lax (first-party Pages proxy).
 * - Timing-safe digest comparison (shared with the code check in mfa.ts).
 * - Auth endpoints are rate-limited globally, then per IP and per account in
 *   auth-routes.ts, so every unauthenticated KDF is bounded.
 * - An email address is an unverified label. It names an account; it never
 *   proves control of a mailbox, so it grants no access on its own.
 * - Account recovery uses an offline 256-bit code of which only SHA-256 is
 *   stored. There is no email-delivered and no operator-assisted reset path.
 * - Disabled accounts cannot sign in and cannot resume a stored session.
 * - A resolved session carries the account's second-factor state, so a
 *   privileged request can be refused for a missing or unreadable factor
 *   without another query, while plain reads keep working.
 */

import { HttpError, rateLimit } from "./http.ts";
import { UNUSED_STEP, seedReadable, timingSafeEqual } from "./mfa.ts";
import type { SecondFactor } from "./mfa.ts";

const ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 12 * 3600;
/** Live cookies per account, so a sign-in loop cannot grow the sessions table. */
const MAX_SESSIONS_PER_USER = 10;
/**
 * Re-authentication budgets for privileged self-service (export, deletion,
 * credential rotation). They bound KDF work for an account that already holds
 * a valid session. The export budget is far higher because a complete
 * paginated export re-confirms the password on every page.
 */
const REAUTH_PER_HOUR = 300;
const EXPORT_REAUTH_PER_HOUR = 3000;
/** Wrong-password tally per hour. Any correct confirmation clears it. */
const REAUTH_FAILURES_PER_HOUR = 10;
/** Stand-ins so an absent or disabled account still costs one full KDF. */
const ABSENT_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
const ABSENT_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export interface User extends SecondFactor {
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

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 256-bit bearer secret: session token, workspace invitation token or account
 * recovery code. Only SHA-256(secret) is ever persisted, so a database read
 * cannot be replayed as the secret it authorises.
 */
export function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isSecret(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function verifyPassword(
  password: string,
  saltB64: string,
  expectedHash: string,
): Promise<boolean> {
  const h = await hashPassword(password, saltB64);
  return timingSafeEqual(h, expectedHash);
}

export interface Credentials {
  password_hash: string;
  salt: string;
}

/**
 * Password check that costs one full KDF whether or not the account row was
 * found, so response timing cannot be used to enumerate registered labels.
 */
export async function verifyAccountPassword(
  password: unknown,
  row: Credentials | null,
): Promise<boolean> {
  const valid = await verifyPassword(
    typeof password === "string" ? password : "",
    row?.salt ?? ABSENT_SALT,
    row?.password_hash ?? ABSENT_HASH,
  );
  return !!row && valid;
}

/** A full export confirms once per page, so its budget is not the default one. */
export type ReauthPurpose = "default" | "export";

/**
 * Confirms the signed-in account's own password before a privileged
 * self-service action. The failure is deliberately identical to a failed
 * sign-in: a caller must not learn whether the account is disabled or the
 * password merely mistyped. This proves the password only; callers that also
 * need a second factor call requireMfa from mfa.ts.
 *
 * Two budgets apply. The purpose ceiling bounds how much KDF work one session
 * can ask for. The wrong-password tallies are far tighter and are cleared by
 * every correct password, so paginating a long export never trips them while a
 * run of wrong guesses still locks the hour for the account and, when the
 * caller supplies one, for the source address.
 */
export async function requirePassword(
  db: D1Database,
  user: User,
  password: unknown,
  purpose: ReauthPurpose = "default",
  ip?: string,
): Promise<Credentials> {
  const tooMany = new HttpError(
    429,
    "Too many confirmation attempts. Try again later.",
    "AUTH_RATE_LIMIT",
    3600,
  );
  const ceiling =
    purpose === "export" ? EXPORT_REAUTH_PER_HOUR : REAUTH_PER_HOUR;
  if (!(await rateLimit(db, `reauth:${purpose}:${user.id}`, ceiling, 3600)))
    throw tooMany;
  const failures = [`reauth-fail:${user.id}`];
  if (ip) failures.push(`reauth-fail-ip:${ip}`);
  for (const key of failures)
    if (!(await rateLimit(db, key, REAUTH_FAILURES_PER_HOUR, 3600)))
      throw tooMany;
  const row = await db
    .prepare("SELECT password_hash, salt FROM users WHERE id=? AND disabled=0")
    .bind(user.id)
    .first<Credentials>();
  if (!(await verifyAccountPassword(password, row)) || !row)
    throw new HttpError(
      401,
      "Invalid email or password.",
      "INVALID_CREDENTIALS",
    );
  await db.batch(
    failures.map((key) =>
      db.prepare("DELETE FROM request_limits WHERE key=?").bind(key),
    ),
  );
  return row;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function isValidPassword(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 128;
}

/** Newly chosen and rotated passwords clear a higher bar than legacy sign-ins. */
export function isValidNewPassword(pw: unknown): pw is string {
  return typeof pw === "string" && pw.length >= 12 && pw.length <= 128;
}

/**
 * The exact credential state a sign-in was verified against.
 *
 * Verification is slow by design — one PBKDF2 pass, sometimes an AES-GCM open
 * and three HMACs — and a recovery, password change or second-factor removal
 * can land while it runs. Without this fence such an in-flight sign-in would
 * mint a live session against credentials that no longer exist.
 */
export interface CredentialFence {
  password_hash: string;
  salt: string;
  /** Sealed TOTP seed, or null for an account with no second factor. */
  mfa_seed: string | null;
  /** Step the presented code belongs to; absent when no code was required. */
  step?: number;
}

/**
 * Issues a session token and stores only SHA-256 of it. With a fence the
 * session row appears only while the account still holds exactly those
 * credentials, and a supplied step is consumed in the same batch, so one code
 * can never open two sessions. Returns null when the fence did not hold;
 * called without a fence it always returns the token.
 *
 * `mfaVerified` records that this session was opened by presenting a code. It
 * is never derived from the account's enrolment state: only a sign-in that
 * checked a code, or the enrolment that proved one, may pass true.
 */
export function createSession(db: D1Database, userId: string): Promise<string>;
export function createSession(
  db: D1Database,
  userId: string,
  fence: null,
  mfaVerified: boolean,
): Promise<string>;
export function createSession(
  db: D1Database,
  userId: string,
  fence: CredentialFence,
  mfaVerified?: boolean,
): Promise<string | null>;
export async function createSession(
  db: D1Database,
  userId: string,
  fence?: CredentialFence | null,
  mfaVerified = false,
): Promise<string | null> {
  const token = newSecret();
  const tokenHash = await sha256hex(token);
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  // `IS ?` so a bound NULL seed compares equal to a NULL column.
  const unchanged =
    "id=? AND disabled=0 AND password_hash=? AND salt=? AND mfa_seed IS ?";
  const snapshot = fence
    ? [userId, fence.password_hash, fence.salt, fence.mfa_seed]
    : [];
  // Expired rows can be removed on any attempt. Live sessions are capped only
  // after a new session actually lands, so a replay cannot evict valid cookies.
  const statements = [
    db.prepare("DELETE FROM sessions WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
  ];
  if (fence?.step !== undefined)
    statements.push(
      db
        .prepare(
          `UPDATE users SET mfa_last_step=? WHERE ${unchanged} AND ${UNUSED_STEP}`,
        )
        .bind(fence.step, ...snapshot, fence.step),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, mfa_verified) SELECT ?,?,?,?${
          fence
            ? ` WHERE EXISTS(SELECT 1 FROM users WHERE ${unchanged})${fence.step === undefined ? "" : " AND changes()=1"}`
            : ""
        }`,
      )
      .bind(tokenHash, userId, expiresAt, mfaVerified ? 1 : 0, ...snapshot),
  );
  const inserted = statements.length - 1;
  statements.push(
    db.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash!=?
      AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=?)
      AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? AND token_hash!=? ORDER BY expires_at DESC,token_hash LIMIT ?)`)
      .bind(userId, tokenHash, tokenHash, userId, userId, tokenHash, MAX_SESSIONS_PER_USER - 1),
  );
  const results = await db.batch(statements);
  return results[inserted].meta.changes === 1 ? token : null;
}

/** One cookie contract for authentication and every transaction-time session fence.
 * The __Host- prefix prevents sibling previews setting a parent-domain cookie.
 * Legacy unprefixed cookies are intentionally not accepted.
 */
export async function requestSessionHash(req: Request): Promise<string | null> {
  const match = (req.headers.get("cookie") ?? "").match(
    /(?:^|;\s*)__Host-veriq_session=([a-f0-9]{64})(?:;|$)/,
  );
  return match ? sha256hex(match[1]) : null;
}

export async function getSessionUser(
  req: Request,
  db: D1Database,
  encryptionKey?: string,
): Promise<User | null> {
  const tokenHash = await requestSessionHash(req);
  if (!tokenHash) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.created_at, u.mfa_seed, s.mfa_verified FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND u.disabled = 0
       AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(tokenHash)
    .first<{
      id: string;
      email: string;
      created_at: string;
      mfa_seed: string | null;
      mfa_verified: number;
    }>();
  if (!row) return null;
  // The sealed seed stops here. Callers learn only that a second factor exists,
  // whether this deployment's key can still read it, and whether this very
  // session proved a code — never the ciphertext itself.
  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
    mfaEnabled: row.mfa_seed !== null,
    mfaReady:
      row.mfa_seed !== null &&
      (await seedReadable(row.mfa_seed, encryptionKey, row.id)),
    mfaVerified: row.mfa_verified === 1,
  };
}

export async function destroySession(
  req: Request,
  db: D1Database,
): Promise<void> {
  const tokenHash = await requestSessionHash(req);
  if (!tokenHash) return;
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
}

export function sessionCookie(token: string): string {
  return `__Host-veriq_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `__Host-veriq_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
