# Support draft review architecture

## Scope and trust boundary

Veriq reviews a draft against explicitly approved company documentation. Its
output describes documentary support, not universal truth. The source set is
selected by the signed-in account, with every document query scoped to that
account. This pilot has one private library per account. Shared company
workspaces, role-based approval, service API keys, and helpdesk interception are
future work; there is no automatic sending.

The browser's `/api/*` calls stay on the Pages origin. `apps/web/_worker.js`
forwards them to the configured Worker while preserving session cookies. This
avoids relying on third-party cookies between pages.dev and workers.dev.
`WEB_ORIGIN` on the API must equal the Pages origin. Unknown browser origins
are rejected; JSON mutations and private responses use `Cache-Control: no-store`.

## Data lifecycle

`support_documents` stores immutable text, title, version, SHA-256 content hash,
optional source URL, owner, and status. New documents are drafts. Only a direct
approval action makes them eligible. Archiving removes them from new review
requests; their text remains available for historical provenance. There is no
endpoint to overwrite an approved text or delete its historical source.

`support_reviews` stores the full draft and a receipt snapshot: document IDs,
versions and hashes, exact quotes, findings and evaluation failures. Review
lookups require both ID and account ownership. Legacy public sharing is retired;
old `receipts` data remains in D1 but is not exposed by the new API.

KV is used only for the existing authentication rate limiter. Review results
are not globally cached. The daily D1 quota uses a conditional atomic upsert.
Input validation happens before review quota consumption. Model failures consume
a review attempt and remain explicit in the saved receipt.

## Review pipeline

1. Validate all input and preserve every draft sentence. Over-budget drafts are
   rejected before any AI work. Compound sentences remain intact, and support
   must cover the entire sentence rather than one convenient subclaim.
2. Retrieve two overlapping, contiguous windows from each selected document,
   ranked using lexical overlap. No external URLs are fetched. Every selected
   document contributes passages, including potentially contradicting policies.
3. Bound evaluation to 20 seconds per model call and a 60-second draft budget.
   Timed-out or unprocessed sentences receive explicit failure receipts. Ask Workers AI to classify evidence against each sentence. Instructions
   explicitly treat draft and document text as untrusted data, require plan,
   region, numerical and conditional matching, and prohibit outside knowledge.
4. Validate returned passage IDs, stance values and exact quote substrings
   against both the retrieved passage and immutable source. Invalid evidence or
   malformed model output cannot yield a supported finding. Only a deterministic
   courtesy allowlist can exempt a sentence from evaluation.
5. Aggregate supported/contradicted/conflicting/unsupported findings into a
   draft review status. Preserve both sides of conflicts. No probability is
   invented from citation counts.
6. Recheck approval eligibility before saving. Return a conflict response if a
   selected document was archived during evaluation. Historical reviews show
   their original source versions rather than claiming they are current.

## Practical limitations

Retrieval examines excerpts, not every part of every document. Relevant conditions
or counter-evidence may be missed. Exact quote validation proves quote provenance,
not the model's semantic interpretation. Prompt instructions reduce exposure to
injected instructions but are not a complete defense. The system can misjudge
conditional, compound, or customer-specific assertions. Human review and a
real labeled evaluation are required. Model latency and cost are not benchmarked.

The editor clears receipts when the draft or selected policy set changes. A
historical review is explicitly labeled historical. Version labels do not imply
automatic precedence: archive superseded policy versions yourself.

## Migration and rollout

This is a coordinated breaking API/web change; do not deploy only the new UI.

1. Back up the existing D1 database. Inspect its `users`, `sessions`, `usage`, and
   `receipts` schemas against `0001_existing_auth.sql`. Bootstrap uses
   `CREATE TABLE IF NOT EXISTS` and does not alter existing columns. Verify the
   existing `usage` table has a unique key on `(ip, day)` for quota upserts.
2. Apply both migration files using Wrangler's D1 migration command for the
   target environment. `npm run db:migrate:local` affects local state only.
   Production migrations require a separately authorized deployment operation.
3. Configure API `WEB_ORIGIN` and Pages `API_ORIGIN` for the same target
   environment. Run a real Workers AI smoke review with nonsensitive policies.
4. Deploy the API and Pages app in one maintenance window. Pages must include
   `_worker.js` and `_routes.json`; copying only HTML breaks the first-party API.
5. Validate signup/login, document approval, missing and conflicting evidence,
   private history, account isolation, and retired public routes in that target.

The migrations are additive. Rollback code deliberately does not drop document
or review tables. Rolling back the old public sharing code reintroduces its
public receipt access, so do not do that without a separate privacy review.

## Next product milestones

- Pilot with one support workflow and measure false approvals, reviewer time,
  latency, and cost against a simple LLM-checking baseline.
- Add organization roles, separate authors/approvers, customer/account context,
  expiry and effective dates, and policy-specific eligibility checks.
- Add helpdesk integrations with explicit pre-send human review, source imports,
  and retrieval improvements driven by labeled pilot failures.
