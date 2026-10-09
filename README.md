# Veriq

**Review AI-generated customer-support replies against approved company documentation before sending.**

Veriq gives support teams a private, shared workspace for policy versions, sentence-level evidence, a review queue and recorded human decisions. Findings include exact quotes, document versions and SHA-256 fingerprints. Missing evidence, contradictions, conflicting policies and model failures remain visible.

## Workflow

1. Create an account and use your personal workspace, or create a team workspace.
2. Add registered teammates as administrators, reviewers or viewers.
3. Paste or import a text/Markdown document with an immutable version, optional source link and validity dates.
4. Inspect and approve it. Team workspaces require a **different administrator** from the author to approve a policy; personal workspaces allow self-approval.
5. Select 1–10 current approved sources and review a customer reply.
6. Inspect every sentence, record an approval or rejection with a note, and export the evidence if needed. Send the reply through your support tool yourself.

Veriq does not access customer account records, send replies, establish universal truth or search the public web. It is a foundation for enterprise pilots, not an enterprise certification or a measured accuracy guarantee. SSO, MFA, verified invitations, password recovery, billing and helpdesk interception are not implemented.

## AI chat, links and media

**AI support chat** drafts an answer from 1–10 selected active approved policies, then runs every sentence through the existing claim review. Open the saved review for exact quotes and a human decision. Follow-ups use up to six previous turns as context; previous AI answers are never treated as evidence. Workspace members share conversation history. Retries reuse the same answer/review rather than generate duplicates.

**Links & media** saves private bookmarks or files with a context note and SHA-256 fingerprint. Inspect and approve references before attaching them to a review with an explanation of the claim they support. Team approval requires a different administrator. Archived references remain in historical attachments and cannot be used for new attachments. Attachments never change the AI verdict or bypass approval rules.

Links are not fetched. Raw media is not used for AI evidence: no OCR, transcription or automated media verification is implemented. PNG, JPEG, PDF, MP3, WAV and MP4 uploads are supported in the local R2 emulator only. Production media uploads are disabled because R2 permits billable overages. Hosted links remain usable; AI chat/review waits until an operator verifies the Cloudflare Workers Free plan. See the [free-only policy](docs/FREE_TIER_POLICY.md). See [setup and release evaluation](docs/EVIDENCE_CHAT.md).

## Company demo and feedback

Start with **Set up sample demo** in your personal workspace, choose a documented fact, wrong plan benefit or unsupported account promise, and run the actual review engine. Fictional `[Sample]` policies stay separate from company policies and cannot bypass two-person team approval.

Any workspace member can submit private usefulness/evidence feedback, optionally linked to a review. Owners/admins can inspect and export it. Feedback is subjective pilot input, not a model accuracy measure. Read [the company demo and deployment guide](docs/COMPANY_DEMO.md) before sharing the app link.

```sh
npm run verify:deployment -- https://veriq-1q9.pages.dev
```

This read-only check rejects an old API, missing Pages proxy, mismatched frontend, or exposed legacy public receipts. Run the signed-in live-AI workflow after it passes.

## Roles

| Capability                                          | Owner | Admin | Reviewer | Viewer |
| --------------------------------------------------- | ----- | ----- | -------- | ------ |
| Read policies, reviews and evidence exports         | Yes   | Yes   | Yes      | Yes    |
| Create policy drafts and review replies             | Yes   | Yes   | Yes      | No     |
| Record human review decisions                       | Yes   | Yes   | Yes      | No     |
| Approve/archive policy versions                     | Yes   | Yes   | No       | No     |
| Generate AI chat answers; save/attach references    | Yes   | Yes   | Yes      | No     |
| Approve/archive references                          | Yes   | Yes   | No       | No     |
| Submit pilot feedback                               | Yes   | Yes   | Yes      | Yes    |
| Read/export pilot feedback                          | Yes   | Yes   | No       | No     |
| Read audit trail; manage reviewer/viewer membership | Yes   | Yes   | No       | No     |
| Appoint/change administrator membership             | Yes   | No    | No       | No     |

The owner cannot be removed or reassigned through this API. Adding a member grants access immediately to an already registered account; no invitation email is sent. Use controlled pilot accounts until identity verification is implemented.

## Evidence and decisions

| Finding          | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `supported`      | The model returned valid exact policy quotes supporting the entire sentence. |
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
| `GET /api/usage`                           | Private account-wide review/chat counts, remaining attempts and next UTC reset. |
| `POST /api/chat`                           | Generate/check `{question,documentIds,parentId?}`; required `Idempotency-Key`.  |
| `GET /api/chat`                            | Paginated completed workspace chat turns.                                       |
| `GET /api/chat/:id`                        | Saved question/answer and linked claim review.                                  |
| `GET /api/evidence`                        | Search/filter private reference metadata with `q`, `kind`, `status`.            |
| `POST /api/evidence/links`                 | Save `{title,url,note}` as an immutable draft bookmark.                         |
| `POST /api/evidence/media`                 | Local emulator only: bounded multipart `{title,note,file}`.                     |
| `POST /api/evidence/:id/approve`           | Approve an inspected reference (owner/admin, two-person teams).                 |
| `POST /api/evidence/:id/archive`           | Retain historical attachments; exclude future attachment.                       |
| `POST /api/evidence/:id/attach`            | Attach an approved reference with `{reviewId,note}`.                            |
| `GET /api/evidence/:id/download`           | Local emulator only: authenticated, non-cacheable file attachment.              |
| `GET /api/workspaces`                      | List memberships and roles.                                                     |
| `POST /api/workspaces`                     | Create a team workspace with `{name}`.                                          |
| `GET /api/workspaces/:id/overview`         | Active policies, drafts, pending decisions and members.                         |
| `GET /api/workspaces/:id/members`          | List members (owner/admin).                                                     |
| `POST /api/workspaces/:id/members`         | Add `{email, role}` from registered accounts.                                   |
| `POST /api/workspaces/:id/members/:userId` | Change `{role}` or remove with `{remove:true}`.                                 |
| `GET /api/workspaces/:id/audit`            | Paginated administrative audit events.                                          |
| `POST /api/documents`                      | Save `{title,version,content,sourceUrl?,validFrom?,validUntil?}` as draft.      |
| `GET /api/documents`                       | Metadata list; filters `q`, `status`.                                           |
| `GET /api/documents/:id`                   | Read the immutable text.                                                        |
| `POST /api/documents/:id/approve`          | Approve a draft policy.                                                         |
| `POST /api/documents/:id/archive`          | Exclude a version from future reviews.                                          |
| `POST /api/reviews`                        | Review `{draft,documentIds}`.                                                   |
| `GET /api/reviews`                         | Review queue; filters `q`, `decision`.                                          |
| `GET /api/reviews/:id`                     | Read evidence, decision, revision and current policy eligibility.               |
| `POST /api/reviews/:id/decision`           | Record `{decision:'approved'                                                    | 'rejected',note,expectedRevision}`. |
| `GET /api/reviews/:id/export`              | Private evidence JSON download.                                                 |

Use a unique `Idempotency-Key` (16–128 letters, digits, `_` or `-`) when creating a review. A completed identical request replays without another model call/quota charge; changed payloads conflict. A running duplicate returns `409 REVIEW_IN_PROGRESS`. Retry after a short wait using the same key. Records are retained for 24 hours after completion; retries after that window can create another review. The UI preserves the key after a transport failure until the draft or selected sources change.

Auth routes are `/api/auth/signup`, `/login`, `/logout`, `/me` and `/revoke-sessions`. New passwords require 12–128 characters; sessions last 12 hours. Errors have an `error`, machine `code` and `requestId`. Private responses are not cacheable. Legacy public `/api/r/*` and `/api/verify*` routes return `410`.

Limits: 3,000 draft characters, 12 sentences, 10 selected documents, 20,000 characters per document, 60,000 characters per selected policy set, 500 document versions per workspace, 10 owned team workspaces and 50 review attempts per account per UTC day. Model failures consume an attempt and leave explicit failure receipts. Authentication is limited atomically in D1 to 10 attempts per minute per connecting IP. Source URLs are links only, never remotely fetched.

Pilot APIs: `GET /api/demo` lists the fictional policy and three scenarios; `POST /api/demo/setup` requires `{confirmSamplePolicies:true}` in a personal workspace. `POST /api/feedback` accepts `{rating:1..5,kind:'usability'|'evidence'|'policy_gap'|'other',note,reviewId?}`. Administrative `GET /api/feedback` paginates and summarizes usefulness ratings; `GET /api/feedback/export` downloads all notes (maximum 1,000). Submission is limited to 10 notes per account per UTC day. Feedback writes and audit events commit together.

## Architecture and rollout

Cloudflare Pages serves the UI and first-party API proxy. Workers handles the API; Workers AI (`gpt-oss-20b`) evaluates full selected document text; D1 stores workspaces, roles, sessions, policies, reviews, leases and atomic audit events. KV is no longer required by auth. [Architecture and rollout](docs/ARCHITECTURE.md) describes migrations, deployment and limitations.

This code does not migrate the production database or publish a deployment. Apply migrations `0003_workspaces.sql`, `0004_pilot_feedback.sql` and `0005_evidence_chat.sql` after the two earlier migrations and deploy the API/UI together. Existing accounts, documents and historical reviews move into their own personal workspaces.

MIT — see LICENSE.
