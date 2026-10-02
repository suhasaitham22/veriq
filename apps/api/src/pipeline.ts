/**
 * pipeline.ts — the Veriq verification pipeline.
 * Six small stages, each a pure-ish function. The LLM is used only
 * where judgment is needed (split, entail); everything else is
 * deterministic and cheap.
 */
import { scoreSource } from "./credibility";

export type Verdict = "supported" | "contested" | "refuted" | "unverifiable";
export type Stance = "supports" | "refutes" | "neutral";

export interface Claim { id: string; text: string; checkable: boolean; skipReason?: string }
export interface Candidate { url: string; title: string; snippet: string; fit: number; credibility: number }
export interface Evidence { quote: string; url: string; title: string; stance: Stance; credibility: number }
export interface Receipt {
  claim: string; verdict: Verdict; confidence: number;
  evidence: Evidence[]; counterEvidence: Evidence[];
  changeMyMind: string; sourcesChecked: number;
}

interface Ctx { ai: Ai; searchKey: string }

/* ---------- 1. split: text → atomic, checkable claims ---------- */

export async function splitClaims(text: string, ctx: Ctx): Promise<Claim[]> {
  const res = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "Extract atomic factual claims as JSON: [{\"text\": \"...\", \"checkable\": true|false, \"skipReason\": \"...\"}]. Split compound sentences. Mark opinions, predictions, and vague claims checkable=false." },
      { role: "user", content: text.slice(0, 4000) },
    ],
    response_format: { type: "json_object" },
  }) as { response: string };
  const parsed = JSON.parse(res.response);
  const list = Array.isArray(parsed) ? parsed : parsed.claims ?? [];
  return list.map((c: any, i: number) => ({ id: `c${i}`, text: String(c.text), checkable: !!c.checkable, skipReason: c.skipReason }));
}

/* ---------- 2. search: support queries + disproof queries ---------- */

async function searchWeb(query: string, ctx: Ctx) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: { "X-Subscription-Token": ctx.searchKey },
  });
  const j = await r.json() as any;
  return (j.web?.results ?? []).map((x: any) => ({ url: x.url, title: x.title, snippet: x.description ?? "" }));
}

function disproofQuery(claim: string): string {
  return `evidence against: ${claim}`;
}

async function searchClaim(claim: Claim, ctx: Ctx) {
  const [pro, con] = await Promise.all([
    searchWeb(claim.text, ctx),
    searchWeb(disproofQuery(claim.text), ctx), // adversarial pass — always try to disprove
  ]);
  const seen = new Set<string>();
  return [...pro, ...con].filter((x) => !seen.has(x.url) && seen.add(x.url));
}

/* ---------- 3+4. shortlist + rerank: embeddings → fit × credibility ---------- */

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embed(texts: string[], ctx: Ctx): Promise<number[][]> {
  const out = await ctx.ai.run("@cf/baai/bge-base-en-v1.5", { text: texts }) as { data: number[][] };
  return out.data;
}

export async function shortlistAndRerank(claim: Claim, ctx: Ctx): Promise<Candidate[]> {
  const results = await searchClaim(claim, ctx);
  if (!results.length) return [];
  const [claimVec, ...vecs] = await embed([claim.text, ...results.map((r) => `${r.title}. ${r.snippet}`)], ctx);
  return results
    .map((r, i) => {
      const fit = +cosine(claimVec, vecs[i]).toFixed(3);
      const { credibility } = scoreSource(r.url);
      return { ...r, fit, credibility, rank: fit * 0.6 + credibility * 0.4 };
    })
    .filter((c) => c.fit > 0.35)          // relevance floor — the "jev" classifier
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 5);
}

/* ---------- 5. entail: fetch → verbatim quotes → stance ---------- */

async function fetchQuotes(url: string): Promise<string[]> {
  try {
    const html = await (await fetch(url, { headers: { "User-Agent": "VeriqBot/0.1" } })).text();
    return html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
      .split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 60 && s.length < 400).slice(0, 40);
  } catch { return []; }
}

async function judgeStance(claim: string, quote: string, ctx: Ctx): Promise<Stance> {
  const res = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "Reply with exactly one word: supports, refutes, or neutral. Does the quote support or refute the claim?" },
      { role: "user", content: `Claim: ${claim}\nQuote: ${quote}` },
    ],
  }) as { response: string };
  const w = res.response.trim().toLowerCase();
  return w.startsWith("support") ? "supports" : w.startsWith("refut") ? "refutes" : "neutral";
}

export async function gatherEvidence(claim: Claim, candidates: Candidate[], ctx: Ctx): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const c of candidates) {
    const sentences = await fetchQuotes(c.url);
    if (!sentences.length) continue;
    const claimVec = (await embed([claim.text], ctx))[0];
    const vecs = await embed(sentences.slice(0, 12), ctx);
    const best = sentences.slice(0, 12)
      .map((s, i) => ({ s, fit: cosine(claimVec, vecs[i]) }))
      .sort((a, b) => b.fit - a.fit)[0];
    if (!best || best.fit < 0.5) continue;
    const stance = await judgeStance(claim.text, best.s, ctx);
    if (stance === "neutral") continue;
    out.push({ quote: best.s, url: c.url, title: c.title, stance, credibility: c.credibility });
    if (out.length >= 4) break;
  }
  return out;
}

/* ---------- 6. verdict: deterministic aggregation ---------- */

export function toVerdict(claim: Claim, evidence: Evidence[], sourcesChecked: number): Receipt {
  const forIt = evidence.filter((e) => e.stance === "supports");
  const against = evidence.filter((e) => e.stance === "refutes");
  const topTier = (list: Evidence[]) => list.some((e) => e.credibility >= 0.6);

  let verdict: Verdict = "unverifiable";
  if (forIt.length >= 2 && topTier(forIt) && !against.length) verdict = "supported";
  else if (forIt.length && against.length && (topTier(forIt) || topTier(against))) verdict = "contested";
  else if (against.length && topTier(against) && !forIt.length) verdict = "refuted";

  const agreement = forIt.length + against.length;
  const confidence = verdict === "unverifiable" ? 0 :
    Math.min(0.97, 0.4 + 0.15 * agreement + 0.1 * (topTier(evidence) ? 1 : 0));

  return {
    claim: claim.text, verdict, confidence: +confidence.toFixed(2),
    evidence: forIt, counterEvidence: against, sourcesChecked,
    changeMyMind: against.length
      ? "A primary source directly supporting the claim would change this."
      : forIt.length
        ? "A credible primary source contradicting it would change this."
        : "Any checkable primary-source evidence either way would change this.",
  };
}

/* ---------- orchestrator ---------- */

export async function verify(text: string, ctx: Ctx): Promise<Receipt[]> {
  const claims = (await splitClaims(text, ctx)).filter((c) => c.checkable);
  const receipts: Receipt[] = [];
  for (const claim of claims.slice(0, 6)) { // cap: protects the neuron budget
    const candidates = await shortlistAndRerank(claim, ctx);
    const evidence = await gatherEvidence(claim, candidates, ctx);
    receipts.push(toVerdict(claim, evidence, candidates.length));
  }
  return receipts;
}
