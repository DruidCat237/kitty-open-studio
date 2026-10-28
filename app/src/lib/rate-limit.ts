/**
 * In-memory rate limiter for API routes.
 * Uses a sliding window counter per IP/key.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });
 *   // In route handler:
 *   const blocked = limiter.check(ip);
 *   if (blocked) return new Response("Too Many Requests", { status: 429 });
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Max requests per window */
  maxRequests: number;
}

export function createRateLimiter(opts: RateLimiterOptions) {
  const store = new Map<string, RateLimitEntry>();

  // Periodic cleanup to prevent memory leaks (every 60s)
  let lastCleanup = Date.now();
  const CLEANUP_INTERVAL = 60_000;

  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }

  return {
    /**
     * Check if a request should be rate limited.
     * Returns null if allowed, or a Response if blocked.
     */
    check(key: string): Response | null {
      cleanup();
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || now > entry.resetAt) {
        store.set(key, { count: 1, resetAt: now + opts.windowMs });
        return null;
      }

      entry.count++;
      if (entry.count > opts.maxRequests) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return new Response("Too Many Requests", {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(opts.maxRequests),
            "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)),
          },
        });
      }

      return null;
    },
  };
}

/** Extract client identifier from request (IP or fallback) */
export function getClientKey(req: Request): string {
  const headers = req.headers;
  // In Electron (localhost), all requests come from 127.0.0.1
  // Use X-Kitty-Token hash as key if available (rate limit per user)
  const token = headers.get("X-Kitty-Token");
  if (token) {
    // Simple hash to avoid storing full tokens in memory
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    return `tok:${hash}`;
  }
  // Fallback to forwarded IP or generic key
  return headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "anonymous";
}
