import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createSession } from "../apps/api/src/auth.ts";
import type { Env } from "../apps/api/src/index.ts";
import type { AIClient } from "../apps/api/src/pipeline.ts";
import api from "../apps/api/src/index.ts";
import { sealSeed, newSeed } from "../apps/api/src/mfa.ts";

export interface Fixture {
  env: Env;
  sqlite: DatabaseSync;
  alice: string;
  bob: string;
  aliceToken: string;
  bobToken: string;
}

/** Execute production SQL against SQLite, not SQL-string-specific mock responses. */
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_existing_auth.sql",
    "0002_support_review.sql",
    "0003_workspaces.sql",
    "0004_pilot_feedback.sql",
    "0005_evidence_chat.sql",
    "0006_customer_hardening.sql",
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../apps/api/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const db = {
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.run());
        sqlite.exec("COMMIT");
        return await Promise.all(results);
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      let values: (string | number | null)[] = [];
      const statement = sqlite.prepare(sql);
      return {
        bind(...args: (string | number | null)[]) {
          values = args;
          return this;
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values), success: true };
        },
        run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}
export function fakeAI(
  answer: unknown = { notApplicable: false, evidence: [] },
): AIClient {
  return {
    async run(_model, input) {
      if (!input || typeof input !== "object" || !("messages" in input) || !Array.isArray(input.messages))
        throw new Error("Expected a review model request");
      const { statements } = JSON.parse(input.messages[1].content);
      return { response: JSON.stringify({ statements: statements.map((item: { index: number }) => ({ index: item.index, ...(answer as object) })) }) };
    },
  };
}
export async function fixture(ai = fakeAI()): Promise<Fixture> {
  const { sqlite, db } = database();
  const env: Env = {
    DB: db,
    AI: ai,
    WEB_ORIGIN: "http://localhost:8788",
    // Controlled fixtures only: these do not assert any real account's billing plan.
    WORKERS_FREE_PLAN_CONFIRMED: "true",
    LOCAL_MEDIA_DEMO: "true",
    // Ephemeral fixture key; never an operator/production credential.
    MFA_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  };
  const alice = "11111111-1111-4111-8111-111111111111";
  const bob = "22222222-2222-4222-8222-222222222222";
  for (const [id, email] of [
    [alice, "alice@example.test"],
    [bob, "bob@example.test"],
  ]) {
    sqlite
      .prepare(
        "INSERT INTO users (id, email, password_hash, salt, mfa_seed) VALUES (?, ?, 'hash', 'salt', ?)",
      )
      .run(id, email, await sealSeed(newSeed(), env.MFA_ENCRYPTION_KEY, id, "active"));
  }
  const aliceToken = await createSession(db, alice, null, true);
  const bobToken = await createSession(db, bob, null, true);
  return { env, sqlite, alice, bob, aliceToken, bobToken };
}

/** Admit the fixture recipient through the real possession proof, never an email grant. */
export async function admit(
  env: Env,
  workspaceId: string,
  inviterToken: string,
  inviteeToken: string,
  role: "admin" | "reviewer" | "viewer" = "admin",
) {
  const account = await api.fetch(new Request("http://localhost:8787/api/auth/me", {
    headers: { cookie: `__Host-veriq_session=${inviteeToken}` },
  }), env);
  const recipientAccountId = (await account.json()).user.id;
  const invite = await api.fetch(new Request(`http://localhost:8787/api/workspaces/${workspaceId}/invitations`, {
    method: "POST",
    headers: { cookie: `__Host-veriq_session=${inviterToken}`, "content-type": "application/json" },
    body: JSON.stringify({ recipientAccountId, recipientLabel: "Known fixture teammate", role }),
  }), env);
  if (invite.status !== 200) throw new Error(`Invitation failed: ${invite.status}`);
  const { token } = await invite.json() as { token: string };
  const accepted = await api.fetch(new Request("http://localhost:8787/api/invitations/accept", {
    method: "POST",
    headers: { cookie: `__Host-veriq_session=${inviteeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }), env);
  if (accepted.status !== 200) throw new Error(`Invitation acceptance failed: ${accepted.status}`);
}

/** Private object-store contract fixture; real bytes and metadata, no public URLs. */
export function mediaBucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata: Record<string, string> }
  >();
  const bucket = {
    async put(key: string, value: Uint8Array, options: any) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        customMetadata: options.customMetadata,
      });
      return { key, size: value.length };
    },
    async head(key: string) {
      const o = objects.get(key);
      return o
        ? { key, size: o.bytes.length, customMetadata: o.customMetadata }
        : null;
    },
    async get(key: string) {
      const o = objects.get(key);
      return o
        ? {
            key,
            size: o.bytes.length,
            customMetadata: o.customMetadata,
            body: new Response(o.bytes).body,
          }
        : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}
