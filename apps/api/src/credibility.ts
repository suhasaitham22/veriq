/**
 * credibility.ts — deterministic source scoring. No LLM involved.
 * A source's credibility is computed from observable facts:
 * what kind of publisher it is, and how fresh the page is.
 */

export type SourceTier = 1 | 2 | 3 | 4;

const TIER_PATTERNS: Array<[SourceTier, RegExp[]]> = [
  [1, [/\.gov($|\/)/, /\.edu($|\/)/, /who\.int/, /nature\.com/, /science\.org/, /pubmed/, /arxiv\.org/]],
  [2, [/reuters\.com/, /apnews\.com/, /bbc\.(com|co\.uk)/, /nytimes\.com/, /theguardian\.com/, /wikipedia\.org/]],
  [3, [/medium\.com/, /substack\.com/, /.*blog.*/]],
];

function tierOf(hostname: string): SourceTier {
  for (const [tier, patterns] of TIER_PATTERNS) {
    if (patterns.some((p) => p.test(hostname))) return tier;
  }
  return 4;
}

const TIER_WEIGHT: Record<SourceTier, number> = { 1: 1.0, 2: 0.7, 3: 0.4, 4: 0.2 };

/** Recency decays linearly: fresh = 1.0, 5+ years old = 0.5. */
function recencyScore(publishedAt?: string): number {
  if (!publishedAt) return 0.8;
  const ageYears = (Date.now() - new Date(publishedAt).getTime()) / 3.154e10;
  return Math.max(0.5, 1 - ageYears / 10);
}

export interface ScoredSource {
  url: string;
  tier: SourceTier;
  credibility: number; // 0..1
}

export function scoreSource(url: string, publishedAt?: string): ScoredSource {
  const tier = tierOf(new URL(url).hostname);
  const credibility = +(TIER_WEIGHT[tier] * recencyScore(publishedAt)).toFixed(3);
  return { url, tier, credibility };
}
