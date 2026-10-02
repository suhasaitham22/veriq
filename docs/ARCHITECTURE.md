# Veriq Architecture

## Principles

1. **Evidence, not vibes.** Every verdict is backed by verbatim quotes, each verified as an exact substring of its source page.
2. **Small models filter, one small LLM judges.** Embeddings and reranking do the cheap relevance work; the LLM only sees the survivors.
3. **Deterministic where it matters.** Source credibility and verdict aggregation are pure functions — auditable, testable, no prompts.
4. **Adversarial by default.** Every claim is searched both for support *and* for refutation. A verdict that never met its counter-evidence is not a verdict.
5. **Free-tier native.** The whole stack runs on Cloudflare's free tier. Quotas are a design input: cache aggressively, rate-limit per user, degrade gracefully when the daily AI budget is spent.

## Pipeline

```
1. split      LLM → [{ text, checkable, reason }]
                Drops opinions, predictions, vague claims. Each claim atomic.

2. search     For each claim: support queries + disproof queries
                → web search API (Brave) → [{ url, title, snippet }]

3. shortlist  bge embeddings: embed(claim), embed(snippet)
                cosine similarity → keep top 12 per claim.

4. rerank     fit × credibility → keep top 5.
                fit       = embedding cosine similarity
                credibility = credibility.ts formula (tier, recency, type)

5. entail     Fetch pages → extract candidate quotes → LLM judges each
                quote as supports / refutes / neutral vs the claim.
                Quotes failing the substring check are discarded.

6. verdict    Deterministic aggregation → receipt:
                supported | contested | refuted | unverifiable
                + confidence, + counter-evidence, + "what would change my mind"
```

## Data

- **D1** `receipts` — verdicts, keyed by content hash (dedupe + shareable URLs).
- **D1** `usage` — per-IP daily counters for rate limiting.
- **KV** `verdict-cache` — hash(text) → receipt, 7-day TTL.
- **R2** `snapshots` — fetched source pages, so receipts stay reproducible.
- **Workers AI** — `@cf/baai/bge-base-en-v1.5` (embeddings), `@cf/meta/llama-3.1-8b-instruct` (split + entail).

## Verdict logic

- **supported** — ≥2 independent tier-1/2 sources agree, none refute.
- **contested** — credible sources disagree.
- **refuted** — credible source directly contradicts, none support.
- **unverifiable** — no checkable evidence found (or the claim wasn't checkable).

Confidence = f(agreement, source tiers, quote count). Never 100%.

## Extensions

One shared MV3 codebase (`extensions/shared`). `chrome/manifest.json` and
`firefox/manifest.json` differ only in metadata. Content script extracts the
page's main text; the popup calls `POST /api/verify` and renders receipts.

## Roadmap

- **v0.1** — web app, text input, sync verification.
- **v0.2** — extensions, URL + screenshot input, async queue for deep checks.
- **v0.3** — public API, GitHub Action, scheduled re-verification of trending claims.
