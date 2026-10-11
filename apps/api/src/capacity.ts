import type { AIClient } from "./pipeline.ts";
import { HttpError, rateLimit, windowRetryAfter } from "./http.ts";

/** Shared application ceilings, not estimates of provider billing or free allocation. */
export const AI_CAPACITY = {
  callsPerDay: 50,
  inputBytesPerDay: 1_000_000,
  outputTokensPerDay: 100_000,
};
export const STORAGE_CAPACITY = {
  workspaces: 1000,
  documents: 1000,
  reviews: 1000,
  evidence: 1000,
  chat: 1000,
  feedback: 1000,
  audit: 5000,
  attachments: 5000,
};

export function budgetedAI(db: D1Database, ai: AIClient): AIClient {
  return {
    async run(model, input) {
      const encoded = JSON.stringify(input);
      const inputBytes = new TextEncoder().encode(encoded).byteLength;
      const outputTokens = input && typeof input === "object" && "max_tokens" in input ? input.max_tokens : undefined;
      if (!Number.isInteger(outputTokens) || Number(outputTokens) < 1 || Number(outputTokens) > 4096 || inputBytes > 120_000)
        throw new HttpError(400, "The complete request exceeds 120,000 UTF-8 input bytes or 4,096 requested output tokens. Shorten the draft, archive superseded policies, or use a separate workspace for a bounded policy domain; no text is silently dropped.", "AI_REQUEST_LIMIT");
      const day = new Date().toISOString().slice(0, 10);
      // One atomic reservation for ALL users/workspaces; failed or timed-out calls remain charged.
      const reserved = await db.prepare(`INSERT INTO ai_budget(day,calls,input_bytes,output_tokens)
        SELECT ?,1,?,? WHERE ?<=? AND ?<=?
        ON CONFLICT(day) DO UPDATE SET calls=calls+1,input_bytes=input_bytes+excluded.input_bytes,output_tokens=output_tokens+excluded.output_tokens
        WHERE calls<? AND input_bytes+excluded.input_bytes<=? AND output_tokens+excluded.output_tokens<=? RETURNING calls`)
        .bind(day, inputBytes, outputTokens, inputBytes, AI_CAPACITY.inputBytesPerDay, outputTokens, AI_CAPACITY.outputTokensPerDay,
          AI_CAPACITY.callsPerDay, AI_CAPACITY.inputBytesPerDay, AI_CAPACITY.outputTokensPerDay).first();
      if (!reserved)
        throw new HttpError(429, "Shared AI capacity is exhausted for today. Saved data remains available; no paid fallback will run.", "AI_CAPACITY_EXHAUSTED", windowRetryAfter(86400));
      return ai.run(model, input);
    },
  };
}
export async function mutationCapacity(db: D1Database, userId: string) {
  if (!(await rateLimit(db, `mutation:${userId}`, 120, 60)))
    throw new HttpError(429, "Too many changes. Wait a minute before retrying.", "MUTATION_RATE_LIMIT");
}

export async function aiCapacityStatus(db: D1Database) {
  const used = await db.prepare("SELECT calls,input_bytes,output_tokens FROM ai_budget WHERE day=?")
    .bind(new Date().toISOString().slice(0, 10)).first<{ calls: number; input_bytes: number; output_tokens: number }>();
  const counts = used ?? { calls: 0, input_bytes: 0, output_tokens: 0 };
  const now = new Date();
  return {
    limits: AI_CAPACITY,
    used: counts,
    remaining: {
      calls: Math.max(0, AI_CAPACITY.callsPerDay - counts.calls),
      inputBytes: Math.max(0, AI_CAPACITY.inputBytesPerDay - counts.input_bytes),
      outputTokens: Math.max(0, AI_CAPACITY.outputTokensPerDay - counts.output_tokens),
    },
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    providerUsageMeasured: false,
  };
}
