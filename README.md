# Veriq

**Verify anything.** Paste a claim — Veriq splits it into checkable facts, finds real sources, and returns a *receipt* per claim: verdict, confidence, verbatim quotes, and links. No vibes, only evidence.

Live demo: https://veriq-1q9.pages.dev

## How it works

Paste text, then the pipeline runs: (1) split into atomic checkable claims via gpt-oss-20b, (2) search Wikipedia plus adversarial "myth debunked" queries, (3) rerank with bge embeddings scoring claim-to-article fit, (4) extract the most relevant sentences per article, (5) LLM judge decides supports/refutes/neutral with a verbatim quote, (6) deterministic aggregation produces the receipt: supported, contested, refuted, or unverifiable.

Every citation is a verbatim quote verified as a substring of its source. Source credibility is a deterministic formula (publisher tier x recency) — never an LLM's opinion. If a claim can't be verified, Veriq says unverifiable instead of guessing.

## Example

Input: "Honey stays edible for thousands of years when sealed"

Receipt: Verdict SUPPORTED (65% confidence, 4 sources checked). Evidence: "Samples of honey discovered in archaeological contexts have proven edible even after millennia." — Honey (Wikipedia). What would change this: "A credible primary source contradicting it would change this."

## Stack

All on Cloudflare's free tier — no API keys, no credit card:

- Web app: Cloudflare Pages
- API: Cloudflare Workers
- Models: Workers AI (gpt-oss-20b, bge-base-en-v1.5)
- Search: Wikipedia API (no key needed)
- Auth: PBKDF2 + sessions in D1
- Storage: D1 (users, receipts) + KV (verdict cache)
- Extensions: Chrome + Firefox (shared MV3 codebase)

## Repo layout

- apps/api — Worker: /api/verify, /api/receipt/:id, /api/auth/*
- apps/web — Web app: landing, login, dashboard
- extensions/ — Browser extensions (Chrome + Firefox)
- docs/ — Architecture notes

## Run it yourself

API: cd apps/api && npx wrangler dev (needs a Cloudflare account with Workers AI enabled)

Web: npx wrangler pages dev apps/web (point it at your API URL in app.js)

Set TAVILY_API_KEY as a Worker secret to upgrade search beyond Wikipedia (optional — 1,000 free queries/mo).

## Design rules

1. A citation without a verbatim quote is not evidence.
2. Source credibility is computed, never judged by an LLM.
3. Every verdict ships its counter-evidence and a "what would change my mind" line.
4. Unverifiable is a first-class verdict, not a failure mode.

## License

MIT — see LICENSE.
