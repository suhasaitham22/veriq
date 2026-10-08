import {
  createSession,
  destroySession,
  hashPassword,
  isValidEmail,
  isValidPassword,
  newSalt,
  newUserId,
  sessionCookie,
  clearSessionCookie,
  verifyPassword,
} from "./auth.ts";
import type { User } from "./auth.ts";
import { HttpError, readBody, rateLimit } from "./http.ts";
export async function authRoutes(
  req: Request,
  url: URL,
  db: D1Database,
  user: User | null,
) {
  const action = url.pathname.match(
    /^\/api\/auth\/(signup|login|logout|me|revoke-sessions)$/,
  )?.[1];
  if (!action) return null;
  if (action === "me" && req.method === "GET") {
    if (!user)
      throw new HttpError(
        401,
        "Your session has expired. Sign in again.",
        "AUTH_REQUIRED",
      );
    return { data: { user } };
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
  if (action !== "signup" && action !== "login") return null;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimit(db, `auth:${ip}`, 10, 60)))
    throw new HttpError(
      429,
      "Too many sign-in attempts. Try again in a minute.",
      "AUTH_RATE_LIMIT",
    );
  const body = await readBody(req);
  if (typeof body.email !== "string" || !isValidEmail(body.email))
    throw new HttpError(400, "Invalid email.");
  if (typeof body.password !== "string" || !isValidPassword(body.password))
    throw new HttpError(400, "Password must be 8–128 characters.");
  const email = body.email.toLowerCase();
  const row = await db
    .prepare("SELECT id,email,password_hash,salt FROM users WHERE email=?")
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      salt: string;
    }>();
  if (action === "signup") {
    if (body.password.length < 12)
      throw new HttpError(
        400,
        "New passwords must contain at least 12 characters.",
      );
    if (row)
      throw new HttpError(409, "Email already registered.", "ACCOUNT_EXISTS");
    const id = newUserId(),
      salt = newSalt();
    const changed = await db
      .prepare(
        "INSERT OR IGNORE INTO users(id,email,password_hash,salt) VALUES(?,?,?,?)",
      )
      .bind(id, email, await hashPassword(body.password, salt), salt)
      .run();
    if (!changed.meta.changes)
      throw new HttpError(409, "Email already registered.", "ACCOUNT_EXISTS");
    return {
      data: { user: { id, email } },
      status: 201,
      headers: { "set-cookie": sessionCookie(await createSession(db, id)) },
    };
  }
  // Do the password KDF for unknown accounts too; do not expose an account-existence shortcut.
  const valid = await verifyPassword(
    body.password,
    row?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA==",
    row?.password_hash ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  if (!row || !valid)
    throw new HttpError(
      401,
      "Invalid email or password.",
      "INVALID_CREDENTIALS",
    );
  return {
    data: { user: { id: row.id, email } },
    headers: { "set-cookie": sessionCookie(await createSession(db, row.id)) },
  };
}
