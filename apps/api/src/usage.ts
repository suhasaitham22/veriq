import type { Scope } from "./workspaces.ts";
import { windowRetryAfter } from "./http.ts";

export const DAILY_LIMITS = { reviews: 50, chat: 50 } as const;

/** Account-wide app attempts, not shared Cloudflare neuron usage or a spending estimate. */
export async function usageStatus(scope: Scope) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (
    await scope.db
      .prepare(
        "SELECT 'reviews' AS kind,count FROM usage WHERE ip=? AND day=? UNION ALL SELECT 'chat' AS kind,count FROM request_limits WHERE key=? AND window=?",
      )
      .bind(
        `support:${scope.user.id}`,
        day,
        `chat:${scope.user.id}`,
        Math.floor(now / 86400000),
      )
      .all<{ kind: "reviews" | "chat"; count: number }>()
  ).results;
  const counts = new Map(rows.map((r) => [r.kind, r.count]));
  const allowance = (kind: keyof typeof DAILY_LIMITS) => {
    const used = counts.get(kind) ?? 0,
      limit = DAILY_LIMITS[kind];
    return { used, limit, remaining: Math.max(0, limit - used) };
  };
  return {
    day,
    resetAt: new Date(
      (Math.floor(now / 86400000) + 1) * 86400000,
    ).toISOString(),
    retryAfter: windowRetryAfter(86400, now),
    reviews: allowance("reviews"),
    chat: allowance("chat"),
  };
}
