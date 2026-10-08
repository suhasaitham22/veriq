# AI chat and reference store release

## What users can do

1. In **AI support chat**, select 1–10 active approved policy versions and ask a question. The model produces a draft; the existing checker evaluates its sentences before the answer is shown. **Open claim review** shows exact supporting/contradicting quotes and the usual human decision controls. Nothing is sent to customers.
2. Ask a follow-up or choose **Continue conversation** on a saved turn. Up to six previous turns supply context. Start a **New conversation** to clear the parent. Current selected policies are the evidence for every new turn.
3. In **Links & media**, save a bookmark or upload a file with title/context. New items are drafts. An owner/admin inspects and approves them; team authors need a different administrator. Save a new item to change immutable metadata.
4. Open a saved review and choose **Add supporting reference**. Enter an explanation of which claim it supports and click **Attach to review** on an approved reference. Open the review again to see the attachment or export it with the review JSON. Up to 20 references attach to one review.

Approval of a reference records a person's inspection. It does not establish universal truth or override missing/contradicting AI evidence. Bookmark URLs are never fetched; remote pages may change. Media is stored, not interpreted: OCR, transcription, malware scanning and automated media claim verification are not implemented. Downloads are forced attachments rather than inline executable content.

## Private R2 setup

The existing Cloudflare account must have R2 enabled. This can require a payment method; the code does not activate a paid service or create a production bucket automatically. Links and chat operate without R2. Health returns `mediaAvailable:false`, the UI disables media uploads and the endpoint returns a clear 503.

After activating R2 through the account's normal process, an authenticated operator can create the bucket:

```sh
npx wrangler r2 bucket create veriq-media
```

Uncomment the `[[r2_buckets]]` block in `apps/api/wrangler.toml` with binding `MEDIA` and the actual private bucket name. Keep the bucket's public development URL and public custom domains disabled. The API serves downloads only after session/workspace authorization. For staging use a different bucket and database; never point staging uploads at production.

With that binding in the local configuration, `wrangler dev` uses local R2 storage by default. Do not set `remote = true` for local demo uploads. Run local D1 migrations through 0005, start the API/Pages servers and test upload/download. Existing commands are in the README. Production requires the coordinated authenticated deployment in [COMPANY_DEMO.md](COMPANY_DEMO.md), including migration 0005 and both API/Pages workers.

Official contracts: [R2 Worker binding and operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 bucket privacy](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/), [Workers AI model](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/). The existing direct Workers AI binding is retained; no new AI-provider credential or framework migration is required.

Limits: 500 saved references and 100 MiB per workspace, 5 MiB per file, 10 file attempts/account/minute. Archived references count toward retention/storage limits. Allowed files: PNG, JPEG, PDF, MP3, WAV, MP4 with matching declared MIME and file signature. A signature check is not full file validation or malware detection. Stored hash metadata is checked at approval/download; independently privileged R2 administrators must preserve object immutability. Inspect file types safely using your company's file-handling tools.

Metadata reserves capacity before object upload. On a handled upload failure, the draft reservation is removed and object cleanup is attempted. A worker crash or unavailable R2 can leave a draft without bytes or an orphan object. Periodically reconcile D1 `evidence_items.object_key` with private bucket objects; unavailable files cannot be approved or downloaded. There is no automatic retention/deletion or reconciliation job yet. Do not delete attached historical files casually.

## Status after this PR

This release is implemented for controlled pilots with private workspace chat, bookmarks and media, human approval and audit history. It adds automated tests for access, retries, invalid media, upload failures, quotas, archived policies and revoked memberships. A separate local workerd/D1/R2 run passed signup, multipart PDF upload, reference approval and exact-byte private download using the actual runtime bindings. The browser workflow tests actual form submission, chat follow-up, claim review, link attachment and PDF download through the production API handler and SQLite, with controlled AI and an in-memory R2 contract fixture.

CI or a merge does not prove live model accuracy, R2 configuration or deployment. After deployment, verify API version 6 with `evidence_store` and `ai_chat`, inspect `mediaAvailable`, then run signed-in tests with actual Workers AI/R2 and both pilot accounts. Broader enterprise readiness still requires identity controls, customer-specific data integrations, operational recovery/retention, monitoring and independent security review.

For every following PR, report the user-visible changes and workflow, checks passed/failed, remaining product risks, merge status, and actual deployment version separately. Use concrete evidence rather than a generic readiness score.
