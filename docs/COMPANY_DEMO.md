# Company demo and feedback pilot

## Deployment comes first

The existing app address is `https://veriq-1q9.pages.dev`. A GitHub merge does not deploy the API or migrate D1. On October 8, 2026, that address still served the old “Verify anything” site, `/api/health` returned homepage HTML, and the API Worker reported `v:2`. It is not the updated support-assurance demo.

Before sharing the link, an operator with access to the existing Cloudflare account must:

1. Authenticate Wrangler (`npx wrangler login`, then `npx wrangler whoami`) or provision an appropriately scoped deployment token through the account's normal secret management. Do not put tokens in repository files or chat.
2. Back up the target D1 database and inspect existing schemas and migration history. Reconcile production-only Slack/Discord handlers before replacing the Worker. See [architecture and rollout](ARCHITECTURE.md).
3. Test migration 0004 after 0001–0003 in staging with representative existing data. The new `pilot_feedback` table is additive; prior user/policy/review rows remain unchanged. Apply unapplied migrations to the intended production DB only after staging verification.
4. Deploy the API and Pages app from the same merged release. Confirm API `WEB_ORIGIN` equals the Pages origin, and Pages `API_ORIGIN` points to the API Worker. Deploy `apps/web`, including `_worker.js` and `_routes.json`; publishing HTML alone leaves the first-party API broken.
5. Run the release check, then sign in and exercise the sample scenarios with live Workers AI. The check verifies routing/version/privacy boundaries; it does not measure real-model accuracy.

Commands for the authenticated operator, after schema/backup/staging checks:

```sh
npm ci
npm run check
npm run build:api
npx wrangler d1 migrations list veriq-db --remote --cwd apps/api
npx wrangler d1 migrations apply veriq-db --remote --cwd apps/api
npx wrangler deploy --cwd apps/api --var WEB_ORIGIN:https://veriq-1q9.pages.dev
npx wrangler pages project list
# Replace EXISTING_PROJECT_NAME with the existing Pages project shown above:
npx wrangler pages deploy apps/web --project-name EXISTING_PROJECT_NAME --branch main
npm run verify:deployment -- https://veriq-1q9.pages.dev
```

If the existing Pages project uses Git builds, confirm its build output directory is `apps/web` and deploy the same release through that project. Follow the existing project's deployment model; do not create a different project just to obtain a URL. Staging must use its own database/bindings and matching origins. Do not connect a staging frontend to the production DB accidentally.

Official references: [D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/), [Pages CLI](https://developers.cloudflare.com/workers/wrangler/commands/pages/), and [advanced-mode Pages workers](https://developers.cloudflare.com/pages/functions/advanced-mode/).

Expected release check:

| Boundary              | Required evidence                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| First-party API       | `/api/health` returns JSON, `mode:support_review`, version ≥5 and demo/feedback/workspace features.   |
| Private access        | Signed-out `/api/auth/me` returns 401 JSON with `Cache-Control:no-store`.                             |
| Legacy public sharing | `/api/r/:id` returns 410.                                                                             |
| Frontend              | Workspace selector, sample scenarios and feedback dialog are present with the Pages security headers. |
| Signed-in sample flow | Setup → actual AI review → evidence → human decision → saved feedback/export works.                   |

## Short demonstration

Use fictional sample data first, before importing any company documentation.

1. Create an account, choose **Personal workspace**, and click **Set up sample demo**. The button explicitly approves a fictional `[Sample]` policy. Setup is idempotent and cannot revive an archived policy or bypass team approval.
2. Select **Documented policy**, click **Load scenario**, then **Review draft**. Inspect the quoted submission deadline, version and fingerprint. Record a human decision with a note. Model findings are not sent to a customer automatically.
3. Try **Wrong plan benefit**. Show how the Starter export limit conflicts with the draft's unlimited-export claim.
4. Try **Unsupported account promise**. Explain that documentation cannot establish that a refund was issued or when the money will arrive. These assertions need account/action evidence.
5. Click **Give feedback**. Rate usefulness, select a category, and record a concrete obstacle or incorrect finding. The note can link to the currently displayed review. Owners/admins can inspect feedback and download JSON. Viewers can submit notes but cannot inspect other people's feedback or change reviews/policies.
6. Briefly show the company workflow: create a team, add a registered teammate as a second admin, save a policy version, and have the other admin approve it. Show the audit event and a shared review decision.

These examples run the actual configured review engine; results are not prerecorded. If a real-model finding is wrong or evaluation fails, retain it and record evidence feedback. Do not replace a failed result with a staged success or suggest that quotes alone establish semantic accuracy.

## Ask for a small, useful trial

Offer one support queue or product policy set with human review before sending. Agree on the relevant product, region, customer plan and policy owner. Import only documentation the company approves for this pilot, and use redacted reply examples. Veriq currently does not intercept Zendesk/Intercom, access account records, reset passwords, provide SSO/MFA or send customer messages.

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
