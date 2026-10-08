# Support assurance architecture

## Scope and isolation

Veriq checks a support draft against explicitly approved documentation selected within a workspace. Every policy, review and export lookup is scoped to a membership, including when a caller supplies an object ID from another workspace. Existing users retain private personal workspaces. Team workspaces introduce owner/admin/reviewer/viewer permissions and two-person document approval.

The UI and API use the Pages origin. `apps/web/_worker.js` forwards `/api/*` to the configured API Worker while preserving cookies. API `WEB_ORIGIN` must match the frontend origin. Untrusted origins and cross-site browser mutations are rejected. Session cookies are HttpOnly, Secure on HTTPS and SameSite=Lax; newly issued sessions expire after 12 hours. Logout-all revokes all sessions belonging to the account. Existing sessions retain their stored expiry until revoked.

## Data and transactions

`workspaces` and `workspace_members` define tenant membership. All write operations check roles in the router and again in mutation SQL to guard against permission changes. Administrators manage reviewers/viewers; only owners manage administrators. SQL triggers protect the owner's membership.

`support_documents` stores immutable text and provenance, approval status/actor and effective/expiry dates. Team authors cannot approve their own documents. SQL triggers prevent updates to text, metadata or workspace ownership. Eligibility means approved, effective today and not expired (UTC, expiry exclusive).

`support_reviews` stores an immutable draft, findings and document/quote snapshot. Human decisions are separate fields with note, actor, time and an incremented revision. Approval requires `ready_for_review` and current source eligibility. `expectedRevision` implements optimistic concurrency. A decision is a historical record: archiving or expiring a source does not erase it, but retrieval exposes `policiesCurrent:false` and the UI blocks another approval.

Each business mutation and its audit event run in one transactional D1 batch. Conditional audit insertion uses the preceding mutation's `changes()`, so failed/stale operations do not produce successful-action events. Audit metadata contains IDs, versions/hashes or decision notes, not the full policy or draft. Audit access is administrative; these records are application-level history, not cryptographically tamper-proof compliance storage.

Daily quota and authentication limits use conditional atomic D1 upserts. Review request leases fence concurrent/late workers, with a 120-second running lease and 24-hour completed replay window. A key is scoped to workspace and user and bound to a hash of draft, source IDs and engine version. Completed identical requests replay once without additional AI/quota work; changed requests conflict. Retry records are cleaned opportunistically after expiry. Attempts that time out or fail remain chargeable; an expired running lease can be reclaimed with another attempt.

## Evidence pipeline

1. Validate the complete draft and policy budget before quota consumption; preserve every sentence, including short promises and compound statements.
2. Include **all text** from every selected document in overlapping 1,200-character windows, ranked by lexical overlap without dropping lower-ranked windows. No remote source fetch occurs. Up to 60,000 source characters are selected, with overlap adding prompt tokens.
3. Ask Workers AI to classify each sentence with plan, region, number, conditional and exception matching. Documents and draft are untrusted data. Output budget is explicit (4,096 tokens); incomplete/truncated envelopes and reasoning-only output fail closed. Responses API assistant text, response text and chat choices are supported.
4. Validate passage IDs, stance values, quote length and exact contiguous substrings against both passage and immutable policy. Invalid or malformed evidence cannot yield a supported finding. Only deterministic courtesy phrases are exempt.
5. Bound calls to 20 seconds and the draft to 60 seconds. Timed-out/unprocessed statements receive explicit failure receipts; both sides of conflicts are preserved. No confidence percentage is invented.
6. Recheck membership, document eligibility and request lease inside the saving transaction. Changed permissions or archived policies produce a conflict and no review/audit insertion.

## Interface behavior

The app has a review desk and queue, source selector, searchable version library, text/Markdown import, team management and administrative audit trail. Lists paginate by time plus ID to handle timestamp ties. Query text is bound and LIKE wildcards escaped. Search sequence numbers and workspace generations keep late responses from overwriting a newer view. Editing a draft invalidates the current result and cancels pending historical rendering. Mutations temporarily disable workspace switching and draft/source edits. Policy changes clear current receipts. Dynamic text uses textContent; imported markup cannot become executable HTML. Mobile layouts retain sign-out controls.

## Demo and pilot feedback

Migration 0004 adds `pilot_feedback` without changing prior data. Every member, including viewers, may submit a private usefulness rating, category and note, optionally linked to a review in the same workspace. Only owners/admins can list or export notes. Writes recheck membership in SQL and commit their audit event atomically. Notes are append-only through the API; audit metadata excludes the note text. Limits are 10 notes per account/day and 1,000 per workspace.

The guided sample setup is explicitly confirmed, personal-workspace-only and idempotent. It creates a labeled fictional policy with an approval audit record. It cannot approve an existing version with different content, revive archived versions, or disable team approval. Sample scenarios call the actual model, with expected behavior explained rather than prerecorded results.

The release check rejects homepage HTML at `/api/health`, old API versions, active public receipt routes and mismatched frontend assets. The UI also checks the API version before enabling workspace workflows. It cannot substitute for a signed-in/live-AI smoke test or a production database migration check. [Company demo guide](COMPANY_DEMO.md) contains the operator handoff and pilot script.

## Grounded chat and private references

Migration 0005 adds `chat_turns`, `evidence_items` and `review_attachments`. Existing policies, reviews and feedback are preserved. Immutable-input triggers protect chat prompts, source selections, completed answers and attachment context; reference metadata cannot be edited in place.

Chat selects current policies within the workspace, supplies the full bounded corpus to Workers AI, and passes the generated draft through the canonical review route. That route retains the daily review quota, exact-quote validation and source/permission checks. There is no streaming of an unchecked answer. A 30-second generation timeout precedes the existing 60-second review budget. Completed turns link to the review rather than duplicating its human decision. Six ancestors provide conversation context; only currently selected policies supply evidence.

Required chat retry keys are scoped to workspace/user and bound to question, sources and parent. A 180-second lease fences duplicate/late completions. A generated answer is saved before checking, so a failed review can retry the identical draft. The canonical review key is derived from the stable turn ID: a crash between review and chat completion recovers the same review. Chat completion and audit commit transactionally. Limits: 50 generation attempts/account/UTC day, the existing 50 review attempts/account/day, and 1,000 turns/workspace (including incomplete attempts). Completed replay returns historical results even if sources subsequently expire; opening the review shows current eligibility.

Reference limits are enforced in insertion SQL: 500 items and 100 MiB/workspace, including archived items. Files are bounded at 5 MiB with 10 upload attempts/account/minute, an allowlisted MIME/signature check and sanitized attachment filename. Metadata reserves capacity before R2 IO; failed uploads remove unattachable drafts and attempt object cleanup. A process crash can leave a draft without bytes or an orphan object; operators must reconcile R2/D1, and such drafts cannot be approved while the object is unavailable. File approval/download compare stored size and hash metadata to the immutable record. No malware scanner, OCR or transcription is implemented.

R2 keys remain server-side. Downloads resolve membership, obtain the private object and recheck membership before returning non-cacheable bytes with forced attachment disposition and the API's restrictive security headers. There are no public bucket URLs. Bookmarks are never fetched by the server, and their fingerprints cover saved URL/context, not changing remote page content. Attachments require an approved reference and review in the same workspace, with writer permissions checked inside the transaction, capped at 20 per review. Archival preserves historical attachments. Neither file/reference approval nor attachment changes machine findings or enables a blocked human approval.

## Free-only deployment guard

The [free-only policy](FREE_TIER_POLICY.md) defaults AI generation to paused pending an operator's verification of the existing Workers Free account. The attestation flag is not an account billing API. Production ignores all media bindings; HTTP loopback plus an explicit local-demo flag permits simulated R2 only. No paid fallback, R2 activation or account upgrade is part of this deployment. Saved history and policy/link workflows remain available when AI is paused. Health capabilities and the UI agree on these restrictions.

## Verification and limits

Automated tests execute production SQL through SQLite and the production API handler. Browser tests use the same handler, persisted state and controlled model replies across two accounts. Coverage includes workspace isolation, roles, two-person approval, expiry, migration preservation, immutable records, audit rollback, retry races, stale permissions, optimistic decisions, exports, session revocation, quote validation, model failures, safe rendering and responsive layouts.

Exact quote validation proves provenance, not semantic correctness. Full-document prompts can still miss exceptions or follow injected instructions. Model accuracy, latency/cost and concurrency at production load require real Workers AI evaluation with a labeled pilot set. Customer-specific actions require account evidence that this app does not have.

Enterprise identity controls (SSO/MFA, email verification, invitation acceptance, password reset), service API keys, helpdesk interception, billing, retention/deletion workflows, backups/restore drills, production alerting, legal/privacy controls and independent security review remain required for broader enterprise rollout. The UI does not advertise these features as implemented.

## Migration and coordinated rollout

1. Back up the target D1 database; inspect existing schemas against migrations 0001/0002. In particular, quota upserts require a unique `(ip,day)` key on `usage`. Check earlier migration history before applying bootstrap commands to an existing database.
2. Apply `0003_workspaces.sql` after 0001/0002, then `0004_pilot_feedback.sql` and `0005_evidence_chat.sql` to a staging database with representative data. It creates personal workspaces/memberships for existing users, rebuilds the policy table with workspace/version uniqueness, and preserves historical review JSON. It changes schema; take a backup rather than assuming a destructive down migration is safe.
3. Run membership, approval, historic evidence and cross-workspace access checks against staging. Compare policy/review counts and hashes before and after migration. An upgrade regression test covers preserved users, approved policies and historical JSON locally.
4. Configure API `WEB_ORIGIN` and Pages `API_ORIGIN` for the same environment. Reconcile production-only Slack/Discord handlers with this repository before replacing the Worker; they were not part of the earlier repository snapshot.
5. Deploy API and Pages together in an authorized maintenance window, including `_worker.js` and `_routes.json`. Run real Workers AI tests with nonsensitive documents and verify the response envelope, latency and cost.
6. Validate sign-in/logout-all, team roles, two-person approval, validity dates, retries, human decisions/export, audit and retired public routes in that environment. Establish alerts, backup recovery and support ownership before a customer pilot.

Local checks compile without deploying or uploading. This change does not perform production migrations or publish the app. Rollback must preserve new data and keep retired public receipt routes closed; older pre-workspace code is not a supported rollback target.
