/**
 * Rate limiting (E6 "claim-token enumeration").
 *
 * The defence there is three parts: ">= 128 bits of entropy, per-terminal rate
 * limits, anomaly alerting on failed-claim volume". The entropy is in
 * `core/ids.ts`; this is the second part, and `failedClaimVolume` in the claims
 * repository is the third.
 *
 * A token bucket rather than a fixed window, because a cashier printing a burst
 * of bills at a lunch rush is legitimate and a fixed window would reject them.
 */

export interface BucketConfig {
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

interface Bucket { tokens: number; lastRefill: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: BucketConfig) {}

  /** Returns true when the request is allowed. */
  take(key: string, now = Date.now(), cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  retryAfterSeconds(key: string, cost = 1): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const deficit = Math.max(0, cost - bucket.tokens);
    return Math.ceil(deficit / this.config.refillPerSecond);
  }

  /** Prevents unbounded growth on a long-running process. */
  prune(olderThanMs = 3_600_000, now = Date.now()): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > olderThanMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Claim resolution is generous — a genuine customer may reload, and the page is
 * the product's first impression — but not unbounded.
 */
export const claimLimiter = new RateLimiter({ capacity: 30, refillPerSecond: 0.5 });

/** Per-terminal ingestion. A busy till prints a few bills a minute, not a few hundred. */
export const ingestLimiter = new RateLimiter({ capacity: 120, refillPerSecond: 2 });

/** Anything that mints an account or sends an OTP. */
export const accountLimiter = new RateLimiter({ capacity: 5, refillPerSecond: 0.05 });
