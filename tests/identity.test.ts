/**
 * identity.test.ts — who Veriq lets into a team workspace, and on what proof.
 *
 * Every assertion goes through the production request handler. The TOTP codes
 * are computed here from node:crypto HMAC-SHA1 rather than from the
 * implementation under test, so a broken generator cannot agree with itself.
 *
 * These fixtures prove the authorisation rules. They say nothing about any real
 * account, mailbox or person: an email in Veriq is a label its holder typed,
 * and a second factor proves a second secret, not a second human being.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import api from "../apps/api/src/index.ts";
import type { Env } from "../apps/api/src/index.ts";
import { database, fakeAI } from "./helpers.ts";
import { createSession } from "../apps/api/src/auth.ts";
import { currentStep, openSeed } from "../apps/api/src/mfa.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const PASSWORD = "orbit-ledger-passphrase";

/** RFC 6238 reference, independent of apps/api/src/mfa.ts. */
function code(seed: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", Buffer.from(seed)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

/** RFC 4648 base32 decode, for turning an enrolment secret back into bytes. */
function unbase32(secret: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let value = 0,
    bits = 0;
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function workspaceApi() {
  const { sqlite, db } = database();
  const env: Env = {
    DB: db,
    AI: fakeAI(),
    WEB_ORIGIN: "http://localhost:8788",
    WORKERS_FREE_PLAN_CONFIRMED: "true",
    MFA_ENCRYPTION_KEY: KEY,
  };
  return { sqlite, db, env };
}

interface Options {
  cookie?: string;
  body?: unknown;
  workspace?: string;
  ip?: string;
}

function request(env: Env, path: string, options: Options = {}) {
  const { cookie, body, workspace, ip = "198.51.100.1" } = options;
  return api.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-connecting-ip": ip,
        ...(cookie ? { cookie: `__Host-veriq_session=${cookie}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(workspace ? { "x-workspace-id": workspace } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

function session(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  return /__Host-veriq_session=([a-f0-9]{64})/.exec(cookie)?.[1] ?? "";
}

interface Account {
  id: string;
  email: string;
  recoveryCode: string;
  seed: Uint8Array;
  cookie: string;
}

/** A signed-up account that has enrolled a second factor and proved it. */
async function account(
  env: Env,
  email: string,
  ip = "198.51.100.1",
): Promise<Account> {
  const created = await request(env, "/api/auth/signup", {
    body: { email, password: PASSWORD },
    ip,
  });
  assert.equal(created.status, 201);
  const identity = await created.json();
  assert.equal(identity.user.mfaEnabled, false);
  assert.equal(identity.identityAssurance, "unverified_label");
  const enrolment = await request(env, "/api/auth/mfa/enroll", {
    body: { password: PASSWORD },
    cookie: session(created),
    ip,
  });
  assert.equal(enrolment.status, 200);
  const seed = unbase32((await enrolment.json()).secret);
  const proof = await request(env, "/api/auth/mfa/confirm", {
    body: { password: PASSWORD, code: code(seed, currentStep()) },
    cookie: session(created),
    ip,
  });
  assert.equal(proof.status, 200);
  return {
    id: identity.user.id,
    email,
    recoveryCode: identity.recoveryCode,
    seed,
    cookie: session(proof),
  };
}

async function team(env: Env, owner: Account): Promise<string> {
  const created = await request(env, "/api/workspaces", {
    body: { name: "Support operations" },
    cookie: owner.cookie,
  });
  assert.equal(created.status, 201);
  return (await created.json()).id as string;
}

/** Issue an invitation and return the token that is shown exactly once. */
async function invite(
  env: Env,
  workspace: string,
  issuer: Account,
  recipient: Account,
  role = "admin",
) {
  const created = await request(
    env,
    `/api/workspaces/${workspace}/invitations`,
    {
      body: {
        recipientAccountId: recipient.id,
        recipientLabel: recipient.email,
        role,
      },
      cookie: issuer.cookie,
    },
  );
  assert.equal(created.status, 200);
  const issued = await created.json();
  assert.equal(issued.invitation.role, role);
  assert.equal(issued.invitation.workspaceId, workspace);
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  return { id: issued.invitation.id as string, token: issued.token as string };
}

function reads(env: Env, workspace: string, cookie: string) {
  return request(env, "/api/documents", { workspace, cookie });
}

test("a squatted email label grants no team access; only an accepted invitation does", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    // Someone registers the label the owner would have typed into the old
    // "add a teammate by email" box.
    const squatter = await account(env, "ops@partner.test", "198.51.100.2");
    const teammate = await account(env, "real@partner.test", "198.51.100.3");

    const retired = await request(env, `/api/workspaces/${workspace}/members`, {
      body: { email: "ops@partner.test", role: "admin" },
      cookie: owner.cookie,
    });
    assert.equal(retired.status, 410);
    assert.equal((await retired.json()).code, "MEMBER_CREATE_RETIRED");
    assert.equal((await reads(env, workspace, squatter.cookie)).status, 404);

    const invitation = await invite(env, workspace, owner, teammate);
    // The squatter holding the token is still not the bound recipient.
    const stolen = await request(env, "/api/invitations/accept", {
      body: { token: invitation.token },
      cookie: squatter.cookie,
    });
    assert.equal(stolen.status, 409);
    assert.equal((await reads(env, workspace, squatter.cookie)).status, 404);
    // A rejected attempt must not consume the invitation.
    assert.equal(
      sqlite
        .prepare("SELECT consumed_at FROM workspace_invitations WHERE id=?")
        .get(invitation.id)!.consumed_at,
      null,
    );

    const accepted = await request(env, "/api/invitations/accept", {
      body: { token: invitation.token },
      cookie: teammate.cookie,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      workspaceId: workspace,
      role: "admin",
    });
    assert.equal((await reads(env, workspace, teammate.cookie)).status, 200);

    // One token, one admission.
    const replay = await request(env, "/api/invitations/accept", {
      body: { token: invitation.token },
      cookie: teammate.cookie,
    });
    assert.equal(replay.status, 409);

    const events = (
      await (
        await request(env, `/api/workspaces/${workspace}/audit`, {
          cookie: owner.cookie,
        })
      ).json()
    ).events.map((event: { action: string }) => event.action);
    assert.ok(events.includes("invitation.created"));
    assert.ok(events.includes("invitation.accepted"));
  } finally {
    sqlite.close();
  }
});

test("an invitation cannot be escalated, revived after revocation or used after expiry", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    const viewer = await account(env, "viewer@partner.test", "198.51.100.2");
    const later = await account(env, "later@partner.test", "198.51.100.3");
    const admin = await account(env, "admin@partner.test", "198.51.100.4");

    // The role travels with the stored invitation, never with the request body.
    const viewerInvite = await invite(env, workspace, owner, viewer, "viewer");
    const accepted = await request(env, "/api/invitations/accept", {
      body: { token: viewerInvite.token, role: "owner" },
      cookie: viewer.cookie,
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).role, "viewer");
    assert.equal(
      sqlite
        .prepare(
          "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
        )
        .get(workspace, viewer.id)!.role,
      "viewer",
    );
    // A viewer cannot turn round and issue invitations of their own.
    assert.equal(
      (
        await request(env, `/api/workspaces/${workspace}/invitations`, {
          body: {
            recipientAccountId: later.id,
            recipientLabel: later.email,
            role: "viewer",
          },
          cookie: viewer.cookie,
        })
      ).status,
      403,
    );
    // Nor can an administrator appoint another administrator.
    const adminInvite = await invite(env, workspace, owner, admin, "admin");
    assert.equal(
      (
        await request(env, "/api/invitations/accept", {
          body: { token: adminInvite.token },
          cookie: admin.cookie,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(env, `/api/workspaces/${workspace}/invitations`, {
          body: {
            recipientAccountId: later.id,
            recipientLabel: later.email,
            role: "admin",
          },
          cookie: admin.cookie,
        })
      ).status,
      403,
    );

    // An invitation must name a different account.
    const self = await request(
      env,
      `/api/workspaces/${workspace}/invitations`,
      {
        body: {
          recipientAccountId: owner.id,
          recipientLabel: owner.email,
          role: "viewer",
        },
        cookie: owner.cookie,
      },
    );
    assert.equal(self.status, 409);
    assert.equal((await self.json()).code, "SELF_INVITATION");

    const revoked = await invite(env, workspace, owner, later, "reviewer");
    assert.equal(
      (
        await request(
          env,
          `/api/workspaces/${workspace}/invitations/${revoked.id}/revoke`,
          { body: {}, cookie: owner.cookie },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(env, "/api/invitations/accept", {
          body: { token: revoked.token },
          cookie: later.cookie,
        })
      ).status,
      409,
    );

    const stale = await invite(env, workspace, owner, later, "reviewer");
    sqlite
      .prepare("UPDATE workspace_invitations SET expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", stale.id);
    assert.equal(
      (
        await request(env, "/api/invitations/accept", {
          body: { token: stale.token },
          cookie: later.cookie,
        })
      ).status,
      409,
    );
    assert.equal((await reads(env, workspace, later.cookie)).status, 404);
  } finally {
    sqlite.close();
  }
});

test("a membership the migration suspended cannot read until the real account is re-invited", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    const legacy = await account(env, "legacy@partner.test", "198.51.100.2");
    // Exactly the row shape 0006 leaves behind: granted by an email lookup
    // that proved nothing, so admitted_at stays NULL.
    sqlite
      .prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,admitted_at) VALUES(?,?,'reviewer',NULL)",
      )
      .run(workspace, legacy.id);

    assert.equal((await reads(env, workspace, legacy.cookie)).status, 404);
    assert.equal(
      (
        await (
          await request(env, "/api/workspaces", { cookie: legacy.cookie })
        ).json()
      ).workspaces.some((listed: { id: string }) => listed.id === workspace),
      false,
    );
    // The suspended row stays visible to an administrator, and says why.
    const member = (
      await (
        await request(env, `/api/workspaces/${workspace}/members`, {
          cookie: owner.cookie,
        })
      ).json()
    ).members.find((row: { user_id: string }) => row.user_id === legacy.id);
    assert.equal(member.admitted_at, null);

    const invitation = await invite(env, workspace, owner, legacy, "viewer");
    assert.equal(
      (
        await request(env, "/api/invitations/accept", {
          body: { token: invitation.token },
          cookie: legacy.cookie,
        })
      ).status,
      200,
    );
    const admitted = sqlite
      .prepare(
        "SELECT role,admitted_at FROM workspace_members WHERE workspace_id=? AND user_id=?",
      )
      .get(workspace, legacy.id)!;
    assert.equal(admitted.role, "viewer");
    assert.notEqual(admitted.admitted_at, null);
    assert.equal((await reads(env, workspace, legacy.cookie)).status, 200);
  } finally {
    sqlite.close();
  }
});

test("team access needs a session that proved a code, and fails closed without a usable key", async () => {
  const { sqlite, db, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);

    // A cookie from before enrolment, which is what every session row carries
    // after the migration. The account is enrolled; this session is not.
    const legacyCookie = await createSession(db, owner.id);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS unverified FROM sessions WHERE user_id=? AND mfa_verified=0",
        )
        .get(owner.id)!.unverified,
      1,
    );
    const blocked = await reads(env, workspace, legacyCookie);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "MFA_REQUIRED");
    // The same unverified cookie still reaches the account's own workspace.
    assert.equal(
      (await request(env, "/api/documents", { cookie: legacyCookie })).status,
      200,
    );
    assert.equal(
      (await request(env, "/api/auth/me", { cookie: legacyCookie })).status,
      200,
    );

    // An enrolled account must not be able to sign in on its password alone.
    const noCode = await request(env, "/api/auth/login", {
      body: { email: owner.email, password: PASSWORD },
      ip: "198.51.100.9",
    });
    assert.equal(noCode.status, 401);
    assert.equal((await noCode.json()).code, "INVALID_CREDENTIALS");
    assert.equal(session(noCode), "");

    for (const key of [undefined, OTHER_KEY]) {
      env.MFA_ENCRYPTION_KEY = key;
      const unusable = await reads(env, workspace, owner.cookie);
      assert.equal(unusable.status, 503);
      assert.equal((await unusable.json()).code, "MFA_UNAVAILABLE");
      // Reading your own workspace is not gated on the operator's key.
      assert.equal(
        (await request(env, "/api/documents", { cookie: owner.cookie })).status,
        200,
      );
      const locked = await request(env, "/api/auth/login", {
        body: {
          email: owner.email,
          password: PASSWORD,
          code: code(owner.seed, currentStep()),
        },
        ip: "198.51.100.10",
      });
      assert.equal(locked.status, 503);
      assert.equal((await locked.json()).code, "MFA_UNAVAILABLE");
      assert.equal(session(locked), "");
    }
    env.MFA_ENCRYPTION_KEY = KEY;
    assert.equal((await reads(env, workspace, owner.cookie)).status, 200);
  } finally {
    sqlite.close();
  }
});

test("a sealed second factor is bound to one account, one purpose and one key", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const other = await account(env, "other@example.test", "198.51.100.2");
    const sealed = sqlite
      .prepare("SELECT mfa_seed FROM users WHERE id=?")
      .get(owner.id)!.mfa_seed as string;

    assert.deepEqual(
      [...(await openSeed(sealed, KEY, owner.id, "active"))],
      [...owner.seed],
    );
    // Lifted into another account's row, or presented as a pending enrolment,
    // the very same ciphertext does not open at all.
    for (const open of [
      () => openSeed(sealed, KEY, other.id, "active"),
      () => openSeed(sealed, KEY, owner.id, "enrollment"),
      () => openSeed(sealed, OTHER_KEY, owner.id, "active"),
      () => openSeed(sealed, undefined, owner.id, "active"),
    ])
      await assert.rejects(open, { code: "MFA_UNAVAILABLE" });
  } finally {
    sqlite.close();
  }
});

test("a code works once, tolerates one step of clock skew and no more", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    // Confirmation already consumed its step. Advance the server clock before
    // testing an unused code from the previous accepted skew window.
    mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
    const step = currentStep();

    // The previous step is still inside the accepted window.
    const skewed = await request(env, "/api/auth/login", {
      body: {
        email: owner.email,
        password: PASSWORD,
        code: code(owner.seed, step - 1),
      },
      ip: "198.51.100.2",
    });
    assert.equal(skewed.status, 200);
    assert.equal((await skewed.json()).user.mfaEnabled, true);
    assert.match(session(skewed), /^[a-f0-9]{64}$/);

    // Replaying it is refused, and refused identically to a wrong code.
    const validCodes = [-1, 0, 1].map((offset) => code(owner.seed, step + offset));
    let wrongCode = "000000";
    while (validCodes.includes(wrongCode)) wrongCode = String(Number(wrongCode) + 1).padStart(6, "0");
    for (const presented of [code(owner.seed, step - 1), wrongCode]) {
      const refused = await request(env, "/api/auth/login", {
        body: { email: owner.email, password: PASSWORD, code: presented },
        ip: "198.51.100.3",
      });
      assert.equal(refused.status, 401);
      assert.equal((await refused.json()).code, "INVALID_CREDENTIALS");
      assert.equal(session(refused), "");
    }
    // Far outside the window, even an arithmetically correct code is dead.
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: {
            email: owner.email,
            password: PASSWORD,
            code: code(owner.seed, step - 5),
          },
          ip: "198.51.100.4",
        })
      ).status,
      401,
    );
    // The next step is still above the consumed one, so it works.
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: {
            email: owner.email,
            password: PASSWORD,
            code: code(owner.seed, step + 1),
          },
          ip: "198.51.100.5",
        })
      ).status,
      200,
    );
    assert.equal(
      sqlite
        .prepare("SELECT mfa_last_step FROM users WHERE id=?")
        .get(owner.id)!.mfa_last_step,
      step + 1,
    );
  } finally {
    mock.timers.reset();
    sqlite.close();
  }
});

test("two concurrent sign-ins cannot consume the same TOTP step twice", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const step = currentStep() + 1;
    const presented = code(owner.seed, step);
    const attempt = (ip: string) =>
      request(env, "/api/auth/login", {
        body: { email: owner.email, password: PASSWORD, code: presented },
        ip,
      });
    const results = await Promise.all([
      attempt("198.51.100.2"),
      attempt("198.51.100.3"),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 401],
    );
    // Exactly one new session, and the step is burned.
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS live FROM sessions WHERE user_id=?")
        .get(owner.id)!.live,
      2,
    );
    assert.equal(
      sqlite
        .prepare("SELECT mfa_last_step FROM users WHERE id=?")
        .get(owner.id)!.mfa_last_step,
      step,
    );
  } finally {
    sqlite.close();
  }
});

test("recovery is single-use, rotates its own code and ends every session", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const created = await request(env, "/api/auth/signup", {
      body: { email: "solo@example.test", password: PASSWORD },
    });
    assert.equal(created.status, 201);
    const identity = await created.json();
    const cookie = session(created);
    assert.match(identity.recoveryCode, /^[a-f0-9]{64}$/);
    assert.equal(
      (await (await request(env, "/api/auth/me", { cookie })).json())
        .recoveryAvailable,
      true,
    );

    const NEXT = "second-orbit-passphrase";
    const attempt = () =>
      request(env, "/api/auth/recover", {
        body: {
          email: "solo@example.test",
          recoveryCode: identity.recoveryCode,
          password: NEXT,
        },
        ip: "198.51.100.2",
      });
    const [first, second] = await Promise.all([attempt(), attempt()]);
    assert.deepEqual([first.status, second.status].sort(), [200, 401]);
    const winner = first.status === 200 ? first : second;
    const rotated = await winner.json();
    assert.match(rotated.recoveryCode, /^[a-f0-9]{64}$/);
    assert.notEqual(rotated.recoveryCode, identity.recoveryCode);
    // Recovery hands back no session: the new password has to be used.
    assert.equal(session(winner), "");

    // The old password and the old cookie are both finished.
    assert.equal((await request(env, "/api/auth/me", { cookie })).status, 401);
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: { email: "solo@example.test", password: PASSWORD },
          ip: "198.51.100.3",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: { email: "solo@example.test", password: NEXT },
          ip: "198.51.100.4",
        })
      ).status,
      200,
    );

    // The spent code is dead and the rotated one works exactly once more.
    assert.equal(
      (
        await request(env, "/api/auth/recover", {
          body: {
            email: "solo@example.test",
            recoveryCode: identity.recoveryCode,
            password: "third-orbit-passphrase",
          },
          ip: "198.51.100.5",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(env, "/api/auth/recover", {
          body: {
            email: "solo@example.test",
            recoveryCode: rotated.recoveryCode,
            password: "third-orbit-passphrase",
          },
          ip: "198.51.100.6",
        })
      ).status,
      200,
    );
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS live FROM sessions WHERE user_id=?")
        .get(identity.user.id)!.live,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("recovery clears an enrolled second factor so a lost authenticator is not a dead end", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    const NEXT = "second-orbit-passphrase";
    const recovered = await request(env, "/api/auth/recover", {
      body: {
        email: owner.email,
        recoveryCode: owner.recoveryCode,
        password: NEXT,
      },
      ip: "198.51.100.2",
    });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).mfaEnabled, false);
    assert.equal(
      sqlite.prepare("SELECT mfa_seed FROM users WHERE id=?").get(owner.id)!
        .mfa_seed,
      null,
    );
    // Back in with the password alone, but team work waits for a new factor.
    const signedIn = await request(env, "/api/auth/login", {
      body: { email: owner.email, password: NEXT },
      ip: "198.51.100.3",
    });
    assert.equal(signedIn.status, 200);
    assert.equal((await signedIn.json()).user.mfaEnabled, false);
    const stillOwner = await reads(env, workspace, session(signedIn));
    assert.equal(stillOwner.status, 403);
    assert.equal((await stillOwner.json()).code, "MFA_REQUIRED");
    // The workspace and its owner membership survived untouched.
    assert.equal(
      sqlite
        .prepare(
          "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
        )
        .get(workspace, owner.id)!.role,
      "owner",
    );
  } finally {
    sqlite.close();
  }
});

test("rotating credentials ends every session and needs the current second factor", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const NEXT = "second-orbit-passphrase";
    const rotationStep = currentStep() + 1;
    // The password alone cannot mint a fresh recovery code for an enrolled
    // account, because that code is a standalone way back in.
    const unproved = await request(env, "/api/auth/security", {
      body: { password: PASSWORD },
      cookie: owner.cookie,
    });
    assert.equal(unproved.status, 401);
    const rotated = await request(env, "/api/auth/security", {
      body: {
        password: PASSWORD,
        newPassword: NEXT,
        code: code(owner.seed, rotationStep),
      },
      cookie: owner.cookie,
    });
    assert.equal(rotated.status, 200);
    const issued = await rotated.json();
    assert.match(issued.recoveryCode, /^[a-f0-9]{64}$/);
    assert.notEqual(issued.recoveryCode, owner.recoveryCode);
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS live FROM sessions WHERE user_id=?")
        .get(owner.id)!.live,
      0,
    );
    assert.equal(
      (await request(env, "/api/auth/me", { cookie: owner.cookie })).status,
      401,
    );
    // The code it consumed cannot be presented again.
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: {
            email: owner.email,
            password: NEXT,
            code: code(owner.seed, rotationStep),
          },
          ip: "198.51.100.2",
        })
      ).status,
      401,
    );
    mock.timers.enable({ apis: ["Date"], now: rotationStep * 30_000 });
    assert.equal(
      (
        await request(env, "/api/auth/login", {
          body: {
            email: owner.email,
            password: NEXT,
            code: code(owner.seed, rotationStep + 1),
          },
          ip: "198.51.100.3",
        })
      ).status,
      200,
    );
    // The superseded recovery code went with the rotation.
    assert.equal(
      (
        await request(env, "/api/auth/recover", {
          body: {
            email: owner.email,
            recoveryCode: owner.recoveryCode,
            password: "third-orbit-passphrase",
          },
          ip: "198.51.100.4",
        })
      ).status,
      401,
    );
  } finally {
    mock.timers.reset();
    sqlite.close();
  }
});

test("a sign-in cannot mint a session against credentials that changed while it verified", async () => {
  const { sqlite, db, env } = workspaceApi();
  try {
    const created = await request(env, "/api/auth/signup", {
      body: { email: "solo@example.test", password: PASSWORD },
    });
    assert.equal(created.status, 201);
    const identity = await created.json();
    sqlite
      .prepare("DELETE FROM sessions WHERE user_id=?")
      .run(identity.user.id);

    // Password verification is deliberately slow and a recovery can land
    // inside that window, so rotate the credentials at the moment the handler
    // starts writing its session.
    let interleaved = false;
    env.DB = {
      ...db,
      batch(statements: D1PreparedStatement[]) {
        if (!interleaved) {
          interleaved = true;
          sqlite
            .prepare("UPDATE users SET password_hash=?,salt=? WHERE id=?")
            .run("rotated-hash", "rotated-salt", identity.user.id);
        }
        return db.batch(statements);
      },
    };
    const raced = await request(env, "/api/auth/login", {
      body: { email: "solo@example.test", password: PASSWORD },
      ip: "198.51.100.2",
    });
    assert.ok(interleaved);
    assert.equal(raced.status, 401);
    assert.equal((await raced.json()).code, "INVALID_CREDENTIALS");
    assert.equal(session(raced), "");
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS live FROM sessions WHERE user_id=?")
        .get(identity.user.id)!.live,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("nothing that can be listed carries a token, a seed or a digest", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    const teammate = await account(env, "real@partner.test", "198.51.100.2");
    const invitation = await invite(
      env,
      workspace,
      owner,
      teammate,
      "reviewer",
    );

    const listing = await (
      await request(env, `/api/workspaces/${workspace}/invitations`, {
        cookie: owner.cookie,
      })
    ).text();
    assert.ok(listing.includes(invitation.id));
    assert.ok(listing.includes("real@partner.test"));
    assert.doesNotMatch(listing, /[a-f0-9]{64}/);
    assert.doesNotMatch(listing, /token/i);

    for (const path of [
      "/api/auth/me",
      `/api/workspaces/${workspace}/members`,
      `/api/workspaces/${workspace}/audit`,
    ]) {
      const body = await (
        await request(env, path, { cookie: owner.cookie, workspace })
      ).text();
      assert.doesNotMatch(body, /[a-f0-9]{64}/);
      assert.doesNotMatch(
        body,
        /recovery_hash|mfa_seed|mfa_pending|token_hash/,
      );
    }
    // The stored forms really are digests and ciphertext, not the secrets.
    const stored = sqlite
      .prepare("SELECT recovery_hash,mfa_seed FROM users WHERE id=?")
      .get(owner.id)!;
    assert.notEqual(stored.recovery_hash, owner.recoveryCode);
    assert.doesNotMatch(stored.mfa_seed as string, /^[a-f0-9]{64}$/);
    assert.notEqual(
      sqlite
        .prepare("SELECT token_hash FROM workspace_invitations WHERE id=?")
        .get(invitation.id)!.token_hash,
      invitation.token,
    );
  } finally {
    sqlite.close();
  }
});

test("a workspace holds at most fifty admitted members and live invitations", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    const teammate = await account(env, "real@partner.test", "198.51.100.2");
    // Forty-nine issued-but-unaccepted invitations, each to its own account,
    // which together with the owner fill every seat.
    const addAccount = sqlite.prepare(
      "INSERT INTO users(id,email,password_hash,salt) VALUES(?,?,'hash','salt')",
    );
    const addInvitation = sqlite.prepare(
      `INSERT INTO workspace_invitations(id,workspace_id,token_hash,role,recipient_id,recipient_label,created_by,expires_at)
       VALUES(?,?,?,'viewer',?,'seat',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))`,
    );
    for (let seat = 0; seat < 49; seat++) {
      const id = crypto.randomUUID();
      addAccount.run(id, `seat-${seat}@partner.test`);
      addInvitation.run(
        crypto.randomUUID(),
        workspace,
        `seat-hash-${seat}`,
        id,
        owner.id,
      );
    }
    const full = await request(
      env,
      `/api/workspaces/${workspace}/invitations`,
      {
        body: {
          recipientAccountId: teammate.id,
          recipientLabel: teammate.email,
          role: "viewer",
        },
        cookie: owner.cookie,
      },
    );
    assert.equal(full.status, 409);
    assert.equal((await full.json()).code, "SEAT_LIMIT");
  } finally {
    sqlite.close();
  }
});

test("only an enrolled recipient can be invited, and an unknown account ID is not an invitation", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const workspace = await team(env, owner);
    // An account that signed up but never enrolled cannot be handed team
    // access, because its own session could never prove a second factor.
    const created = await request(env, "/api/auth/signup", {
      body: { email: "bare@partner.test", password: PASSWORD },
      ip: "198.51.100.2",
    });
    assert.equal(created.status, 201);
    const bare = await created.json();
    const refused = await request(
      env,
      `/api/workspaces/${workspace}/invitations`,
      {
        body: {
          recipientAccountId: bare.user.id,
          recipientLabel: "bare@partner.test",
          role: "viewer",
        },
        cookie: owner.cookie,
      },
    );
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "MFA_REQUIRED");
    // No email lookup stands in for an account ID.
    assert.equal(
      (
        await request(env, `/api/workspaces/${workspace}/invitations`, {
          body: {
            recipientAccountId: crypto.randomUUID(),
            recipientLabel: "nobody@partner.test",
            role: "viewer",
          },
          cookie: owner.cookie,
        })
      ).status,
      404,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS issued FROM workspace_invitations WHERE workspace_id=?",
        )
        .get(workspace)!.issued,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("password-only security and login requests cannot cross a concurrent MFA enrollment", { timeout: 10000 }, async () => {
  const { sqlite, env } = workspaceApi();
  const release = Promise.withResolvers<void>();
  let intercept: { mock: { restore(): void } } | undefined;
  try {
    const created = await request(env, "/api/auth/signup", { body: { email: "race@example.test", password: PASSWORD } });
    assert.equal(created.status, 201);
    const identity = await created.json();
    const cookie = session(created);
    const enrolled = await request(env, "/api/auth/mfa/enroll", { cookie, body: { password: PASSWORD } });
    assert.equal(enrolled.status, 200);
    const seed = unbase32((await enrolled.json()).secret);
    const before = sqlite.prepare("SELECT recovery_hash FROM users WHERE id=?").get(identity.user.id)!;
    const parked = Promise.withResolvers<void>();
    let waiting = 0;
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    intercept = mock.method(crypto.subtle, "deriveBits", async (algorithm: AlgorithmIdentifier, key: CryptoKey, length: number | null) => {
      const bits = await derive(algorithm, key, length);
      if (waiting < 2) {
        waiting++;
        if (waiting === 2) parked.resolve();
        await release.promise;
      }
      return bits;
    });
    const staleSecurity = request(env, "/api/auth/security", { cookie, body: { password: PASSWORD } });
    const staleLogin = request(env, "/api/auth/login", { body: { email: "race@example.test", password: PASSWORD }, ip: "198.51.100.2" });
    await parked.promise;
    const confirmed = await request(env, "/api/auth/mfa/confirm", { cookie, body: { password: PASSWORD, code: code(seed, currentStep()) } });
    release.resolve();
    const [security, login] = await Promise.all([staleSecurity, staleLogin]);
    assert.equal(confirmed.status, 200);
    assert.equal(security.status, 401);
    assert.equal(login.status, 401);
    assert.equal((await security.json()).code, "INVALID_CREDENTIALS");
    assert.equal(session(login), "");
    const after = sqlite.prepare("SELECT recovery_hash,mfa_seed FROM users WHERE id=?").get(identity.user.id)!;
    assert.ok(after.recovery_hash === before.recovery_hash);
    assert.ok(after.mfa_seed);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND mfa_verified=1").get(identity.user.id)!.n, 1);
  } finally { release.resolve(); intercept?.mock.restore(); sqlite.close(); }
});

test("membership removal permanently revokes outstanding recipient and issuer invitations", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const member = await account(env, "member@example.test", "198.51.100.2");
    const later = await account(env, "later@example.test", "198.51.100.3");
    const workspace = await team(env, owner);
    const admission = await invite(env, workspace, owner, member, "admin");
    assert.equal((await request(env, "/api/invitations/accept", { cookie: member.cookie, body: { token: admission.token } })).status, 200);
    const issuedByMember = await invite(env, workspace, member, later, "viewer");
    sqlite.prepare("UPDATE workspace_members SET admitted_at=NULL WHERE workspace_id=? AND user_id=?").run(workspace, member.id);
    const legacyReadmission = await invite(env, workspace, owner, member, "admin");
    const failedChange = await request(env, `/api/workspaces/${workspace}/members/${member.id}`, { cookie: owner.cookie, body: { role: "viewer" } });
    assert.equal(failedChange.status, 409);
    assert.equal(sqlite.prepare("SELECT revoked_at FROM workspace_invitations WHERE id=?").get(legacyReadmission.id)!.revoked_at, null);
    assert.equal((await request(env, `/api/workspaces/${workspace}/members/${member.id}`, { cookie: owner.cookie, body: { remove: true } })).status, 200);
    assert.equal((await request(env, "/api/invitations/accept", { cookie: member.cookie, body: { token: legacyReadmission.token } })).status, 409);
    const fresh = await invite(env, workspace, owner, member, "admin");
    assert.equal((await request(env, "/api/invitations/accept", { cookie: member.cookie, body: { token: fresh.token } })).status, 200);
    assert.equal((await request(env, "/api/invitations/accept", { cookie: later.cookie, body: { token: issuedByMember.token } })).status, 409);
    const freshLater = await invite(env, workspace, member, later, "viewer");
    assert.equal((await request(env, "/api/invitations/accept", { cookie: later.cookie, body: { token: freshLater.token } })).status, 200);
  } finally { sqlite.close(); }
});

test("a rejected TOTP replay cannot evict another live session at the session cap", async () => {
  const { sqlite, db, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test");
    for (let i = 0; i < 9; i++) await createSession(db, owner.id, null, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(owner.id)!.n, 10);
    const step = Number(sqlite.prepare("SELECT mfa_last_step FROM users WHERE id=?").get(owner.id)!.mfa_last_step);
    const replay = await request(env, "/api/auth/login", { body: { email: owner.email, password: PASSWORD, code: code(owner.seed, step) } });
    assert.equal(replay.status, 401);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(owner.id)!.n, 10);
  } finally { sqlite.close(); }
});

test("host-prefixed sessions ignore tossed legacy cookies and use the same contract for logout", async () => {
  const { sqlite, env } = workspaceApi();
  try {
    const owner = await account(env, "owner@example.test", "198.51.100.1");
    const other = await account(env, "other@example.test", "198.51.100.2");
    const legacyOnly = new Request("http://localhost:8787/api/auth/me", {
      headers: { cookie: `veriq_session=${owner.cookie}` },
    });
    assert.equal((await api.fetch(legacyOnly, env)).status, 401);
    const mixed = `veriq_session=${other.cookie}; __Host-veriq_session=${owner.cookie}`;
    const me = await api.fetch(new Request("http://localhost:8787/api/auth/me", { headers: { cookie: mixed } }), env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, owner.id);
    const logout = await api.fetch(new Request("http://localhost:8787/api/auth/logout", { method: "POST", headers: { cookie: mixed, "content-type": "application/json" }, body: "{}" }), env);
    assert.equal(logout.status, 200);
    const cleared = logout.headers.get("set-cookie") ?? "";
    assert.match(cleared, /^__Host-veriq_session=/);
    assert.match(cleared, /;\s*Secure(?:;|$)/);
    assert.match(cleared, /;\s*HttpOnly(?:;|$)/);
    assert.match(cleared, /;\s*Path=\/(?:;|$)/);
    assert.doesNotMatch(cleared, /;\s*Domain=/i);
    assert.equal((await request(env, "/api/auth/me", { cookie: owner.cookie })).status, 401);
    assert.equal((await request(env, "/api/auth/me", { cookie: other.cookie })).status, 200);
  } finally { sqlite.close(); }
});
