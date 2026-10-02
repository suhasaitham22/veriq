# Veriq

**Verify anything.** Paste text, a URL, or a screenshot — Veriq splits it into checkable claims, hunts down real sources, and returns a *receipt* per claim: verdict, confidence, verbatim quotes, and links. No vibes, only evidence.

## The idea in one paragraph

The internet made publishing free and verification expensive. Veriq flips that: a small-model pipeline (embeddings → reranker → entailment) does the expensive part at edge cost, every citation is a verbatim quote verified against its source page, and source credibility is a deterministic formula — never an LLM's opinion. If a claim can't be verified, Veriq says so.

## Architecture

```
paste text / URL / page
      │  apps/web, extensions
      ▼
POST /api/verify  (apps/api — Cloudflare Worker)
      │
      ├─ 1. split      → atomic, checkable claims (Llama 3.1 8B)
      ├─ 2. search     → web results, incl. disproof queries (adversarial pass)
      ├─ 3. shortlist  → bge embeddings, cosine fit per claim
      ├─ 4. rerank     → claim↔source fit × credibility score
      ├─ 5. entail     → quote extraction + supports/refutes/neutral (LLM)
      └─ 6. verdict    → deterministic aggregation → receipt
                              supported · contested · refuted · unverifiable
```

Everything runs on Cloudflare's free tier: Pages (web), Workers (API), Workers AI (models), D1 (receipts, rate limits), KV (verdict cache), R2 (source snapshots).

## Repo layout

```
apps/api          Cloudflare Worker — /api/verify, /api/receipt/:id
apps/web          Web app (Cloudflare Pages)
extensions/       Chrome + Firefox (shared MV3 codebase)
docs/             Architecture notes
```

## Quickstart

```sh
npm install
# web
npx wrangler pages dev apps/web
# api (needs: SEARCH_API_KEY, Cloudflare account with Workers AI)
cd apps/api && npx wrangler dev
```

## Rules the system is built on

1. A citation without a verbatim quote is not evidence.
2. Source credibility is computed, never judged by an LLM.
3. Every verdict ships its counter-evidence and a "what would change my mind" line.
4. Unverifiable is a first-class verdict, not a failure.

## License

MIT — see [LICENSE](LICENSE).
