/**
 * Fixed-window rate limiter. Uses Upstash Redis (REST) when UPSTASH_REDIS_REST_URL/TOKEN are set,
 * otherwise a process-local map (fine for dev / single instance; NOT sufficient on serverless
 * production, where multiple instances do not share memory: configure Upstash).
 */
export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface Limit {
  name: string;
  max: number;
  windowSec: number;
}

export const LIMITS = {
  search: { name: "search", max: 20, windowSec: 60 },
  chat: { name: "chat", max: 15, windowSec: 60 },
  quote: { name: "quote", max: 10, windowSec: 60 },
  booking: { name: "booking", max: 5, windowSec: 60 },
  payment: { name: "payment", max: 40, windowSec: 60 },
  places: { name: "places", max: 90, windowSec: 60 },
  cancel: { name: "cancel", max: 5, windowSec: 60 },
  account: { name: "account", max: 5, windowSec: 600 },
  webhook: { name: "webhook", max: 120, windowSec: 60 },
  // Daily denial-of-wallet cap on LLM-backed chat per identity.
  llmDaily: { name: "llm-daily", max: 200, windowSec: 86_400 },
} satisfies Record<string, Limit>;

const mem = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimits() {
  mem.clear();
}

async function upstashIncr(key: string, windowSec: number): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, windowSec, "NX"]]),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { result: number }[];
    return out[0]?.result ?? null;
  } catch {
    return null; // fall back to local limiter rather than failing open entirely
  }
}

export async function rateLimit(limit: Limit, identity: string, now = Date.now()): Promise<LimitResult> {
  const windowMs = limit.windowSec * 1000;
  const bucket = Math.floor(now / windowMs);
  const key = `rl:${limit.name}:${identity}:${bucket}`;
  const retryAfterSec = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));

  const remote = await upstashIncr(key, limit.windowSec);
  let count: number;
  if (remote !== null) {
    count = remote;
  } else {
    for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
    const cur = mem.get(key) ?? { count: 0, resetAt: (bucket + 1) * windowMs };
    cur.count += 1;
    mem.set(key, cur);
    count = cur.count;
  }
  return { allowed: count <= limit.max, remaining: Math.max(0, limit.max - count), retryAfterSec };
}

/** Best-effort client IP. On Vercel, x-forwarded-for is set by the platform edge. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  return ip.slice(0, 64);
}
