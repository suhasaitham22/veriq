import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import api from "../apps/api/src/index.ts";
import { hashPassword, newSalt } from "../apps/api/src/auth.ts";
import { budgetedAI, AI_CAPACITY } from "../apps/api/src/capacity.ts";
import { scheduledCleanup } from "../apps/api/src/lifecycle.ts";
import { fixture, admit } from "./helpers.ts";
import type { Fixture as F } from "./helpers.ts";
import { withTimeout } from "../apps/api/src/pipeline.ts";

const password = "Fictional-local-password-42";
async function request(f: F, path: string, body?: unknown, token = f.aliceToken) {
  return api.fetch(new Request(`http://localhost:8787${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `__Host-veriq_session=${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), f.env);
}
async function credentials(f: F) {
  const salt = newSalt();
  f.sqlite.prepare("UPDATE users SET password_hash=?,salt=? WHERE id=?").run(await hashPassword(password, salt), salt, f.alice);
  await request(f, "/api/workspaces");
}
function oldReview(f: F, createdAt = "2000-01-01 00:00:00") {
  const id = crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO support_reviews(id,user_id,workspace_id,draft_text,review_json,status,created_at) VALUES(?,?,?,'Historical fictional reply','{}','needs_review',?)").run(id, f.alice, f.alice, createdAt);
  return id;
}

test("migration preserves legacy content and suspends email-only team grants without trusting them", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of ["0001_existing_auth", "0002_support_review", "0003_workspaces", "0004_pilot_feedback", "0005_evidence_chat"])
      db.exec(readFileSync(new URL(`../apps/api/migrations/${name}.sql`, import.meta.url), "utf8"));
    db.exec("INSERT INTO users(id,email,password_hash,salt) VALUES('owner','owner@example.test','hash','salt'),('member','member@example.test','hash','salt'); INSERT INTO workspaces(id,name,owner_id) VALUES('team','Legacy team','owner'); INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('team','owner','owner'),('team','member','reviewer'); INSERT INTO support_documents(id,workspace_id,user_id,title,version,content,content_hash) VALUES('policy','team','member','Policy','v1','Preserve this historical content','fingerprint')");
    db.exec(readFileSync(new URL("../apps/api/migrations/0006_customer_hardening.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT content FROM support_documents WHERE id='policy'").get()!.content, "Preserve this historical content");
    assert.equal(db.prepare("SELECT admitted_at FROM workspace_members WHERE user_id='member'").get()!.admitted_at, null);
    assert.ok(db.prepare("SELECT admitted_at FROM workspace_members WHERE user_id='owner'").get()!.admitted_at);
    assert.equal(db.prepare("SELECT retention_enabled FROM workspaces WHERE id='team'").get()!.retention_enabled, 0);
    assert.equal(db.prepare("SELECT disabled FROM users WHERE id='member'").get()!.disabled, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("workspace export paginates real data, requires owner password and never exposes credential material", async () => {
  const f = await fixture();
  try {
    await credentials(f);
    for (let i = 0; i < 12; i++) oldReview(f);
    assert.equal((await request(f, `/api/workspaces/${f.alice}/export`, { password: "wrong", section: "reviews" })).status, 401);
    assert.equal((await request(f, `/api/workspaces/${f.alice}/export`, { password }, f.bobToken)).status, 404);
    const first = await (await request(f, `/api/workspaces/${f.alice}/export`, { password, section: "reviews" })).json();
    assert.equal(first.records.length, 10);
    assert.ok(first.nextCursor);
    const second = await (await request(f, `/api/workspaces/${f.alice}/export`, { password, section: "reviews", cursor: first.nextCursor })).json();
    assert.equal(second.records.length, 2);
    assert.equal(new Set([...first.records, ...second.records].map((row: { id: string }) => row.id)).size, 12);
    assert.equal(second.nextCursor, null);
    assert.equal(second.nextSection, "attestations");
    assert.equal(first.consistentSnapshot, false);
    const ws = (await (await request(f, "/api/workspaces", { name: "Private team" })).json()).id;
    const invitation = await (await request(f, `/api/workspaces/${ws}/invitations`, { recipientAccountId: f.bob, recipientLabel: "Private recipient", role: "viewer" })).json();
    const invitations = await (await request(f, `/api/workspaces/${ws}/export`, { password, section: "invitations" })).json();
    assert.equal(invitations.records.length, 1);
    for (const value of [first, second, invitations]) assert.doesNotMatch(JSON.stringify(value), /token_hash|password_hash|recovery_hash|"salt"|"lease"/);
    assert.equal((await request(f, "/api/invitations/accept", { token: invitation.token }, f.bobToken)).status, 200);
    assert.equal((await request(f, `/api/workspaces/${ws}/export`, { password }, f.bobToken)).status, 403);
  } finally { f.sqlite.close(); }
});

test("retention purges expired history, preserves active conversation trees and policy library", async () => {
  const f = await fixture();
  try {
    await credentials(f);
    assert.equal((await request(f, `/api/workspaces/${f.alice}/retention`, { password, workspaceName: "wrong", retentionDays: 7 })).status, 400);
    const settings = await request(f, `/api/workspaces/${f.alice}/retention`, { password, workspaceName: "Personal workspace", retentionDays: 7 });
    assert.equal(settings.status, 200);
    const expired = oldReview(f), retained = oldReview(f);
    const auditId = crypto.randomUUID();
    f.sqlite.prepare("INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id,metadata_json) VALUES(?,?,?,'review.approved',?,?)").run(auditId, f.alice, f.alice, expired, JSON.stringify({ note: "Fictional sensitive decision text" }));
    f.sqlite.prepare("INSERT INTO review_attestations(id,review_id,workspace_id,decided_by,revision,policy_applicability_confirmed,account_facts_checked,evidence_inspected,policy_scope_json) VALUES(?,?,?,?,1,1,1,1,'[]')").run(crypto.randomUUID(), expired, f.alice, f.alice);
    const root = crypto.randomUUID(), child = crypto.randomUUID();
    const insertTurn = f.sqlite.prepare("INSERT INTO chat_turns(id,workspace_id,user_id,request_key,request_hash,parent_id,question,document_ids_json,answer,review_id,state,lease,lease_until,created_at) VALUES(?,?,?,?,?,?,'Fictional question','[]','Fictional answer',?,'completed','lease',0,?)");
    insertTurn.run(root, f.alice, f.alice, root, root, null, retained, "2000-01-01 00:00:00");
    insertTurn.run(child, f.alice, f.alice, child, child, root, null, new Date().toISOString().slice(0, 19).replace("T", " "));
    const doc = await request(f, "/api/documents", { title: "Retained policy", version: "v1", content: "Retain this policy library until workspace deletion." });
    assert.equal(doc.status, 201);
    const purge = await (await request(f, `/api/workspaces/${f.alice}/purge`, { password, workspaceName: "Personal workspace" })).json();
    assert.equal(purge.removed.reviews, 1);
    assert.equal(f.sqlite.prepare("SELECT id FROM support_reviews WHERE id=?").get(expired), undefined);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM review_attestations WHERE review_id=?").get(expired)!.n, 0);
    assert.deepEqual(JSON.parse(String(f.sqlite.prepare("SELECT metadata_json FROM audit_events WHERE id=?").get(auditId)!.metadata_json)), { contentRemovedByRetention: true });
    assert.ok(f.sqlite.prepare("SELECT id FROM support_reviews WHERE id=?").get(retained));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM chat_turns").get()!.n, 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_documents").get()!.n, 1);
    assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    // The scheduled path respects migration-preserved opt-out until the owner enables it.
    f.sqlite.prepare("UPDATE workspaces SET retention_enabled=0 WHERE id=?").run(f.alice);
    const legacy = oldReview(f);
    await scheduledCleanup(f.env.DB);
    assert.ok(f.sqlite.prepare("SELECT id FROM support_reviews WHERE id=?").get(legacy));
  } finally { f.sqlite.close(); }
});

test("workspace deletion removes dependent records and account erasure revokes sessions without deleting another team's history", async () => {
  const f = await fixture();
  try {
    await credentials(f);
    const ws = (await (await request(f, "/api/workspaces", { name: "Delete me" })).json()).id;
    await admit(f.env, ws, f.aliceToken, f.bobToken);
    assert.equal((await request(f, "/api/account/delete", { password, confirm: "DELETE" })).status, 409);
    assert.equal((await request(f, `/api/workspaces/${ws}/delete`, { password, workspaceName: "Delete me", confirm: "DELETE" }, f.bobToken)).status, 403);
    assert.equal((await request(f, `/api/workspaces/${ws}/delete`, { password, workspaceName: "Wrong name", confirm: "DELETE" })).status, 400);
    assert.equal((await request(f, `/api/workspaces/${ws}/delete`, { password, workspaceName: "Delete me", confirm: "DELETE" })).status, 200);
    assert.equal(f.sqlite.prepare("SELECT id FROM workspaces WHERE id=?").get(ws), undefined);
    const other = (await (await request(f, "/api/workspaces", { name: "Other owner's team" }, f.bobToken)).json()).id;
    await admit(f.env, other, f.bobToken, f.aliceToken, "reviewer");
    f.sqlite.prepare("INSERT INTO support_documents(id,workspace_id,user_id,title,version,content,content_hash) VALUES(?,?,?,'Shared policy','v1','Team-owned content remains','hash')").run(crypto.randomUUID(), other, f.alice);
    const erased = await request(f, "/api/account/delete", { password, confirm: "DELETE" });
    assert.equal(erased.status, 200);
    assert.equal((await request(f, "/api/workspaces")).status, 401);
    const user = f.sqlite.prepare("SELECT * FROM users WHERE id=?").get(f.alice)!;
    assert.equal(user.disabled, 1);
    assert.equal(user.recovery_hash, null);
    assert.notEqual(user.email, "alice@example.test");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_documents WHERE workspace_id=?").get(other)!.n, 1);
    assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.sqlite.close(); }
});

test("AI reservations are shared, atomic and charged even when provider fails; rejection never invokes provider", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const ai = budgetedAI(f.env.DB, { async run() { calls++; throw new Error("controlled provider failure"); } });
    const input = { messages: [{ role: "user", content: "fictional" }], max_tokens: 100 };
    await assert.rejects(ai.run("fixture", input), /controlled provider failure/);
    assert.equal(calls, 1);
    const day = new Date().toISOString().slice(0, 10);
    f.sqlite.prepare("UPDATE ai_budget SET calls=? WHERE day=?").run(AI_CAPACITY.callsPerDay - 1, day);
    const attempts = await Promise.allSettled([ai.run("fixture", input), ai.run("fixture", input)]);
    assert.equal(attempts.filter((r) => r.status === "rejected" && r.reason.code === "AI_CAPACITY_EXHAUSTED").length, 1);
    assert.equal(calls, 2);
    assert.equal(f.sqlite.prepare("SELECT calls FROM ai_budget WHERE day=?").get(day)!.calls, AI_CAPACITY.callsPerDay);
    await assert.rejects(ai.run("fixture", { max_tokens: 99999 }), { code: "AI_REQUEST_LIMIT" });
    assert.equal(calls, 2);
  } finally { f.sqlite.close(); }
});

test("AI budgets measure UTF-8 bytes and retain reservations after a local timeout", async () => {
  const f = await fixture();
  try {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const ai = budgetedAI(f.env.DB, { run() { return promise; } });
    const input = { messages: [{ role: "user", content: "非ASCII政策" }], max_tokens: 400 };
    const work = ai.run("fixture", input);
    await assert.rejects(withTimeout(work, 5), /timed out/);
    const used = f.sqlite.prepare("SELECT input_bytes,output_tokens,calls FROM ai_budget").get()!;
    assert.equal(used.input_bytes, Buffer.byteLength(JSON.stringify(input), "utf8"));
    assert.ok(Number(used.input_bytes) > JSON.stringify(input).length);
    assert.equal(used.output_tokens, 400);
    assert.equal(used.calls, 1);
    resolve({ response: "{}" });
    await work;
    const status = await (await request(f, "/api/usage")).json();
    assert.equal(status.sharedAi.remaining.calls, AI_CAPACITY.callsPerDay - 1);
    assert.equal(status.sharedAi.providerUsageMeasured, false);
  } finally { f.sqlite.close(); }
});

test("purge and its audit event roll back together when audit storage fails", async () => {
  const f = await fixture();
  try {
    await credentials(f);
    const id = oldReview(f);
    f.sqlite.exec("CREATE TRIGGER reject_purge_audit BEFORE INSERT ON audit_events WHEN NEW.action='workspace.retention_applied' BEGIN SELECT RAISE(ABORT,'controlled audit failure'); END");
    const response = await request(f, `/api/workspaces/${f.alice}/purge`, { password, workspaceName: "Personal workspace" });
    assert.equal(response.status, 500);
    assert.ok(f.sqlite.prepare("SELECT id FROM support_reviews WHERE id=?").get(id));
    assert.equal(f.sqlite.prepare("SELECT deleting FROM workspaces WHERE id=?").get(f.alice)!.deleting, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='workspace.retention_applied'").get()!.n, 0);
  } finally { f.sqlite.close(); }
});

test("destructive transaction rechecks the exact session after password hashing awaits", async () => {
  const f = await fixture();
  let interception: { mock: { restore(): void } } | undefined;
  try {
    await credentials(f);
    const id = oldReview(f);
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    interception = mock.method(crypto.subtle, "deriveBits", async (algorithm: AlgorithmIdentifier, key: CryptoKey, length: number | null) => {
      const bits = await derive(algorithm, key, length);
      f.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(f.alice);
      return bits;
    });
    const response = await request(f, `/api/workspaces/${f.alice}/delete`, { password, workspaceName: "Personal workspace", confirm: "DELETE" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LIFECYCLE_CONFLICT");
    assert.ok(f.sqlite.prepare("SELECT id FROM support_reviews WHERE id=?").get(id));
    assert.equal(f.sqlite.prepare("SELECT deleting FROM workspaces WHERE id=?").get(f.alice)!.deleting, 0);
  } finally { interception?.mock.restore(); f.sqlite.close(); }
});

test("a full bounded workspace export crosses 120 pages without the mutation limiter truncating it", async () => {
  const f = await fixture();
  try {
    await credentials(f);
    const evidenceIds = Array.from({ length: 10 }, () => crypto.randomUUID());
    const addEvidence = f.sqlite.prepare("INSERT INTO evidence_items(id,workspace_id,user_id,kind,title,note,source_url,content_hash,status) VALUES(?,?,?,'link','Fixture reference','Fictional context','https://example.test/policy','hash','approved')");
    for (const id of evidenceIds) addEvidence.run(id, f.alice, f.alice);
    const addAttachment = f.sqlite.prepare("INSERT INTO review_attachments(id,workspace_id,review_id,item_id,user_id,note) VALUES(?,?,?,?,?,'Fictional evidence note')");
    for (let n = 0; n < 500; n++) {
      const review = oldReview(f);
      for (const item of evidenceIds) addAttachment.run(crypto.randomUUID(), f.alice, review, item, f.alice);
    }
    const addAudit = f.sqlite.prepare("INSERT INTO audit_events(id,workspace_id,actor_id,action,object_id) VALUES(?,?,?,'fixture.governance',?)");
    for (let n = 0; n < 5000; n++) addAudit.run(crypto.randomUUID(), f.alice, f.alice, f.alice);
    let section: string | null = "documents";
    let cursor: string | null = null;
    let requests = 0;
    const counts: Record<string, number> = {};
    while (section) {
      const response = await request(f, `/api/workspaces/${f.alice}/export`, { password, section, cursor });
      assert.equal(response.status, 200);
      const page = await response.json();
      counts[section] = (counts[section] ?? 0) + page.records.length;
      requests++;
      cursor = page.nextCursor;
      if (!cursor) section = page.nextSection;
    }
    assert.ok(requests > 120);
    assert.equal(counts.reviews, 500);
    assert.equal(counts.attachments, 5000);
    assert.equal(counts.audit, 5000);
    assert.equal(counts.evidence, 10);
    assert.equal(counts.members, 1);
  } finally { f.sqlite.close(); }
});

test("account deletion does not need spare capacity to create a personal workspace", async () => {
  const f = await fixture();
  try {
    const salt = newSalt();
    f.sqlite.prepare("UPDATE users SET password_hash=?,salt=? WHERE id=?").run(await hashPassword(password, salt), salt, f.alice);
    const addWorkspace = f.sqlite.prepare("INSERT INTO workspaces(id,name,owner_id) VALUES(?,'Capacity fixture',?)");
    for (let i = 0; i < 1000; i++) addWorkspace.run(crypto.randomUUID(), f.bob);
    assert.equal((await request(f, "/api/account/delete", { password, confirm: "DELETE" })).status, 200);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspaces").get()!.n, 1000);
    assert.equal(f.sqlite.prepare("SELECT disabled FROM users WHERE id=?").get(f.alice)!.disabled, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(f.alice)!.n, 0);
  } finally { f.sqlite.close(); }
});

test("a public account label cannot preclaim another account's deletion replacement", async () => {
  for (const provisioned of [false, true]) {
    const f = await fixture();
    try {
      const salt = newSalt();
      f.sqlite.prepare("UPDATE users SET password_hash=?,salt=? WHERE id=?").run(await hashPassword(password, salt), salt, f.alice);
      if (provisioned) await request(f, "/api/workspaces");
      const reserved = await request(f, "/api/auth/signup", { email: `deleted-${f.alice}@invalid.test`, password });
      assert.equal(reserved.status, 201);
      const erased = await request(f, "/api/account/delete", { password, confirm: "DELETE" });
      assert.equal(erased.status, 200);
      const actor = f.sqlite.prepare("SELECT email,disabled FROM users WHERE id=?").get(f.alice)!;
      assert.equal(actor.disabled, 1);
      assert.notEqual(actor.email, `deleted-${f.alice}@invalid.test`);
      assert.equal((await request(f, "/api/auth/me")).status, 401);
    } finally { f.sqlite.close(); }
  }
});
