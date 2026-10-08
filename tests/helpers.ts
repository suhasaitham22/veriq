import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createSession } from "../apps/api/src/auth.ts";
import type { Env } from "../apps/api/src/index.ts";
import type { AIClient } from "../apps/api/src/pipeline.ts";

/** Execute production SQL against SQLite, not SQL-string-specific mock responses. */
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_existing_auth.sql",
    "0002_support_review.sql",
    "0003_workspaces.sql",
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
    async run() {
      return { response: JSON.stringify(answer) };
    },
  };
}
export async function fixture(ai = fakeAI()) {
  const { sqlite, db } = database();
  const map = new Map<string, string>();
  const env: Env = {
    DB: db,
    AI: ai,
    WEB_ORIGIN: "http://localhost:8788",
    CACHE: {
      async get(key: string) {
        return map.get(key) ?? null;
      },
      async put(key: string, value: string) {
        map.set(key, value);
      },
    } as unknown as KVNamespace,
  };
  const alice = "11111111-1111-4111-8111-111111111111";
  const bob = "22222222-2222-4222-8222-222222222222";
  for (const [id, email] of [
    [alice, "alice@example.test"],
    [bob, "bob@example.test"],
  ]) {
    sqlite
      .prepare(
        "INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'hash', 'salt')",
      )
      .run(id, email);
  }
  const aliceToken = await createSession(db, alice);
  const bobToken = await createSession(db, bob);
  return { env, sqlite, alice, bob, aliceToken, bobToken };
}
