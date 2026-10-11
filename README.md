# Veriq

**Review AI-generated customer-support replies against approved company documentation before sending.**

Veriq gives support teams a private, shared workspace for policy versions, sentence-level evidence, a review queue and recorded human decisions. Findings include exact quotes, document versions and SHA-256 fingerprints. Missing evidence, contradictions, conflicting policies and model failures remain visible.

## Workflow

1. Create an account and use your personal workspace, or create a team workspace.
2. Add registered teammates as administrators, reviewers or viewers.
3. Paste or import a text/Markdown document with an immutable version, optional source link and validity dates.
4. Inspect and approve it. Team workspaces require a **different administrator** from the author to approve a policy; personal workspaces allow self-approval.
5. Review a customer reply against every current approved policy in the workspace.
6. Inspect every sentence, record an approval or rejection with a note, and export the evidence if needed. Send the reply through your support tool yourself.

Veriq does not access customer account records, send replies, establish universal truth or search the public web. It is a bounded, supervised pilot workflow—not an enterprise certification or measured accuracy guarantee. TOTP MFA, offline recovery codes and verified invitation acceptance are implemented when the operator provisions the encrypted MFA secret; SSO, SCIM, billing and helpdesk interception are not implemented.

## AI chat, links and media

**AI support chat** drafts an answer from every active approved policy, then runs every sentence through the existing claim review. Open the saved review for exact quotes and a human decision. Follow-ups use up to six previous turns as context; previous AI answers are never treated as evidence. Workspace members share conversation history. Retries reuse the same answer/review rather than generate duplicates.

**Links & media** saves private bookmarks or files with a context note and SHA-256 fingerprint. Inspect and approve references before attaching them to a review with an explanation of the claim they support. Team approval requires a different administrator. Archived references remain in historical attachments and cannot be used for new attachments. Attachments never change the AI verdict or bypass approval rules.

Links are not fetched. Raw media is not used for AI evidence: no OCR, transcription or automated media verification is implemented. PNG, JPEG, PDF, MP3, WAV and MP4 uploads are supported in the local R2 emulator only. Production media uploads are disabled because R2 permits billable overages. Hosted links remain usable; AI chat/review waits until an operator verifies the Cloudflare Workers Free plan. See the [free-only policy](docs/FREE_TIER_POLICY.md). See [setup and release evaluation](docs/EVIDENCE_CHAT.md).

## Company demo and feedback

Start with **Set up sample demo** in your personal workspace, choose a documented fact, wrong plan benefit or unsupported account promise, and run the actual review engine. Fictional `[Sample]` policies stay separate from company policies and cannot bypass two-person team approval.

Any workspace member can submit private usefulness/evidence feedback, optionally linked to a review. Owners/admins can inspect and export it. Feedback is subjective pilot input, not a model accuracy measure. Read the [company demo and deployment guide](docs/COMPANY_DEMO.md) before sharing the app link.

```sh
npm run verify:deployment -- https://veriq-1q9.pages.dev
```

This read-only check rejects an old API, missing Pages proxy, mismatched frontend, or exposed legacy public receipts. Run the signed-in live-AI workflow after it passes. Production release is owner-triggered only; see [the release workflow](.github/workflows/release.yml) and [the deployment guide](docs/COMPANY_DEMO.md). It lists migrations but never applies production migrations automatically.

## Security reporting

Use the repository’s [private vulnerability reporting channel](https://github.com/suhasaitham22/veriq/security/advisories/new) for suspected vulnerabilities. Use [GitHub Issues](https://github.com/suhasaitham22/veriq/issues) only for non-sensitive bugs; never post customer data, credentials, invitation tokens or recovery/TOTP secrets. See [SECURITY.md](SECURITY.md).

## Roles

| Capability                                          | Owner | Admin | Reviewer | Viewer |
| --------------------------------------------------- | ----- | ----- | -------- | ------ |
| Read policies, reviews and evidence exports         | Yes   | Yes   | Yes      | Yes     |
| Create policy drafts and review replies             | Yes   | Yes   | Yes      | No      |
| Record human review decisions                       | Yes   | Yes   | Yes      | No      |
| Approve/archive policy versions                     | Yes   | Yes   | No       | No      |
| Generate AI chat answers; save/attach references    | Yes   | Yes   | Yes      | No      |
| Approve/archive references                          | Yes   | Yes   | No       | No      |
| Submit pilot feedback                               | Yes   | Yes   | Yes      | Yes     |
| Read/export pilot feedback                          | Yes   | Yes   | No       | No      |
| Read audit trail; manage reviewer/viewer membership | Yes   | Yes   | No       | No      |
| Appoint/change administrator membership             | Yes   | No    | No       | No      |

All non-personal team content, including viewer reads and owner bulk exports,
requires a TOTP-verified session. Password-only legacy sessions retain data but
are paused until the account completes MFA setup/login. The owner cannot be
removed or reassigned. Team admission uses an account-bound bearer invitation:
the owner enters the recipient's account ID and label, delivers the one-time
token through an owner-verified channel, and the intended signed-in account
accepts it. A label is not mailbox or identity verification; self-invites are
rejected. Non-owner memberships may need re-admission after the MFA cutover.

## Evidence and decisions

| Finding          | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `supported`      | The model assessed the statement with an exact quote whose provenance was validated against an active policy; this is not independent semantic or account-action proof. |
| `contradicted`   | The model returned valid quotes contradicting the sentence.                  |
| `conflicting`    | Both supporting and contradicting evidence was returned.                     |
| `unsupported`    | Evidence was missing, invalid, or evaluation failed.                         |
| `not_applicable` | A narrowly allowlisted greeting or courtesy.                                 |

Draft status is `requires_changes` for contradictions/conflicts, `needs_review` for missing evidence or failed evaluation, and `ready_for_review` only when every factual statement has supporting evidence. Every status requires human judgment; no confidence percentage is invented.

The human decision is separate from the machine finding. Approval is blocked unless the finding is ready and all source policies remain active. Concurrent decisions use an expected revision to prevent silent overwrites. Historical decisions remain visible after sources expire or are archived, with a warning that a new review is needed.

Policy text and metadata cannot be edited in place. Save a new version and archive superseded versions. Version labels do not imply automatic precedence. Expiry dates are exclusive: a policy expiring on October 8 is ineligible from midnight UTC on October 8.

## Run locally

Requires Node.js 24+, npm, and Cloudflare access for live Workers AI requests.

```sh
npm ci
npm run db:migrate:local
npm run dev:api
# In another terminal:
npm run dev:web
```

Open `http://localhost:8788`. Pages forwards `/api/*` to the local API, preserving first-party cookies. API `WEB_ORIGIN` must match the web origin; Pages `API_ORIGIN` is a server-side setting.

```sh
npm run check          # TypeScript + pipeline/API/SQLite/proxy regressions
npm run build:api      # Local esbuild compilation, no deployment/upload
npx playwright install chromium
npm run test:browser   # Browser → production API handler → SQLite → UI
npm run format:check
```

GitHub Actions runs these on pull requests and feature branches. AI fixtures are controlled: these tests verify behavior and integration, not production model accuracy. See [evaluation](docs/EVALUATION.md) for the required real-policy pilot.

## Request recovery and daily allowance

Browser requests have deadlines: 30 seconds for ordinary API/file operations and 120 seconds for review/chat generation and checking, including response-body reads. A timeout does not prove the server cancelled its work. The app does not retry automatically. Retry an unchanged review/chat message in the same open page to reuse its existing key and recover a committed result. For other mutations, inspect saved records before submitting again. Pending retry keys are not retained after reload or closing the page.

The workspace shows remaining review/chat attempts across your account, with a reset time and refresh control. These are app quotas, not Cloudflare neuron usage or a guarantee that the provider allowance remains available. Daily-limit responses report the actual next midnight UTC in `Retry-After`. Provider exhaustion can stop AI earlier; the app does not enable paid fallbacks.

## API

Private routes require the `veriq_session` cookie. Set `X-Workspace-ID` to a workspace you belong to; omitting it uses your personal workspace. Read lists accept `limit` (1–100, default 25), `cursor`, and supported filters. Follow `nextCursor` until it is null.

| Route                                      | Purpose                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/usage`                           | Private account/workspace allowance plus shared AI calls, input bytes, output tokens, reset time and provider-measurement caveat. |
| `POST /api/chat`                            | Generate/check `{question,parentId?}` against the full active policy set; required `Idempotency-Key`. |
| `GET /api/chat`                             | Paginated completed workspace chat turns. |
| `GET /api/chat/:id`                         | Saved question/answer and linked claim review. |
| `GET /api/evidence`                         | Search/filter private reference metadata with `q`, `kind`, `status`. |
| `POST /api/evidence/links`                  | Save `{title,url,note}` as an immutable draft bookmark. |
| `POST /api/evidence/media`                  | Local emulator only: bounded multipart `{title,note,file}`. |
| `POST /api/evidence/:id/approve`            | Approve an inspected reference (owner/admin, two-person teams). |
| `POST /api/evidence/:id/archive`            | Retain historical attachments; exclude future attachment. |
| `POST /api/evidence/:id/attach`             | Attach an approved reference with `{reviewId,note}`. |
| `GET /api/evidence/:id/download`            | Local emulator only: authenticated, non-cacheable file attachment. |
| `GET /api/workspaces`                       | List membership metadata; team content requires a TOTP-verified session. |
| `POST /api/workspaces`                      | Create a team workspace with `{name}` (MFA required). |
| `GET /api/workspaces/:id/overview`          | Active policies, drafts, pending decisions and members (verified session). |
| `GET /api/workspaces/:id/members`           | List member metadata (verified session). |
| `POST /api/workspaces/:id/invitations`      | Owner/admin creates `{recipientAccountId,recipientLabel,role}`; token is delivered once out of band. |
| `GET /api/workspaces/:id/invitations`       | List invitation metadata without bearer tokens. |
| `POST /api/workspaces/:id/invitations/:id/revoke` | Revoke an invitation (MFA required). |
| `POST /api/invitations/accept`              | Intended signed-in account accepts `{token}` (MFA required). |
| `POST /api/workspaces/:id/members/:userId`  | Change `{role}` or remove with `{remove:true}` (MFA required). |
| `GET /api/workspaces/:id/audit`             | Paginated administrative audit events (verified session). |
| `POST /api/documents`                       | Save `{title,version,content,sourceUrl?,validFrom?,validUntil?}` as draft. |
| `GET /api/documents`                        | Active/draft metadata list; filters `q`, `status`. |
| `GET /api/documents/:id`                    | Read immutable text (verified session for teams). |
| `POST /api/documents/:id/approve`           | Approve a draft policy (MFA and two-person rules). |
| `POST /api/documents/:id/archive`           | Exclude a version from the active policy set. |
| `POST /api/reviews`                         | Review `{draft}` against the full active policy set; exact `documentIds` is an internal consistency guard only. |
| `GET /api/reviews` / `GET /api/reviews/:id` | Review queue or evidence, decision, revision and current-policy status. |
| `POST /api/reviews/:id/decision`            | Record decision plus approval `attestation:{policyApplicabilityConfirmed,accountFactsChecked,evidenceInspected}`. |
| `GET /api/reviews/:id/export`               | Per-review evidence JSON download; not an owner bulk workspace export. |
| `GET /api/workspaces/:id/lifecycle`         | Owner-only retention and lifecycle status. |
| `POST /api/workspaces/:id/export`           | Owner-only bounded-page export with `{password,section?,cursor?}`. |
| `POST /api/workspaces/:id/retention`        | Owner sets `{password,workspaceName,retentionDays:7..365}`. |
| `POST /api/workspaces/:id/purge`            | Owner applies retention immediately with `{password,workspaceName}`. |
| `POST /api/workspaces/:id/delete`           | Owner destruction with `{password,workspaceName,confirm:'DELETE'}`. |
| `POST /api/account/delete`                  | Account pseudonymization with `{password,confirm:'DELETE'}` after owned teams are deleted; shared-team contributions retain stable actor IDs. |

Use a unique `Idempotency-Key` (16–128 letters, digits, `_` or `-`) when creating a review. A completed identical request replays without another model call/quota charge; changed payloads conflict. A running duplicate returns `409 REVIEW_IN_PROGRESS`. Retry after a short wait using the same key. Records are retained for 24 hours after completion; retries after that window can create another review. The UI preserves the key after a transport failure until the draft changes.

Auth routes are `/api/auth/signup`, `/login`, `/logout`, `/me`, `/recover`, `/security`, `/mfa/enroll`, `/mfa/confirm`, `/mfa/disable` and `/revoke-sessions`. New passwords require 12–128 characters; sessions last 12 hours. TOTP MFA requires an operator-provisioned base64 encoding of a 32-byte `MFA_ENCRYPTION_KEY` Worker secret, with secure backup and deliberate rotation; missing or changed key material fails closed. Recovery-code use clears MFA and revokes sessions. All non-personal team reads/exports require a TOTP-verified session. Errors have an `error`, machine `code` and `requestId`. Private responses are not cacheable. Legacy public `/api/r/*` and `/api/verify*` routes return `410`.
Limits: 3,000 draft characters, 12 sentences, the full active policy set, 20,000 characters per document, 60,000 characters per active policy set, 500 document versions per workspace, and 50 review attempts per account per UTC day. Shared AI capacity is reported separately and may stop earlier; per-account allowances do not guarantee provider capacity. Model failures consume an attempt and leave explicit failure receipts. Authentication is limited atomically in D1 to 10 attempts per minute per connecting IP. Source URLs are links only, never remotely fetched.

Pilot APIs: `GET /api/demo` lists the fictional policy and three scenarios; `POST /api/demo/setup` requires `{confirmSamplePolicies:true}` in a personal workspace. `POST /api/feedback` accepts `{rating:1..5,kind:'usability'|'evidence'|'policy_gap'|'other',note,reviewId?}`. Administrative `GET /api/feedback` paginates and summarizes usefulness ratings; `GET /api/feedback/export` downloads all notes (maximum 1,000). Submission is limited to 10 notes per account per UTC day. Feedback writes and audit events commit together.

## Architecture and rollout

Cloudflare Pages serves the UI and first-party API proxy. Workers handles the API; Workers AI (`gpt-oss-20b`) evaluates the full active policy set; D1 stores workspaces, roles, sessions, policies, reviews, leases and atomic audit events. KV is no longer required by auth. [Architecture and rollout](docs/ARCHITECTURE.md) describes migrations, deployment and limitations.

This code does not migrate the production database or publish a deployment. The owner must back up the target D1, inspect migration history, exercise migrations `0003_workspaces.sql`, `0004_pilot_feedback.sql`, `0005_evidence_chat.sql` and `0006_customer_hardening.sql` in isolated staging, and review the cutover consequences: existing non-owner team memberships may be suspended until account-bound re-invitation and password-only legacy sessions cannot read team content until TOTP login. Existing production-only Slack/Discord handlers are not in this repository; before replacing the Worker, the operator must reconcile them explicitly and record the result in staging/release evidence. No claim is made that unknown production handlers or backups have been migrated or restore-tested. Because v9 changes session/admission semantics, do not roll back to pre-v9 code after applying 0006; repair forward or restore only to a compatible hardened release after operator review. Existing accounts and documents move into personal workspaces only according to the reviewed migration plan.

MIT — see LICENSE.
