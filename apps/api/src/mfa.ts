/**
 * mfa.ts — TOTP second factor (RFC 6238, HMAC-SHA1, 6 digits, 30-second step).
 *
 * This is the lowest layer of the authentication stack: it depends on no other
 * Veriq module, and auth.ts composes it.
 *
 * Design:
 * - The 20-byte seed is generated on the server, shown to the enrolling account
 *   exactly once, and stored only as AES-256-GCM ciphertext under the operator
 *   key in env MFA_ENCRYPTION_KEY. A database dump alone does not yield a
 *   working second factor.
 * - There is no fallback. If the key is absent, malformed, or no longer the key
 *   a seed was sealed with, every second-factor-gated action fails closed with
 *   MFA_UNAVAILABLE. An enrolled account is never downgraded to password-only.
 * - A code is single-use: accepting it advances the account's highest accepted
 *   time step, and that advance is a compare-and-set, so a replay changes no
 *   row and two concurrent uses of one code leave exactly one winner.
 * - Veriq claims no knowledge of who holds a factor. A second factor proves a
 *   second secret, not a second person.
 */

import { HttpError } from "./http.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SEED_BYTES = 20;
const ISSUER = "Veriq";
/** A pending enrolment that is never proved by a code expires on its own. */
export const ENROLMENT_TTL_SECONDS = 600;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * Steps accepted either side of the current one: one step of clock skew in each
 * direction, so a code is usable for at most about 90 seconds.
 */
const TOTP_SKEW_STEPS = 1;

/** Second-factor state that the session resolver derives for every request. */
export interface SecondFactor {
  /** A sealed seed exists for this account, whatever the key situation is. */
  mfaEnabled: boolean;
  /** That seed can be decrypted with the key configured right now. */
  mfaReady: boolean;
  /**
   * This session was opened by presenting a code, not merely by an account
   * that happens to be enrolled. It is recorded once when the session row is
   * written and never inferred afterwards, so a cookie minted before
   * enrolment, or by a password-only sign-in, is never mistaken for a second
   * factor.
   */
  mfaVerified: boolean;
}

/**
 * Constant-time string comparison. It lives here because both factors need it:
 * auth.ts compares password digests with it and the code check below compares
 * digits with it, and neither may leak a matching prefix through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeKey(key: string | undefined): Uint8Array | null {
  if (!key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  return bytes.length === KEY_BYTES ? bytes : null;
}

/**
 * Pure configuration check for /api/health. It reports whether an AES-256 key
 * is configured at all; it deliberately says nothing about whether any stored
 * seed was sealed with that key.
 */
export function mfaAvailable(key: string | undefined): boolean {
  return decodeKey(key) !== null;
}

function unavailable(detail: string): HttpError {
  return new HttpError(
    503,
    `Two-factor authentication is unavailable: ${detail} Ask an administrator to restore MFA_ENCRYPTION_KEY; enrolled accounts are never signed in without their second factor.`,
    "MFA_UNAVAILABLE",
  );
}

async function cipherKey(key: string | undefined): Promise<CryptoKey> {
  const raw = decodeKey(key);
  if (!raw)
    throw unavailable(
      "no 32-byte base64 encryption key is configured for this deployment.",
    );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Fresh 20-byte TOTP seed. Shown to its account once and never stored in clear. */
export function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

/** Purpose a sealed seed is bound to, so one can never be replayed as the other. */
export type SeedPurpose = "active" | "enrollment";

/**
 * Additional authenticated data for AES-GCM. It binds a sealed seed to one
 * account and one purpose, so a ciphertext lifted from another account's row,
 * or a pending enrolment presented as a live factor, does not open at all.
 */
function context(accountId: string, purpose: SeedPurpose): Uint8Array {
  return new TextEncoder().encode(`veriq:mfa:v1:${accountId}:${purpose}`);
}

export async function sealSeed(
  seed: Uint8Array,
  key: string | undefined,
  accountId: string,
  purpose: SeedPurpose,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context(accountId, purpose) },
      await cipherKey(key),
      seed,
    ),
  );
  const packed = new Uint8Array(iv.length + sealed.length);
  packed.set(iv);
  packed.set(sealed, iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function openSeed(
  sealed: string,
  key: string | undefined,
  accountId: string,
  purpose: SeedPurpose,
): Promise<Uint8Array> {
  const cryptoKey = await cipherKey(key);
  try {
    const packed = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: packed.subarray(0, IV_BYTES),
          additionalData: context(accountId, purpose),
        },
        cryptoKey,
        packed.subarray(IV_BYTES),
      ),
    );
  } catch {
    throw unavailable(
      "the configured encryption key does not open this account's stored second-factor secret.",
    );
  }
}

/**
 * Whether an account's live sealed seed can be opened right now. Unlike
 * openSeed this never throws: it runs on every authenticated request to decide
 * whether second-factor-gated actions are available, and a key problem must
 * still leave personal-workspace use and enrolment reachable.
 */
export async function seedReadable(
  sealed: string,
  key: string | undefined,
  accountId: string,
): Promise<boolean> {
  try {
    await openSeed(sealed, key, accountId, "active");
    return true;
  } catch {
    return false;
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding: the form authenticator apps accept. */
export function base32(bytes: Uint8Array): string {
  let value = 0,
    bits = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Provisioning URI for an authenticator app. The label is an unverified account
 * email, carried only so a person can tell their entries apart.
 */
export function otpauthUri(email: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(`${ISSUER}:${email}`)}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

export async function totp(seed: Uint8Array, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    seed,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function currentStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * The time step a presented code belongs to, or null when it belongs to none.
 * Every candidate step is evaluated even after a match so that the response
 * time does not reveal which step was accepted.
 */
export async function matchStep(
  code: unknown,
  seed: Uint8Array,
  atMs = Date.now(),
): Promise<number | null> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const now = currentStep(atMs);
  let matched: number | null = null;
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset++)
    if (timingSafeEqual(await totp(seed, now + offset), code))
      matched = now + offset;
  return matched;
}

/**
 * Predicate that makes a time step single-use: it holds only while the stored
 * step is lower than the one being accepted, so advancing it is a
 * compare-and-set. A replayed code targets a step that is no longer greater
 * and changes no row; two concurrent uses of one code race and exactly one
 * wins. Every caller composes this with its own credential fence — the
 * password digest, salt and sealed seed the code was verified against — so a
 * verification that started before a concurrent recovery, password change or
 * second-factor removal cannot commit after it. Bind the step last.
 */
export const UNUSED_STEP = "(mfa_last_step IS NULL OR mfa_last_step<?)";

/**
 * Gate for every path that reaches another organisation's material, read or
 * write. A stolen password alone must not open a team workspace, so this
 * demands a session that actually presented a code, and fails closed when the
 * second factor is missing or currently unreadable.
 */
export function requireMfa(user: SecondFactor): void {
  // Order matters: an enrolled account whose seed cannot be read is a
  // deployment fault to report, not a prompt to go and set up a second factor.
  if (user.mfaEnabled && !user.mfaReady)
    throw unavailable(
      "your enrolled second factor cannot be read with the key this deployment is running.",
    );
  if (!user.mfaEnabled)
    throw new HttpError(
      403,
      "Set up two-factor authentication before using a team workspace.",
      "MFA_REQUIRED",
    );
  if (!user.mfaVerified)
    throw new HttpError(
      403,
      "Sign in again with your authenticator code to use a team workspace.",
      "MFA_REQUIRED",
    );
}
