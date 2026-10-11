# Company demo and feedback pilot

## Deployment comes first

The existing app address is `https://veriq-1q9.pages.dev`. The October 9, 2026
read-only audit found that address serving the old “Verify anything” site:
`/api/health` returned homepage HTML and the API Worker reported `v:2`. It is not
the updated support-assurance demo until the owner-triggered release below passes.

Before sharing the link, an operator with access to the existing Cloudflare account
must verify the account plan, backup/staging state, migration status and project
bindings described below. Do not replace the existing project or public URL.

## Owner-triggered release

The repository does not deploy on pull requests or merges. The `Owner-triggered release`
workflow is a manual dispatch and refuses to run unless the operator attests to all
of the following in the existing account/project: Workers Free plan, configured
MFA_ENCRYPTION_KEY metadata (the 32-byte base64 secret value is never in GitHub),
a completed D1 backup and restore location, an isolated free-plan staging exercise
with migrations and existing production-only Slack/Discord integration reconciliation,
inspected migration status, and configured secrets/settings. GitHub environment
protection should require the named release owner.

The workflow only **lists** remote migrations. It deliberately does not apply production
migrations automatically. An authorized operator must follow the backup/restore and
staging evidence above, then apply only the reviewed migrations as a separate command.
Never connect a staging frontend to the production D1 database. The workflow deploys the
API and the existing Pages project together, then runs the read-only release verifier.
It does not create a Pages project, replace the public URL, enable R2, or select a paid
fallback. Application deletion does not instantly erase operator D1 Time Travel or
other backup copies; no backup/restore proof is implied by these controls.

For a local preflight, run:

```sh
npm ci
npm run check
npm run build:api
npm run verify:deployment -- https://your-existing-pages-origin.example
```

For an authenticated operator, dispatch `.github/workflows/release.yml` with the
existing Pages project/origins and all five attestations set to true. Configure
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only as GitHub environment secrets.
The Pages project's server-side `API_ORIGIN` binding must already point to the same API
Worker origin supplied to the dispatch; the deployment command cannot safely infer or
rewrite that project setting.

Official references: [D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/), [Pages CLI](https://developers.cloudflare.com/workers/wrangler/commands/pages/), and [advanced-mode Pages workers](https://developers.cloudflare.com/pages/functions/advanced-mode/).

Expected release check:

| Boundary              | Required evidence                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First-party API       | `/api/health` returns JSON, `mode:support_review`, version ≥9, `billingMode:free_only`, `aiAvailable:true`, `mediaAvailable:false` and the workspaces, invitations, recovery, lifecycle, full-policy-scope, shared-capacity, usage, demo, feedback, evidence and chat features. |
| Private access        | Signed-out `/api/auth/me` returns 401 JSON with `Cache-Control:no-store`.                                                                                                                                    |
| Legacy public sharing | `/api/r/:id` returns 410.                                                                                                                                                                                    |
| Frontend              | Workspace selector, sample scenarios, chat/reference forms and feedback dialog are present with the Pages security headers.                                                                                  |
| Signed-in sample flow | Setup → actual AI review → evidence → human decision → saved feedback/export works.                                                                                                                          |

## Short demonstration

Use fictional sample data first, before importing any company documentation.

1. Create an account, choose **Personal workspace**, and click **Set up sample demo**. The button explicitly approves a fictional `[Sample]` policy. Setup is idempotent and cannot revive an archived policy or bypass team approval.
2. Click **Load scenario**, then **Review draft**. The active approved policy set is checked automatically. Inspect the quoted submission deadline, version and fingerprint. Record a human decision with a note. Model findings are not sent to a customer automatically.
3. Try **Wrong plan benefit**. Show how the Starter export limit conflicts with the draft's unlimited-export claim.
4. Try **Unsupported account promise**. Explain that documentation cannot establish that a refund was issued or when the money will arrive. These assertions need account/action evidence.
5. Click **Give feedback**. Rate usefulness, select a category, and record a concrete obstacle or incorrect finding. The note can link to the currently displayed review. Owners/admins can inspect feedback and download JSON. Viewers can submit notes but cannot inspect other people's feedback or change reviews/policies.
6. Open **AI support chat** and ask about the refund deadline. The active approved policy set is checked automatically. Open the generated claim review and inspect it before any approval. Test a follow-up and an account-specific question that policy cannot answer.
7. Open **Add supporting reference** on a saved review. Save a link, inspect and approve it, then attach it with a claim explanation. Explain that hosted media is disabled under the free-only constraint; demonstrate file upload/download only in the local emulator. Attachments supplement a record; they cannot make missing AI evidence pass. See [storage setup and feature evaluation](EVIDENCE_CHAT.md).
8. Briefly show the company workflow: create a team, add a registered teammate as a second admin, save a policy version, and have the other admin approve it. Show the audit event and a shared review decision.

These examples run the actual configured review engine; results are not prerecorded. If a real-model finding is wrong or evaluation fails, retain it and record evidence feedback. Do not replace a failed result with a staged success or suggest that quotes alone establish semantic accuracy.

## Ask for a small, useful trial

Offer one support queue or product policy set with human review before sending. Agree on the relevant product, region, customer plan and policy owner. Import only documentation the company approves for this pilot, and use redacted reply examples. Veriq currently does not intercept Zendesk/Intercom, access account records, reset passwords, provide SSO/SCIM or send customer messages. TOTP MFA is available only when the operator provisions the encrypted MFA secret and is not an enterprise identity provider. All non-personal team content, including viewer reads and exports, requires a TOTP-verified session; a password-only legacy session is intentionally paused until setup/login.

Ask the company:

- Which incorrect support claims cost your team the most time or trust?
- Who approves policy versions, and how often do the rules change?
- Could your reviewers use this on real drafts next week? What would prevent that?
- Which findings were useful, incorrect, or missing context?
- What integration and identity controls are required before wider use?

Have trial members select the shared company workspace before leaving feedback so the designated owner/admins can read it. Notes left in a personal workspace remain private to its owner.

Use the feedback categories to separate workflow friction, evidence quality and missing context. A 1–5 usefulness rating is subjective feedback, not an accuracy score or purchase commitment. Avoid putting customer identifiers in notes; feedback and evidence exports contain private workspace data.

## Measure before making claims

Collect a held-out set of representative replies with a company reviewer’s expected findings. Measure false approvals, detection precision/recall, human review time, real request latency/cost and repeated use. See [evaluation](EVALUATION.md). Agree on acceptance criteria before measuring. Do not report ROI or accuracy based only on the sample scenarios or automated fixtures.

Feedback is append-only through the API, limited to 10 notes per account per UTC day and 1,000 notes per workspace. Administrative JSON exports include notes, author emails, timestamps and optional review IDs. Establish agreed retention/deletion and security requirements before expanding beyond the controlled pilot.
