# AI chat and reference store release

## What users can do

1. In **AI support chat**, ask a question against every active approved policy in the bounded workspace policy set. The model produces a draft; the existing checker evaluates its sentences before the answer is shown. **Open claim review** shows exact supporting/contradicting quotes and the usual human decision controls. Nothing is sent to customers.
2. Ask a follow-up or choose **Continue conversation** on a saved turn. Up to six previous turns supply context. Start a **New conversation** to clear the parent. The active policy set remains the evidence scope for every new turn; a policy change may require restarting after a corpus-conflict response.
3. In **Links & media**, save a bookmark or upload a file with title/context. New items are drafts. An owner/admin inspects and approves them; team authors need a different administrator. Save a new item to change immutable metadata.
4. Open a saved review and choose **Add supporting reference**. Enter an explanation of which claim it supports and click **Attach to review** on an approved reference. Open the review again to see the attachment or export it with the review JSON. Up to 20 references attach to one review.

Approval of a reference records a person's inspection. It does not establish universal truth or override missing/contradicting AI evidence. Bookmark URLs are never fetched; remote pages may change. Media is stored, not interpreted: OCR, transcription, malware scanning and automated media claim verification are not implemented. Downloads are forced attachments rather than inline executable content.

## Free-only production and local media

Production media uploads are disabled. R2's free allowance can incur overage charges, so activating a subscription or creating a remote bucket is outside the [free-only policy](FREE_TIER_POLICY.md). Hosted users can save, approve and attach links to approved company resources. Chat and AI review require verification of the existing Workers Free plan and a TOTP-verified team session; the UI explains a pause until those checks are recorded.

The existing file workflow remains testable with simulated local R2. To try it without activating a cloud storage subscription:

1. Copy `apps/api/wrangler.toml` to `apps/api/wrangler.local.toml` (ignored by Git).
2. Set `LOCAL_MEDIA_DEMO = "true"` in that copy's `[vars]` section. Append this top-level block after `[ai]`:

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "veriq-local-media"
remote = false
```

3. Run `npx wrangler d1 migrations apply veriq-db --local --config apps/api/wrangler.local.toml` and `npx wrangler dev --local --config apps/api/wrangler.local.toml --port 8787 --var WEB_ORIGIN:http://localhost:8788`. Run `npm run dev:web` separately.
4. Use HTTP localhost for the API. Never add a remote R2 binding, deploy this local configuration or activate R2 checkout. AI remains paused by default: a local Workers AI binding can still use remote inference, so it also requires a verified Free account before enabling.

Production ignores `MEDIA` even if a bucket is accidentally bound. Health returns `mediaAvailable:false`, upload/download fail without storage IO, and the UI keeps links usable. Existing media metadata remains visible but its bytes are unavailable in a hosted free-only release. Keep any previously stored objects intact; this change does not delete them or cancel existing account subscriptions.

Official contracts: [R2 Worker binding and operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 bucket privacy](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/), [Workers AI model](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/). The existing direct Workers AI binding is retained; no new AI-provider credential or framework migration is required.

Limits: 500 saved references and 100 MiB per workspace, 5 MiB per file, 10 file attempts/account/minute. Archived references count toward retention/storage limits. Allowed files: PNG, JPEG, PDF, MP3, WAV, MP4 with matching declared MIME and file signature. A signature check is not full file validation or malware detection. Stored hash metadata is checked at approval/download; independently privileged R2 administrators must preserve object immutability. Inspect file types safely using your company's file-handling tools.

Metadata reserves capacity before object upload. On a handled upload failure, the draft reservation is removed and object cleanup is attempted. A worker crash or unavailable R2 can leave a draft without bytes or an orphan object. Periodically reconcile D1 `evidence_items.object_key` with private bucket objects; unavailable files cannot be approved or downloaded. There is no automatic retention/deletion or reconciliation job yet. Do not delete attached historical files casually.

## Status after this PR

This release is implemented for controlled pilots with private workspace chat, bookmarks and media, human approval and audit history. It adds automated tests for access, retries, invalid media, upload failures, quotas, archived policies and revoked memberships. A separate local workerd/D1/R2 run passed signup, multipart PDF upload, reference approval and exact-byte private download using the actual runtime bindings. The browser workflow tests actual form submission, chat follow-up, claim review, link attachment and PDF download through the production API handler and SQLite, with controlled AI and an in-memory R2 contract fixture.

CI or a merge does not prove live model accuracy, R2 configuration or deployment. After deployment, verify API version 9 with `free_tier_policy`, `evidence_store`, `ai_chat`, `full_policy_scope`, `shared_ai_capacity` and `totp_mfa`, confirm the account Free plan, `aiAvailable:true`, `mfaAvailable:true` and `mediaAvailable:false`, then run signed-in hosted tests with actual Workers AI and both pilot accounts. Test file operations separately in the local emulator. Broader enterprise readiness still requires identity controls, customer-specific data integrations, operational recovery/retention, monitoring and independent security review.

For every following PR, report the user-visible changes and workflow, checks passed/failed, remaining product risks, merge status, and actual deployment version separately. Use concrete evidence rather than a generic readiness score.
