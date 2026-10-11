# Support assurance architecture

## Scope and isolation

Veriq reviews a support draft against **every active approved policy in one workspace**. Use a workspace for a bounded policy domain, not an entire company's unrelated products. The application cannot prove that an administrator imported every applicable company policy, determine the customer's eligibility, inspect an account, or verify that an action happened. Exact quotes establish provenance; semantic support is model-assessed.

Every policy, review, chat, reference and export lookup is membership-scoped, including caller-supplied IDs. All nonpersonal workspace content, including viewer reads and owner exports, additionally requires an enrolled, decryptable second factor and a **TOTP-verified current session**. Password-only sessions may access personal/account setup and their workspace metadata, not team content.

The UI and API use the Pages origin. `apps/web/_worker.js` forwards `/api/*` to the configured API Worker while preserving cookies. API `WEB_ORIGIN` must match the frontend origin. Untrusted origins and cross-site browser mutations are rejected. The session cookie is **`__Host-veriq_session`**, with `HttpOnly; Secure; SameSite=Lax; Path=/` and no `Domain`. The browser-enforced prefix prevents a sibling preview setting a parent-domain or narrower-path session cookie. One shared parser/hash function serves authentication and transaction-time session fences; the old unprefixed name is not accepted, so existing clients must sign in again. Cookies expire after 12 hours and only their SHA-256 digests are stored. At most ten live sessions are retained per account; failed authentication cannot evict an existing live session.

## Admission, MFA and recovery

An email is an **unverified account label**, never an admission credential. Immediate email-based member grants are retired. An owner/admin instead chooses the recipient's exact account ID, confirms that account through an independently verified channel, and issues a role/workspace/account-bound invitation. The 256-bit bearer token is displayed once, stored only hashed, expires in 48 hours and must be delivered manually through that channel. It is never a URL parameter. A different account cannot consume it, an inviter cannot invite themselves, and the role is taken from the stored invitation rather than the acceptance body.

Only owners appoint administrators; administrators can admit reviewers/viewers. Fifty admitted members plus live invitations is the workspace ceiling. Acceptance is single-use in an atomic D1 transaction. Revocation, expiry, loss of the issuer's authority, or an ineligible recipient prevents acceptance. Successful membership removal or role change atomically revokes live invitations addressed to or authored by that account, so later re-admission cannot revive an old grant. Suspended legacy memberships need a fresh invitation. Distinct accounts and factors do **not** establish distinct humans.

TOTP uses standard RFC 6238 HMAC-SHA1, six digits, 30-second steps and at most one step of clock skew in either direction. The highest accepted step is advanced atomically; replay/concurrent reuse is rejected. Each random 160-bit seed is encrypted with AES-256-GCM under the operator-provisioned `MFA_ENCRYPTION_KEY`, a 32-byte Base64 Worker secret. Standard additional authenticated data binds the ciphertext to the account ID and `enrollment`/`active` purpose. No paid auth, email or QR service is used.

Enrollment requires password reauthentication and a code confirming the once-displayed seed; pending enrollment expires after ten minutes. Code-proven confirmation and login explicitly mark `sessions.mfa_verified=1`. Enrollment, recovery, factor removal and credential rotation revoke existing sessions. Password/TOTP verification and credential updates carry the exact verified password/salt/factor snapshot and current-session fences, preventing in-flight password-only requests from crossing a concurrent enrollment or recovery.

Signup and authenticated security rotation display one 256-bit offline recovery code; only its digest is retained. Recovery atomically consumes it, rotates the password and recovery code, clears MFA, and revokes every session. It does not sign the user in. Personal setup remains available after password login, but team access requires new MFA enrollment. There is no mailbox-based reset or operator bypass; a legacy account must mint and save a recovery code while it can still authenticate.

The encryption key is a real deployment prerequisite. Missing, invalid or changed keys never downgrade enrolled accounts: new login and team access fail closed. Health exposes configuration availability, not the secret or proof that every existing seed decrypts. Preserve a protected operator backup of the key. Do not replace it without a reviewed re-encryption procedure; losing it and the user's recovery code can make the account unrecoverable. SSO, SCIM and mailbox verification are not implemented.

## Data and transactions

`workspaces` and admitted `workspace_members` define tenant membership. Write SQL rechecks admission, roles, account enablement and team-factor enrollment. The owner membership is protected except within an owner-authorized workspace teardown. A team policy's author cannot approve that version; reviewers/viewers cannot approve policies or manage admission.

`support_documents` stores immutable text, provenance and effective/expiry dates. Eligibility means approved, effective today and not expired (UTC; expiry is exclusive). Version labels do not establish precedence: archive superseded versions rather than relying on a newer-looking label.

`support_reviews` stores immutable inputs, findings and the full policy-set snapshot. Human decisions have a note, actor, time and optimistic revision. Approval requires `ready_for_review`, exact equality with the current active set, and explicit human confirmation of policy applicability, account facts and evidence inspection. `review_attestations` stores that responsibility separately; it is not an independent semantic proof. Both decision and attestation commit with the audit event. All writers may decide, including the draft's author; there is no two-person approval requirement for each reply.

Adding, archiving or expiring an active policy makes an older receipt `policiesCurrent:false`; historical decisions are not rewritten. Receipts without the v9 full-workspace scope marker remain readable but cannot receive a new approval. Attestations and source/review content cannot be edited in place, but authorized lifecycle deletion can remove them.

Workspace mutations that retain history commit with their audit event in one D1 batch. Failed/stale mutations produce no successful-action event. Audit metadata can contain decision notes, IDs and versions/hashes; it is application history, not cryptographically tamper-proof compliance storage. Credential workflows revoke sessions transactionally but do not create a workspace audit record.

Review leases run for 120 seconds; completed retry records last 24 hours. Retry identity is workspace/user/draft/engine, not a mutable source selection. A completed identical key replays its historical receipt without more inference even after policy changes, with current-scope validity reported separately. Changed payloads conflict. Failed/time-out attempts retain their capacity reservations.

## Evidence pipeline

1. Preserve every draft sentence, including compound statements and short promises. Limits are 3,000 UTF-16 code units and twelve sentences; a policy version is at most 20,000 code units.
2. Take one bounded active-policy snapshot. More than ten versions or 60,000 combined UTF-16 code units fails closed with archive/split-domain guidance. Every document is sent whole, once; there are no retrieval windows or per-sentence corpus repetition, and no source text is silently dropped.
3. Send one batched request to `@cf/openai/gpt-oss-20b`, with explicit statement indices and document references. Documents and draft are untrusted data. The output budget is 4,096 tokens; at most four evidence items per statement and 36 total are accepted.
4. Require exactly one result for every requested index. Missing, duplicate, extra or malformed indices/envelopes fail the batch closed. Validate each quote as a contiguous substring of its immutable document, at least sixteen characters, with a valid source and stance. A bad citation fails its sentence closed. Only the deterministic courtesy list is exempt; a model cannot exempt a factual promise.
5. The single model call has a 45-second deadline inside a 60-second review budget. Timeouts and invalid output produce explicit failure receipts; application capacity refusals retain their HTTP error code. A local deadline does not cancel provider-side work.
6. Recheck exact active-set equality, admission and the request lease in the save transaction. Approval repeats the set-equality check. `ready_for_review` is a model finding for human inspection, not verified truth, eligibility or completed action.

Public clients omit `documentIds`. The optional field is an **exact-set optimistic guard**, not a selector: chat supplies its generation snapshot so policy changes cannot silently swap the corpus between generation and review. A subset is rejected, never evaluated as if complete.

## Interface behavior

The app has a review desk/queue, a searchable version library, text/Markdown import, account security, account-bound invitations, owner lifecycle controls and an administrative audit trail. Review/chat display the active bounded policy domain rather than policy-selection checkboxes. Decisions distinguish model findings from the reviewer's explicit responsibility.

Lists paginate by time plus ID; query text is bound and LIKE wildcards escaped. Sequence/workspace-generation checks prevent stale responses replacing a newer view. Editing a draft invalidates its current result. Dynamic text uses `textContent`, and imported markup cannot become executable HTML. Secret handoffs are transient and must be saved outside the application; tokens and recovery codes are not stored in browser persistence or put in URLs.

## Demo and pilot feedback

Migration 0004 adds `pilot_feedback` without changing prior data. Every member, including viewers, may submit a private usefulness rating, category and note, optionally linked to a review in the same workspace. Only owners/admins can list or export notes. Writes recheck membership in SQL and commit their audit event atomically. Notes are append-only through the API; audit metadata excludes the note text. Limits are 10 notes per account/day and 1,000 per workspace.

The guided sample setup is explicitly confirmed, personal-workspace-only and idempotent. It creates a labeled fictional policy with an approval audit record. It cannot approve an existing version with different content, revive archived versions, or disable team approval. Sample scenarios call the actual model, with expected behavior explained rather than prerecorded results.

The release check rejects homepage HTML at `/api/health`, old API versions, active public receipt routes and mismatched frontend assets. The UI also checks the API version before enabling workspace workflows. It cannot substitute for a signed-in/live-AI smoke test or a production database migration check. [Company demo guide](COMPANY_DEMO.md) contains the operator handoff and pilot script.

## Grounded chat and private references

Migration 0005 adds `chat_turns`, `evidence_items` and `review_attachments`. Immutable-input triggers protect chat prompts, the recorded policy snapshot, completed answers and attachment context; reference metadata cannot be edited in place.

Chat supplies the entire current bounded policy set, then passes its generated draft through the canonical review route. Generation and review use the **same model**, not independent checkers. There is no streaming of an unchecked answer. A 30-second generation timeout precedes the single batched review. Six ancestors provide conversation context; prior answers, bookmarks and attachments are not policy evidence.

Chat keys bind workspace/user/question/parent. A 180-second lease fences duplicate/late completion. A generated answer is saved before review so retry can reuse it; however, a failed turn whose immutable policy snapshot changed requires a new request key. Completed replay returns history even if policies subsequently change. Canonical review/turn completion and audits are transactional. Per-account generation and review limits remain 50 attempts each per UTC day, but the shared application/provider ceilings below can stop them earlier.

Reference limits are enforced in insertion SQL: 500 items and 100 MiB/workspace, including archived items. Files are bounded at 5 MiB with 10 upload attempts/account/minute, an allowlisted MIME/signature check and sanitized attachment filename. Metadata reserves capacity before R2 IO; failed uploads remove unattachable drafts and attempt object cleanup. A process crash can leave a draft without bytes or an orphan object; operators must reconcile R2/D1, and such drafts cannot be approved while the object is unavailable. File approval/download compare stored size and hash metadata to the immutable record. No malware scanner, OCR or transcription is implemented.

R2 keys remain server-side. Downloads resolve membership, obtain the private object and recheck membership before returning non-cacheable bytes with forced attachment disposition and the API's restrictive security headers. There are no public bucket URLs. Bookmarks are never fetched by the server, and their fingerprints cover saved URL/context, not changing remote page content. Attachments require an approved reference and review in the same workspace, with writer permissions checked inside the transaction, capped at 20 per review. Archival preserves historical attachments. Neither file/reference approval nor attachment changes machine findings or enables a blocked human approval.

## Free-only deployment and capacity

The [free-only policy](FREE_TIER_POLICY.md) keeps AI paused until an operator verifies the existing Workers Free account and its available capacity. This flag is an operator attestation, not a billing API or account-wide usage meter. Production has no R2 binding and ignores media access; only explicit HTTP-loopback local simulation is supported. No paid fallback, resource upgrade or billing activation is performed.

An atomic D1 reservation spans **all users and workspaces**: at most 50 model calls, 1,000,000 UTF-8 serialized input bytes and 100,000 requested maximum output tokens per UTC day. One call is also limited to 120,000 UTF-8 input bytes and 4,096 requested output tokens. Failed and timed-out calls remain reserved. These are application ceilings, not token estimates or guarantees about provider neurons; the provider's shared free allocation can stop service earlier.

Global stored-row ceilings are 1,000 each for workspaces, policy versions, reviews, references, chat turns and feedback; 5,000 each for audit events and attachments; 2,000 invitations and 5,000 rate-limit keys. Reviews additionally cap at 500/workspace and 131,072 serialized bytes each. Existing over-cap data is preserved/readable/exportable/deletable rather than truncated by migration. Capacity exhaustion can stop writes; export and authorized deletion remain available.

Signup is capped at 100 attempts/day and 1,000 retained account rows, including pseudonymized actors. Authentication is bounded globally before IP/account-specific keys; new passwords require twelve characters. General authenticated mutations have a 120/minute per-account ceiling. These limits trade availability for bounded resource use and do not establish an enterprise SLA or unlimited scaling.

## Bounded requests and quota visibility

All browser API calls share `request.js`, including auth, media and private downloads. Ordinary requests have a 30-second deadline; review/chat use 120 seconds to cover generation plus checking. The abort signal remains active through body consumption. Errors preserve status/code, retry timing and safe request references. No automatic retry is performed: a lost mutation response can represent committed work. Existing review/chat retry keys are retained in the open page after failure and unchanged input reuses them. Other mutations require inspection of saved records before resubmission; reload does not preserve pending keys.

`GET /api/usage` returns the signed-in account's attempts plus `sharedAi` limits, used/remaining calls, UTF-8 bytes, reserved output tokens and UTC reset. Personal allowance is **not** a promise that shared capacity is available. Counts are not remaining Cloudflare neurons; `providerUsageMeasured:false` makes that boundary explicit. Capacity 429 responses preserve the relevant reset and error code; the UI does not automatically retry possibly committed mutations.

## Export, retention and deletion

Owner lifecycle routes require fresh password confirmation. Retention changes, purge and workspace deletion additionally require the exact typed `workspaceName`; deletion also requires `confirm:"DELETE"`. Authorization is checked again inside the destructive transaction against the exact current session, admitted owner and team-factor assurance, not only the earlier password check.

`POST /api/workspaces/:id/export` pages current workspace documents, reviews, attestations, references, attachments, chat, feedback, audit, members and invitation metadata. Each request supplies the password plus optional section/cursor, and the consumer follows `nextCursor`/`nextSection` until complete. Authentication digests, encrypted seeds, bearer tokens, storage keys and internal leases are excluded. It is a logical export, explicitly **not an atomic database snapshot or a tested restore backup**. Export is a read-only POST exempt from the mutation limiter; its separate 3,000/hour reauth ceiling and tight wrong-password limits allow supported multi-page exports without weakening credential checks.

New workspaces default to 90-day history retention, configurable from seven to 365 days. **Existing workspaces opt in explicitly**; migration does not silently schedule their history for deletion. The daily 03:00 UTC handler and owner purge remove expired reviews, related attestations/attachments/feedback and expired conversations. A conversation remains until its newest turn expires. Policy/reference libraries remain until workspace deletion. Purge redacts decision-note audit metadata for erased reviews, retaining action/actor/object/time governance events for at most 365 days. Purge and its audit commit together or roll back together.

Workspace deletion removes its content, memberships, invitations and audit history; a deleted personal workspace may be recreated empty on subsequent use. Account deletion requires deleting owned teams first, removes the personal workspace and retired account records, memberships, invitations to/from the account, sessions and recovery/MFA secrets, and replaces the account label while retaining its stable actor ID. This is **pseudonymization, not irreversible anonymization**: content authored in **another owner's workspace remains under that owner's retention**, and earlier exports/backups may link the ID to its old label. App deletion does not immediately erase operator exports, logs or provider backup/Time Travel copies; operators must document those responsibilities and retention periods. It is not a claim of GDPR compliance or complete personal-data erasure.

## Verification and limits

The hardening regression run passed TypeScript and 160 tests through the production handler and real SQLite SQL. Coverage includes cryptographic invitation possession, second-factor/session assurance, credential-transition races, suspended membership, policy-set races, model-envelope failures, attestation concurrency, lifecycle rollback/cascades, quota reservation and a complete export exceeding 120 pages.

An additional real `workerd`/local-D1 smoke applied all six migrations and passed 52 HTTP checks across signup, MFA/login/recovery, invitation revocation/concurrency, team policy approval, paginated export, retention/purge and deletion. Local foreign-key checks were clean. This runtime intentionally had **no AI or R2 binding**; the AI-paused path reserved zero calls. Browser/model-response fixtures exercise application contracts, not live-model accuracy or production performance.

A separate Chromium154 test reproduced parent-domain cookie tossing from a sibling Pages-style preview and proved rejection of the equivalent `__Host-` cookie. The same browser accepted and returned the unchanged Secure host-prefixed cookie on HTTP localhost. After the cookie cutover, the full52-check real workerd/local-D1 smoke passed again. Production requires HTTPS and a browser that enforces cookie prefixes; no insecure-cookie fallback or old-name alias is provided. See the [Set-Cookie prefix rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes).

Exact provenance does not prove semantic correctness. Full-policy prompts can still misinterpret conditions or injected instructions, and workspace coverage does not establish real-case applicability. [Evaluation guidance](EVALUATION.md) includes an offline scorer for actual exported receipts; customer labels and an authorised free-capacity real-model capture are still prerequisites for measured accuracy.

SSO/SCIM, verified email, helpdesk sending/interception, service API keys, billing, production monitoring/incident ownership, legal processing terms, independent security review and a production backup/restore drill remain external or unimplemented prerequisites. This release does not claim certification, an SLA, automatic customer-action verification or unsupervised sending.

## Migration and coordinated rollout

1. Back up and inspect the target D1 schema/migration history. Apply migrations only in an explicitly authorised staging/production maintenance procedure; neither this change nor its checks deploys or changes production data.
2. Apply `0001`–`0006` in order as appropriate to that history. Stage `0006_customer_hardening.sql` against representative existing data and compare user/policy/review counts and hashes. It preserves content, **suspends all legacy non-owner grants**, marks legacy sessions as not MFA-verified, preserves owner membership, and leaves legacy retention disabled until owner opt-in.
3. Tell owners and teammates about that material cutover before rollout. Owners need MFA setup or a code-proved login for team content. Teammates need MFA and a fresh account-bound invitation. Personal/account setup and workspace metadata remain the bootstrap path. Ensure users have saved recovery codes; old accounts have no recoverable code until they mint one while authenticated.
4. Provision and protect `MFA_ENCRYPTION_KEY` through the authorised operator's Worker secret tooling, not source, arguments or logs. Match canonical Pages/API origins. Verify the **Free** plan and remaining shared capacity before enabling AI; keep R2 absent and do not upgrade billing. A secret-name preflight alone cannot prove its value or decryptability; perform the staged MFA workflow.
5. Release matching API v9 and Pages assets only after release preflight and signed-in staging smoke. Verify MFA-required reads, invitation expiry/revocation, recovery, full-policy invalidation, approval/attestation, export and the documented deletion boundaries, plus the retired public endpoints. A real-model smoke needs explicit free-capacity permission and non-sensitive inputs; no such live accuracy evidence is supplied here.
6. Establish incident/support ownership, permitted data processing, monitoring, provider-backup retention and a restore rehearsal before accepting confidential customer material.

**Do not roll back to pre-v9 code after migration0006.** The schema changes look additive, but older code ignores `admitted_at` and session MFA assurance and can restore suspended or password-only team access. Preserve backups, repair forward, or roll back only to a compatible hardened release. No automatic unsafe rollback is supported.

