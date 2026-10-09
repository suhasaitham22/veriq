/**
 * auth-routes.ts — the /api/auth/* handlers.
 *
 * Every unauthenticated entry point is bounded before it does real work: a
 * service-wide ceiling first, then the source address, then the account label
 * as a digest. An attacker chooses the address and the label but not the
 * global keys, so neither the PBKDF2 cost nor the signup budget can be pushed
 * past them.
 *
 * No response here carries a secret except the one-time recovery code and the
 * one-time TOTP seed, each returned only on the path that mints it.
 */
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  isSecret,
  isValidEmail,
  isValidNewPassword,
  isValidPassword,
  newSalt,
  newSecret,
  newUserId,
  requirePassword,
  requestSessionHash,
  sessionCookie,
  sha256hex,
  verifyAccountPassword,
} from "./auth.ts";
import type { CredentialFence, Credentials, User } from "./auth.ts";
import {
  ENROLMENT_TTL_SECONDS,
  UNUSED_STEP,
  base32,
  matchStep,
  newSeed,
  openSeed,
  otpauthUri,
  sealSeed,
} from "./mfa.ts";
import { HttpError, readBody, rateLimit } from "./http.ts";

const GLOBAL_AUTH_PER_HOUR = 1000;
const GLOBAL_SIGNUPS_PER_DAY = 100;
const MAX_ACCOUNTS = 1000;
const IP_AUTH_PER_MINUTE = 10;
const ACCOUNT_AUTH_PER_HOUR = 20;
const ACCOUNT_RECOVERY_PER_HOUR = 5;

interface AuthProof extends Credentials {
  sessionHash: string;
}
const SESSION_PROOF = "EXISTS(SELECT 1 FROM sessions WHERE user_id=users.id AND token_hash=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export interface AuthResult {
  data: Record<string, unknown>;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * The one answer to every failed credential presentation: wrong password,
 * unknown label, disabled account, missing code, wrong code, replayed code, or
 * credentials that changed mid-verification. A caller must not tell them apart.
 */
function rejected(): HttpError {
  return new HttpError(
    401,
    "Invalid email or password.",
    "INVALID_CREDENTIALS",
  );
}

/** Ceiling check that fails closed. */
async function bound(
  db: D1Database,
  key: string,
  limit: number,
  seconds: number,
  message: string,
): Promise<void> {
  if (!(await rateLimit(db, key, limit, seconds)))
    throw new HttpError(429, message, "AUTH_RATE_LIMIT", seconds);
}

/**
 * Creates an account and mints its one-time recovery code. The daily signup
 * budget and the total account ceiling are both applied here, the ceiling
 * inside the insert so two concurrent signups cannot both take the last seat.
 * A new account has no second factor, so its session is not MFA-verified.
 */
async function signup(
  db: D1Database,
  body: Record<string, unknown>,
  email: string,
  taken: boolean,
): Promise<AuthResult> {
  if (!isValidNewPassword(body.password))
    throw new HttpError(
      400,
      "New passwords must contain at least 12 characters.",
    );
  if (taken)
    throw new HttpError(409, "Email already registered.", "ACCOUNT_EXISTS");
  await bound(
    db,
    "signup:global",
    GLOBAL_SIGNUPS_PER_DAY,
    86400,
    "Veriq is not accepting new accounts today; its free-tier signup budget is spent. Try again tomorrow.",
  );
  const id = newUserId(),
    salt = newSalt(),
    recoveryCode = newSecret();
  const created = await db
    .prepare(
      `INSERT OR IGNORE INTO users(id,email,password_hash,salt,recovery_hash)
     SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM users)<?`,
    )
    .bind(
      id,
      email,
      await hashPassword(body.password, salt),
      salt,
      await sha256hex(recoveryCode),
      MAX_ACCOUNTS,
    )
    .run();
  if (!created.meta.changes) {
    const full = await db
      .prepare("SELECT 1 FROM users LIMIT 1 OFFSET ?")
      .bind(MAX_ACCOUNTS - 1)
      .first();
    throw full
      ? new HttpError(
          503,
          "Veriq has reached its free-tier account limit. Ask an administrator for capacity.",
          "ACCOUNT_CAPACITY",
        )
      : new HttpError(409, "Email already registered.", "ACCOUNT_EXISTS");
  }
  return {
    data: {
      user: { id, email, mfaEnabled: false, mfaReady: false, mfaVerified: false },
      // Shown exactly once. Veriq cannot mail it and cannot reissue it.
      recoveryCode,
      identityAssurance: "unverified_label",
    },
    status: 201,
    headers: { "set-cookie": sessionCookie(await createSession(db, id)) },
  };
}

/**
 * Offline break-glass. The bearer code proves nothing about a mailbox; it
 * proves possession of a secret shown exactly once when the account or its
 * last rotation was created. It replaces the password and the code itself,
 * clears the second factor so a lost authenticator is not a dead end, and
 * revokes every session. No session is issued: the new password must be used.
 */
async function recover(
  db: D1Database,
  body: Record<string, unknown>,
  email: string,
  accountKey: string,
): Promise<AuthResult> {
  if (!isValidNewPassword(body.password))
    throw new HttpError(
      400,
      "New passwords must contain at least 12 characters.",
    );
  await bound(
    db,
    `recover:${accountKey}`,
    ACCOUNT_RECOVERY_PER_HOUR,
    3600,
    "Too many recovery attempts for this account. Try again later.",
  );
  // A malformed code is hashed as the empty string rather than branched on, so
  // every invalid presentation takes one path and receives one answer.
  const presented = isSecret(body.recoveryCode) ? body.recoveryCode : "";
  const recoveryCode = newSecret();
  const salt = newSalt();
  // Single use is the row's own business: the update matches only while the
  // stored digest still equals the presented code, so of two concurrent
  // attempts exactly one commits and the loser finds nothing to change.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users SET recovery_hash=?, password_hash=?, salt=?,
        mfa_seed=NULL, mfa_pending=NULL, mfa_pending_at=NULL, mfa_last_step=NULL
     WHERE email=? AND disabled=0 AND recovery_hash=?`,
      )
      .bind(
        await sha256hex(recoveryCode),
        await hashPassword(body.password, salt),
        salt,
        email,
        await sha256hex(presented),
      ),
    db
      .prepare(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=?) AND changes()=1",
      )
      .bind(email),
  ]);
  if (!results[0].meta.changes)
    throw new HttpError(
      401,
      "That recovery code is not valid for this account.",
      "RECOVERY_INVALID",
    );
  return {
    data: { ok: true, recoveryCode, mfaEnabled: false },
    headers: { "set-cookie": clearSessionCookie() },
  };
}

/**
 * Hands out a fresh seed once. The base32 secret exists only in this response;
 * D1 keeps a copy sealed to this account under the "enrollment" purpose, which
 * expires on its own if no code ever proves it.
 */
async function enrol(
  db: D1Database,
  user: User,
  proof: AuthProof,
  encryptionKey?: string,
): Promise<AuthResult> {
  const seed = newSeed();
  const stored = await db
    .prepare(
      `UPDATE users SET mfa_pending=?, mfa_pending_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),mfa_last_step=NULL
     WHERE id=? AND disabled=0 AND mfa_seed IS NULL AND password_hash=? AND salt=? AND ${SESSION_PROOF}`,
    )
    .bind(await sealSeed(seed, encryptionKey, user.id, "enrollment"), user.id, proof.password_hash, proof.salt, proof.sessionHash)
    .run();
  if (!stored.meta.changes)
    throw new HttpError(
      409,
      "Two-factor authentication is already set up. Disable it before enrolling another authenticator.",
      "MFA_ENABLED",
    );
  const secret = base32(seed);
  return {
    data: {
      secret,
      otpauthUri: otpauthUri(user.email, secret),
      expiresInSeconds: ENROLMENT_TTL_SECONDS,
    },
  };
}

/**
 * Proves a pending enrolment. The seed is re-sealed under the "active" purpose
 * before it becomes the live factor, so an enrolment ciphertext can never be
 * presented as one. Enabling, consuming the proving step and revoking every
 * other session commit together, and the caller receives a fresh verified
 * session because they just demonstrated both factors.
 */
async function confirmEnrolment(
  db: D1Database,
  user: User,
  code: unknown,
  proof: AuthProof,
  encryptionKey?: string,
): Promise<AuthResult> {
  const row = await db
    .prepare(
      `SELECT mfa_pending FROM users
     WHERE id=? AND disabled=0 AND mfa_seed IS NULL AND mfa_pending IS NOT NULL
       AND password_hash=? AND salt=? AND ${SESSION_PROOF}
       AND mfa_pending_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',?)`,
    )
    .bind(user.id, proof.password_hash, proof.salt, proof.sessionHash, `-${ENROLMENT_TTL_SECONDS} seconds`)
    .first<{ mfa_pending: string }>();
  if (!row)
    throw new HttpError(
      409,
      "Start two-factor setup again; this enrolment has expired or was already completed.",
      "MFA_ENROLMENT_EXPIRED",
    );
  const seed = await openSeed(
    row.mfa_pending,
    encryptionKey,
    user.id,
    "enrollment",
  );
  const step = await matchStep(code, seed);
  if (step === null) throw rejected();
  const active = await sealSeed(seed, encryptionKey, user.id, "active");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users SET mfa_seed=?, mfa_pending=NULL, mfa_pending_at=NULL, mfa_last_step=?
     WHERE id=? AND disabled=0 AND mfa_seed IS NULL AND mfa_pending=?
       AND password_hash=? AND salt=? AND ${SESSION_PROOF} AND mfa_pending_at>strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AND ${UNUSED_STEP}`,
      )
      .bind(
        active,
        step,
        user.id,
        row.mfa_pending,
        proof.password_hash,
        proof.salt,
        proof.sessionHash,
        `-${ENROLMENT_TTL_SECONDS} seconds`,
        step,
      ),
    db
      .prepare("DELETE FROM sessions WHERE user_id=? AND changes()=1")
      .bind(user.id),
  ]);
  if (!results[0].meta.changes) throw rejected();
  const token = await createSession(
    db,
    user.id,
    { password_hash: proof.password_hash, salt: proof.salt, mfa_seed: active },
    true,
  );
  if (!token) throw rejected();
  return {
    data: { ok: true, mfaEnabled: true },
    headers: { "set-cookie": sessionCookie(token) },
  };
}

/**
 * Removing the second factor needs the factor itself, so a stolen password
 * alone cannot strip it. Every session goes, including this one.
 */
async function disableMfa(
  db: D1Database,
  user: User,
  code: unknown,
  proof: AuthProof,
  encryptionKey?: string,
): Promise<AuthResult> {
  const row = await db
    .prepare(
      `SELECT mfa_seed FROM users WHERE id=? AND disabled=0 AND mfa_seed IS NOT NULL AND password_hash=? AND salt=? AND ${SESSION_PROOF}`,
    )
    .bind(user.id, proof.password_hash, proof.salt, proof.sessionHash)
    .first<{ mfa_seed: string }>();
  if (!row)
    throw new HttpError(
      409,
      "Two-factor authentication is not set up for this account.",
      "MFA_DISABLED",
    );
  const step = await matchStep(
    code,
    await openSeed(row.mfa_seed, encryptionKey, user.id, "active"),
  );
  if (step === null) throw rejected();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users SET mfa_seed=NULL, mfa_pending=NULL, mfa_pending_at=NULL, mfa_last_step=?
     WHERE id=? AND disabled=0 AND mfa_seed=? AND password_hash=? AND salt=? AND ${SESSION_PROOF} AND ${UNUSED_STEP}`,
      )
      .bind(step, user.id, row.mfa_seed, proof.password_hash, proof.salt, proof.sessionHash, step),
    db
      .prepare("DELETE FROM sessions WHERE user_id=? AND changes()=1")
      .bind(user.id),
  ]);
  if (!results[0].meta.changes) throw rejected();
  return {
    data: { ok: true, mfaEnabled: false },
    headers: { "set-cookie": clearSessionCookie() },
  };
}

/**
 * Rotate credentials only while the password, factor and exact session that
 * authorised the operation still exist. A concurrent enrolment cannot turn
 * a stale password-only request into a new break-glass credential.
 */
async function rotateSecurity(
  db: D1Database,
  user: User,
  body: Record<string, unknown>,
  proof: AuthProof,
  encryptionKey?: string,
): Promise<AuthResult> {
  let newPassword: string | null = null;
  if (body.newPassword !== undefined) {
    if (!isValidNewPassword(body.newPassword))
      throw new HttpError(400, "New passwords must contain at least 12 characters.");
    newPassword = body.newPassword;
  }
  const row = await db.prepare(`SELECT mfa_seed FROM users WHERE id=? AND disabled=0 AND password_hash=? AND salt=? AND ${SESSION_PROOF}`)
    .bind(user.id, proof.password_hash, proof.salt, proof.sessionHash).first<{ mfa_seed: string | null }>();
  if (!row) throw rejected();
  let step: number | null = null;
  if (row.mfa_seed) {
    step = await matchStep(body.code, await openSeed(row.mfa_seed, encryptionKey, user.id, "active"));
    if (step === null) throw rejected();
  }
  const recoveryCode = newSecret();
  const salt = newPassword === null ? proof.salt : newSalt();
  const passwordHash = newPassword === null ? proof.password_hash : await hashPassword(newPassword, salt);
  const results = await db.batch([
    db.prepare(`UPDATE users SET recovery_hash=?,password_hash=?,salt=?,mfa_last_step=CASE WHEN ? IS NULL THEN mfa_last_step ELSE ? END
      WHERE id=? AND disabled=0 AND password_hash=? AND salt=? AND mfa_seed IS ? AND ${SESSION_PROOF}
      AND (? IS NULL OR ${UNUSED_STEP})`)
      .bind(await sha256hex(recoveryCode), passwordHash, salt, step, step, user.id, proof.password_hash, proof.salt, row.mfa_seed, proof.sessionHash, step, step),
    db.prepare("DELETE FROM sessions WHERE user_id=? AND changes()=1").bind(user.id),
  ]);
  if (results[0].meta.changes !== 1) throw rejected();
  return { data: { ok: true, recoveryCode }, headers: { "set-cookie": clearSessionCookie() } };
}

export async function authRoutes(
  req: Request,
  url: URL,
  db: D1Database,
  user: User | null,
  encryptionKey?: string,
): Promise<AuthResult | null> {
  const action = url.pathname.match(
    /^\/api\/auth\/(signup|login|logout|me|revoke-sessions|recover|security|mfa\/enroll|mfa\/confirm|mfa\/disable)$/,
  )?.[1];
  if (!action) return null;
  if (action === "me" && req.method === "GET") {
    if (!user)
      throw new HttpError(
        401,
        "Your session has expired. Sign in again.",
        "AUTH_REQUIRED",
      );
    const row = await db
      .prepare(
        "SELECT recovery_hash IS NOT NULL AS recovery FROM users WHERE id=?",
      )
      .bind(user.id)
      .first<{ recovery: number }>();
    return {
      data: {
        user,
        recoveryAvailable: row?.recovery === 1,
        // The email on an account is a label its holder typed. Veriq never
        // proved control of that mailbox and says so rather than implying it.
        identityAssurance: "unverified_label",
      },
    };
  }
  if (req.method !== "POST") return null;
  if (action === "logout") {
    await destroySession(req, db);
    return {
      data: { ok: true },
      headers: { "set-cookie": clearSessionCookie() },
    };
  }
  if (action === "revoke-sessions") {
    if (!user) throw new HttpError(401, "Sign in first.", "AUTH_REQUIRED");
    await db
      .prepare("DELETE FROM sessions WHERE user_id=?")
      .bind(user.id)
      .run();
    return {
      data: { ok: true },
      headers: { "set-cookie": clearSessionCookie() },
    };
  }
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (action === "security" || action.startsWith("mfa/")) {
    if (!user) throw new HttpError(401, "Sign in first.", "AUTH_REQUIRED");
    const body = await readBody(req);
    const credentials = await requirePassword(db, user, body.password, "default", ip);
    const sessionHash = await requestSessionHash(req);
    if (!sessionHash) throw rejected();
    const proof: AuthProof = { ...credentials, sessionHash };
    if (action === "mfa/enroll") return enrol(db, user, proof, encryptionKey);
    if (action === "mfa/confirm")
      return confirmEnrolment(db, user, body.code, proof, encryptionKey);
    if (action === "mfa/disable")
      return disableMfa(db, user, body.code, proof, encryptionKey);
    return rotateSecurity(db, user, body, proof, encryptionKey);
  }
  if (action !== "signup" && action !== "login" && action !== "recover")
    return null;
  // Service-wide first: an attacker owns the address and the label, not these.
  await bound(
    db,
    "auth:global",
    GLOBAL_AUTH_PER_HOUR,
    3600,
    "Veriq is refusing sign-in traffic to stay inside its free-tier budget. Try again later.",
  );
  await bound(
    db,
    `auth:${ip}`,
    IP_AUTH_PER_MINUTE,
    60,
    "Too many sign-in attempts. Try again in a minute.",
  );
  const body = await readBody(req);
  if (typeof body.email !== "string" || !isValidEmail(body.email))
    throw new HttpError(400, "Invalid email.");
  const email = body.email.toLowerCase();
  // request_limits keeps a digest, never an account label: a table an operator
  // reads for capacity must not double as a directory of who signed in.
  const accountKey = await sha256hex(email);
  if (action === "recover") return recover(db, body, email, accountKey);
  if (typeof body.password !== "string" || !isValidPassword(body.password))
    throw new HttpError(400, "Password must be 8–128 characters.");
  await bound(
    db,
    `auth:acct:${accountKey}`,
    ACCOUNT_AUTH_PER_HOUR,
    3600,
    "Too many attempts for this account. Try again later.",
  );
  const row = await db
    .prepare(
      "SELECT id,email,password_hash,salt,disabled,mfa_seed FROM users WHERE email=?",
    )
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      salt: string;
      disabled: number;
      mfa_seed: string | null;
    }>();
  if (action === "signup") return signup(db, body, email, row !== null);
  // The KDF runs for unknown and disabled accounts too; no existence shortcut.
  const authentic = await verifyAccountPassword(body.password, row);
  if (!row || !authentic || row.disabled) throw rejected();
  const fence: CredentialFence = {
    password_hash: row.password_hash,
    salt: row.salt,
    mfa_seed: row.mfa_seed,
  };
  if (row.mfa_seed) {
    // openSeed fails closed with MFA_UNAVAILABLE on a missing or rotated key,
    // so an enrolled account is never signed in on its password alone.
    const step = await matchStep(
      body.code,
      await openSeed(row.mfa_seed, encryptionKey, row.id, "active"),
    );
    if (step === null) throw rejected();
    fence.step = step;
  }
  // The fence makes this sign-in lose to any credential change that landed
  // while the KDF and the code check were running.
  const token = await createSession(db, row.id, fence, row.mfa_seed !== null);
  if (!token) throw rejected();
  return {
    data: { user: { id: row.id, email, mfaEnabled: row.mfa_seed !== null, mfaReady: row.mfa_seed !== null, mfaVerified: row.mfa_seed !== null } },
    headers: { "set-cookie": sessionCookie(token) },
  };
}
