/**
 * pipeline.ts — the Veriq verification pipeline.
 *
 * Six small stages. The LLM is used only where judgment is needed
 * (split, entail); everything else is deterministic and cheap.
 *
 * Search is pluggable: DuckDuckGo (no key, default) or Tavily
 * (set TAVILY_API_KEY secret for better results).
 */
import { scoreSource } from "./credibility";

export type Verdict = "supported" | "contested" | "refuted" | "unverifiable";
export type Stance = "supports" | "refutes" | "neutral";

export interface Claim { id: string; text: string; checkable: boolean; skipReason?: string; topic?: string }
export interface Candidate { url: string; title: string; snippet: string; fit: number; credibility: number }
export interface Evidence { quote: string; url: string; title: string; stance: Stance; credibility: number }
export interface Receipt {
  claim: string; verdict: Verdict; confidence: number;
  evidence: Evidence[]; counterEvidence: Evidence[];
  changeMyMind: string; sourcesChecked: number;
}

interface Ctx { ai: Ai; tavilyKey?: string }
interface RawResult { url: string; title: string; snippet: string }

/* ---------- 1. split: text → atomic, checkable claims ---------- */

export async function splitClaims(text: string, ctx: Ctx): Promise<Claim[]> {
  //
  const res = await ctx.ai.run("@cf/openai/gpt-oss-20b", {
    messages: [
      { role: "system", content: `Split the user's text into atomic factual claims. Each claim is ONE single verifiable fact. Break compound sentences apart.
Example — Input: "Paris is the capital of France and has about 2 million residents."
Output: {"claims": [{"text": "Paris is the capital of France.", "checkable": true, "topic": "Paris"}, {"text": "Paris has about 2 million residents.", "checkable": true, "topic": "Paris population"}]}
CRITICAL: Split on "and" whenever it joins two separate facts. "X was completed in 1889 and is 330 meters tall" MUST become two claims: "X was completed in 1889." and "X is 330 meters tall." Never leave "and" joining two verifiable facts in one claim.
For each claim, include a "topic": the 1-3 word Wikipedia-style article title to search for (e.g. "Honey", "Moon landing", "Albert Einstein").
Mark opinions, predictions, and vague unmeasurable statements as checkable=false with a skipReason.
Absolute statements like "X never happens" ARE checkable — verify them, don't skip them.
Reply with ONLY the JSON object.` },
      { role: "user", content: text.slice(0, 4000) },
    ],
    response_format: { type: "json_object" },
  }) as any;
  let list: any[] = [];
  try {
    const parsed = JSON.parse(String(res.response ?? res.choices?.[0]?.message?.content ?? "").trim()); // Handle both {response} and OpenAI-style {choices[0].message.content} formats.
    list = Array.isArray(parsed) ? parsed : parsed.claims ?? [];
  } catch { /* fall through to deterministic coverage below */ }
  const llmClaims: Claim[] = list.map((c: any, i: number) => ({
    id: `c${i}`, text: String(c.text).slice(0, 300),
    checkable: !!c.checkable, skipReason: c.skipReason,
    topic: String(c.topic || "").slice(0, 40),
  })).filter((c) => c.checkable);
  // Safety net: deterministically split any compound claim the LLM left joined by " and ".
  const split: Claim[] = [];
  for (const c of llmClaims) {
    const parts = c.text.split(/\s+and\s+(?=(?:is|are|was|were|has|have|had|stands?|measures?|contains?|includes?|features?|reaches?|spans?|covers?|extends?|runs?|goes?|lies?|became|opened|freezes?|boils?|melts?|weighs?|costs?|lasts?|takes?|[A-Z]))/i);
    if (parts.length > 1 && parts.every((p) => p.trim().length > 15)) {
      const subject = c.text.split(/\s+/).slice(0, 3).join(" ");
      parts.forEach((p, j) => {
        let t = p.trim();
        if (j > 0 && /^[a-z]/.test(t) && !/^(the|a|an|it|they|he|she)\b/i.test(t)) {
          t = `${subject} ${t}`;
        }
        split.push({ id: `${c.id}s${j}`, text: t.replace(/\.*$/, ".").slice(0, 300), checkable: true, topic: c.topic });
      });
    } else {
      split.push(c);
    }
  }

  // Deterministic coverage: every input sentence must be represented as a claim.
  // The LLM refines; this guarantees nothing is silently dropped.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 15);
  const covered = (s: string) => split.some((c) => overlap(s, c.text) > 0.5);
  const extra: Claim[] = sentences.filter((s) => !covered(s))
    .map((s, i) => ({ id: `d${i}`, text: s.slice(0, 300), checkable: true, topic: searchPhrase(s) }));
  return [...split, ...extra];
}

/* ---------- 2. search: support queries + disproof queries ---------- */

async function searchTavily(query: string, key: string): Promise<RawResult[]> {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: 8, include_answer: false }),
    });
    const j = await r.json() as any;
    return (j.results ?? []).map((x: any) => ({
      url: x.url, title: String(x.title ?? "").slice(0, 200), snippet: String(x.content ?? "").slice(0, 400),
    }));
  } catch { return []; }
}

const WIKI = "https://en.wikipedia.org/w/api.php";

async function searchWeb(query: string, ctx: Ctx): Promise<RawResult[]> {
  if (ctx.tavilyKey) {
    const r = await searchTavily(query, ctx.tavilyKey);
    if (r.length) return r;
  }
  return searchWikipedia(query);
}

/** Search term: proper noun if present, else the first content word (usually the subject/topic). */
function searchPhrase(claim: string): string {
  const stop = new Set(("the a an is are was were be been being of in on to and or for with as at by from it its this that these those " +
    "during appears seems becomes become very much many often made goes going").split(" "));
  const raw = claim.replace(/[^a-zA-Z0-9 ]/g, "").split(" ").filter(Boolean);
  for (let i = 1; i < raw.length; i++) {
    const w = raw[i].toLowerCase();
    if (/^[A-Z]/.test(raw[i]) && w.length > 2 && !stop.has(w)) return w;
  }
  const words = raw.map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !stop.has(w) && !w.endsWith("ly"));
  return words.length ? words[0] : claim.slice(0, 30);
}

async function searchWikipedia(query: string): Promise<RawResult[]> {
  // query is a clean topic like "Honey" or "Honey myth" (from the LLM).
  const q = query.trim().slice(0, 60);
  if (!q) return [];
  try {
    const r = await fetch(`${WIKI}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`, { headers: UA });
    const j = await r.json() as any;
    const titles = ((j?.query?.search ?? []).map((h: any) => h.title) as string[]).slice(0, 4);
    if (!titles.length) return [];
    return wikiExtracts(titles);
  } catch { return []; }
}

/** Legacy multi-word keywords (kept for Tavily). */
function keywords(claim: string, max: number): string {
  const stop = new Set(("the a an is are was were be been being of in on to and or for with as at by from it its this that these those " +
    "during appears seems becomes become very much many often made goes going " +
    "notion idea concept fact claim statement thing").split(" "));
  const words = claim.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ")
    .filter((w) => w.length > 3 && !stop.has(w) && !w.endsWith("ly"));
  return words.slice(0, max).join(" ") || claim.slice(0, 60);
}

const UA = { "User-Agent": "VeriqBot/0.1 (claim verification)" };

async function wikiExtracts(titles: string[]): Promise<RawResult[]> {
  if (!titles.length) return [];
  // Fetch individually in parallel: batched extracts are flaky for long articles.
  const results = await Promise.all(
    titles.slice(0, 4).map(async (title) => {
      try {
        const j = await (await fetch(
          `${WIKI}?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`,
          { headers: UA }
        )).json() as any;
        const pages = Object.values(j?.query?.pages ?? {}) as any[];
        const p = pages[0];
        if (!p?.extract || p.extract.length < 200 || p.missing) return null;
        return {
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`,
          title: String(p.title).slice(0, 200),
          snippet: String(p.extract).replace(/\s+/g, " ").trim().slice(0, 12000),
        } as RawResult;
      } catch { return null; }
    })
  );
  return results.filter((r): r is RawResult => r !== null);
}

async function searchClaim(claim: Claim, ctx: Ctx): Promise<RawResult[]> {
  // Search for the topic; embeddings rerank. Keep it to 2 queries to stay in budget.
  const topicQuery = (claim.topic || searchPhrase(claim.text)).trim().slice(0, 60);
  const [pro, con] = await Promise.all([
    searchWeb(topicQuery, ctx),
    // Adversarial pass: hunt for refuting coverage.
    searchWeb(`${topicQuery} myth debunked`, ctx),
  ]);
  const seen = new Set<string>();
  return [...pro, ...con].filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
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
  // Use embeddings to score semantic relevance of each candidate to the claim.
  // This picks the right article even when keyword search returns mixed results.
  let scored = results.map((r) => {
    const { credibility } = scoreSource(r.url);
    return { ...r, fit: 0, credibility };
  });
  try {
    const texts = [claim.text, ...scored.map((r) => `${r.title} ${r.snippet.slice(0, 500)}`)];
    const vectors = await embed(texts, ctx);
    const claimVec = vectors[0];
    scored = scored.map((r, i) => ({
      ...r,
      fit: cosine(claimVec, vectors[i + 1]),
    }));
  } catch {
    // Fall back to credibility-only ordering if embeddings fail.
  }
  // Sort by fit (relevance) first, then credibility. Filter out very irrelevant results.
  return scored
    .filter((r) => r.fit === 0 || r.fit > 0.3)
    .sort((a, b) => (b.fit - a.fit) || (b.credibility - a.credibility))
    .slice(0, 4);
}

/* ---------- 5. entail: verbatim quotes → stance ----------
 * Quotes come from the search extracts (verbatim article text by construction),
 * so no page fetches are needed — this keeps us far under the subrequest cap.
 * HARD RULE: a quote is only used if it is an exact substring of its snippet.
 */

function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** Cheap pre-filter: token overlap between claim and sentence (no embedding). */
function overlap(claim: string, sentence: string): number {
  const stop = new Set("the a an is are was were be been of in on to and or for with as at by from it its this that these those".split(" "));
  const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 2 && !stop.has(w)));
  const c = toks(claim), s = toks(sentence);
  let hit = 0;
  for (const w of s) if (c.has(w)) hit++;
  return hit / Math.max(1, c.size);
}

function bestPassage(claim: string, snippet: string): { passage: string; score: number } {
  const sentences = snippet.split(/(?<=[.!?])\s+/).map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400);
  const scored = sentences.map((s, i) => ({ s, i, sc: overlap(claim, s) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);
  if (!scored.length) return { passage: "", score: 0 };
  // Take the top 3 most relevant sentences (not necessarily consecutive) for richer context.
  // This helps refutation: the judge sees multiple facts about the topic.
  const top = scored.slice(0, 3).sort((a, b) => a.i - b.i);
  const passage = top.map((x) => x.s).join(" ").slice(0, 800);
  return { passage, score: scored[0].sc };
}

async function judgeStance(claim: string, passage: string, ctx: Ctx): Promise<{ stance: Stance; quote: string; raw: string }> {
  try {
    const res = await ctx.ai.run("@cf/openai/gpt-oss-20b", {
      messages: [
        { role: "system", content: "You are a precise fact-checking judge. Reply with ONLY the verdict word on line 1, then the verbatim quote on line 2. No explanations, no reasoning, no preamble." },
        { role: "user", content: `Claim: ${claim}\n\nPassage: ${passage.slice(0, 1500)}\n\nDoes the passage support or refute the claim?\n- supports: the passage states or implies the claim is true.\n- refutes: the passage states or implies the claim is false (e.g. it gives the true composition/origin/date that contradicts the claim).\n- neutral: the passage doesn't address the claim either way.\nLine 1: one word (supports, refutes, or neutral). Line 2: copy one exact sentence from the passage that justifies your answer, or "none".` },
      ],
    }) as any;
    // Handle both {response} and OpenAI-style {choices[0].message.content} formats.
    // Note: we do NOT fall back to reasoning_content — it's chain-of-thought, not the answer.
    const ch = res.choices?.[0] as any;
    const msg = ch?.message as any;
    const text = String(res.response ?? msg?.content ?? ch?.text ?? "").trim();
    if (!text) return { stance: "neutral" as Stance, quote: "", raw: "empty-content" };
    // Parse stance: check start first, then scan the end (reasoning models conclude there).
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const findStance = (s: string): Stance | null => {
      const w = s.toLowerCase();
      if (/^supports?\b/.test(w)) return "supports";
      if (/^refutes?\b/.test(w)) return "refutes";
      if (/^neutral\b/.test(w)) return "neutral";
      return null;
    };
    let stance: Stance = findStance(lines[0] || "") ?? "neutral";
    if (stance === "neutral") {
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
        const s = findStance(lines[i]);
        if (s && s !== "neutral") { stance = s; break; }
      }
    }
    // Quote: prefer a line that appears verbatim in the passage.
    let quote = "";
    for (const line of lines.slice(1)) {
      const clean = line.replace(/^quote:\s*/i, "").trim();
      if (clean.length > 20 && passage.includes(clean)) { quote = clean.slice(0, 400); break; }
    }
    if (!quote) quote = lines.slice(1).join(" ").replace(/^quote:\s*/i, "").trim().slice(0, 400);
    return { stance, quote, raw: text.slice(0, 250) };
  } catch (e) { return { stance: "neutral", quote: "", raw: `ERR: ${String(e).slice(0, 150)}` }; }
}

export async function gatherEvidence(claim: Claim, candidates: Candidate[], ctx: Ctx): Promise<{ evidence: Evidence[] }> {
  const out: Evidence[] = [];
  // Judge the most relevant passage from each candidate (not just the intro).
  for (const c of candidates.slice(0, 3)) {
    const { passage, score } = bestPassage(claim.text, c.snippet);
    if (!passage || score === 0) continue;
    const { stance, quote } = await judgeStance(claim.text, passage, ctx);
    if (stance === "neutral" || !quote) continue;
    // HARD RULE: the quote must be a verbatim substring of its source text.
    if (!c.snippet.includes(quote)) continue;
    out.push({ quote, url: c.url, title: c.title, stance, credibility: c.credibility });
    if (out.length >= 3) break;
  }
  return { evidence: out };
}

/* ---------- 6. verdict: deterministic aggregation ---------- */

export function toVerdict(claim: Claim, evidence: Evidence[], sourcesChecked: number): Receipt {
  const forIt = evidence.filter((e) => e.stance === "supports");
  const against = evidence.filter((e) => e.stance === "refutes");
  const topTier = (list: Evidence[]) => list.some((e) => e.credibility >= 0.5);

  let verdict: Verdict = "unverifiable";
  if (forIt.length >= 1 && topTier(forIt) && !against.length) verdict = "supported";
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
  for (const claim of claims.slice(0, 4)) { // cap: protects the subrequest + neuron budgets
    const candidates = await shortlistAndRerank(claim, ctx);
    const { evidence } = await gatherEvidence(claim, candidates, ctx);
    const receipt = toVerdict(claim, evidence, candidates.length);
    receipts.push(receipt);
  }
  return receipts;
}
