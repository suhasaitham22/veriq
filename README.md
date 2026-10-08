# Veriq

**Review support answers against approved company documentation before sending.**

Veriq checks customer-support drafts sentence by sentence using a private library
of policies and product documentation. Each finding contains exact quotes,
document versions, and evidence fingerprints. Missing evidence, contradictions,
and conflicting policies remain visible for a human reviewer.

This is a support-review pilot. It does not search the public web, establish
universal truth, access customer account records, or send replies to customers.
The existing live deployment is not automatically updated by this change.

## Workflow

1. Sign in and paste a document with a title, version, and optional source link.
2. Inspect the saved text and explicitly approve that immutable version.
3. Select the relevant approved documents and paste a support draft.
4. Inspect each sentence's evidence and resolve missing or conflicting information.
5. Make the final sending decision in your support tool.

Changing a document requires a new version. Archive outdated versions to exclude
them from new reviews. Multiple approved versions can conflict; Veriq does not
silently choose the version with the newest-looking label. Historical reviews
retain their exact quotes and the document hashes used at review time.

## Review outcomes

| Finding | Meaning |
| --- | --- |
| supported | Retrieved approved passages support the entire sentence. |
| contradicted | A retrieved approved passage contradicts the sentence. |
| conflicting | Supporting and contradicting evidence were both returned. |
| unsupported | Evidence was missing, invalid, or evaluation failed. |
| not_applicable | A narrowly allowlisted greeting or courtesy. |

Draft-level status is `requires_changes` for contradictions/conflicts,
`needs_review` for missing evidence or failed evaluation, and `ready_for_review`
only when all factual statements have valid supporting evidence. **Every outcome
still requires a human decision.** There are no uncalibrated confidence percentages.

## Run locally

Requires Node.js 24+, npm, and a Cloudflare account for live Workers AI requests.

```sh
npm ci
npm run db:migrate:local
npm run dev:api
# In another terminal:
npm run dev:web
```

Open `http://localhost:8788`. The Pages worker forwards `/api/*` to the local API.
The browser uses first-party session cookies. The local API script explicitly
sets `WEB_ORIGIN` to that web origin. `API_ORIGIN` configures the server-side
Pages proxy; it is not a browser-supplied destination.

## Checks

```sh
npm run check          # TypeScript + pipeline/API/SQLite/proxy regression tests
npm run build:api      # Local esbuild compilation; no deployment or upload
npx playwright install chromium
npm run test:browser   # Browser → real API handler → SQLite → UI, controlled AI
```

GitHub Actions runs these checks on pull requests. Controlled model responses
prove pipeline behavior and integrations, not production model accuracy. See
[the evaluation plan](docs/EVALUATION.md) before enabling real customer workflows.

## API

All document and review routes require the existing `veriq_session` cookie. Each
account is an isolated pilot library; shared organizations, roles, and API-key
authentication are not implemented yet.

| Route | Purpose |
| --- | --- |
| `POST /api/documents` | Save `{title, version, content, sourceUrl?}` as a draft version. |
| `GET /api/documents` | List your private document versions and approval states. |
| `POST /api/documents/:id/approve` | Approve a draft version. |
| `POST /api/documents/:id/archive` | Exclude a version from future reviews. |
| `POST /api/reviews` | Review `{draft, documentIds}`; returns `{id, review}`. |
| `GET /api/reviews` | List your recent private reviews. |
| `GET /api/reviews/:id` | Retrieve your review and original draft. |

Authentication routes remain `/api/auth/signup`, `/login`, `/logout`, and `/me`.
`GET /api/health` identifies `mode: support_review`. The old `/api/verify` and
public `/api/r/:id` routes return `410 Gone`; there are no public receipt links.
Source URLs are labels/links, not fetched remotely. Paste source text explicitly.

Limits: 3,000 draft characters, 12 sentences, 10 selected approved documents,
20,000 characters per document, 60,000 characters in the selected policy set,
50 stored versions per pilot account, and 50 reviews per account per UTC day.
Over-budget input is rejected, never silently truncated.

## Stack and deployment

Cloudflare Pages serves the web app and first-party API proxy. The API uses
Cloudflare Workers, Workers AI (`gpt-oss-20b`), D1, and KV for auth rate limiting.
No public-source credibility scoring, search service, or shared verdict cache is
used by support reviews. The browser extensions are permission-free workspace
launchers; see [extension packaging](extensions/README.md).

See [architecture and rollout](docs/ARCHITECTURE.md) for migrations and coordinated
API/web deployment. This repository change does not migrate the production
DB or publish a deployment. Hosted AI costs and latency need pilot measurement;
free-tier operation is not guaranteed.

## License

MIT — see LICENSE.
