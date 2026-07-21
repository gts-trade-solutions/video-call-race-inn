/**
 * Small in-process fixed-window rate limiter for abuse-prone endpoints
 * (login, register, password reset).
 *
 * The app is pinned to a single PM2 instance (typing/presence state is already
 * in-process), so a per-process limiter is sufficient. If you ever scale to
 * multiple instances, back this with Redis so the counters are shared.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function prune(now: number) {
  // Map.forEach avoids needing downlevelIteration for the current TS target.
  // Deleting during forEach is safe for Map.
  buckets.forEach((b, k) => {
    if (now >= b.resetAt) buckets.delete(k);
  });
}

/**
 * Returns { ok: false } once `limit` hits happen inside `windowMs`.
 * Each call counts as one hit.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  // Cheap opportunistic cleanup so the map can't grow without bound.
  if (buckets.size > 5000) prune(now);

  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client IP, honouring the reverse proxy. */
export function clientIp(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") || "unknown";
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
