import type { BetterAuthOptions } from 'better-auth';

// Rate-limit counters for better-auth (`AUTH_RATE_LIMITS`), one store per app. better-auth's own
// memory store is a module-level map shared by every instance in the process; a store of our own
// keeps apps (and tests) apart. Fixed windows: the first request opens a window of `rule.window`
// seconds that admits `rule.max` requests. Keys are better-auth's (client IP + path).

export type RateLimitStorage = NonNullable<NonNullable<BetterAuthOptions['rateLimit']>['customStorage']>;

/** Above this many keys, expired windows are swept before a new key is added. */
const SWEEP_AT = 10_000;

export function createMemoryRateLimitStorage(now: () => number = Date.now): RateLimitStorage {
  const windows = new Map<string, { opened: number; count: number; window: number }>();
  return {
    consume(key, rule) {
      const t = now();
      const windowMs = rule.window * 1000;
      const current = windows.get(key);
      if (!current || t - current.opened >= windowMs) {
        if (!current && windows.size >= SWEEP_AT) {
          for (const [k, w] of windows) if (t - w.opened >= w.window * 1000) windows.delete(k);
        }
        windows.set(key, { opened: t, count: 1, window: rule.window });
        return Promise.resolve({ allowed: true, retryAfter: null });
      }
      if (current.count >= rule.max) {
        return Promise.resolve({ allowed: false, retryAfter: Math.max(1, Math.ceil((current.opened + windowMs - t) / 1000)) });
      }
      current.count += 1;
      return Promise.resolve({ allowed: true, retryAfter: null });
    },
  };
}
