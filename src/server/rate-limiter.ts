export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  count: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private opsSinceSweep = 0;

  consume(
    key: string,
    limit: number,
    windowMs: number,
    nowMs = Date.now()
  ): RateLimitResult {
    const cutoff = nowMs - windowMs;
    const existing = this.buckets.get(key);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];

    if (active.length >= limit) {
      this.buckets.set(key, active);
      const oldest = active[0] ?? nowMs;
      const retryAfterMs = Math.max(1000, oldest + windowMs - nowMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        count: active.length,
      };
    }

    active.push(nowMs);
    this.buckets.set(key, active);
    this.opsSinceSweep += 1;
    if (this.opsSinceSweep >= 250 || this.buckets.size > 5000) {
      this.sweepExpired(nowMs, windowMs);
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - active.length),
      retryAfterSeconds: 0,
      count: active.length,
    };
  }

  private sweepExpired(nowMs: number, windowMs: number): void {
    this.opsSinceSweep = 0;
    const cutoff = nowMs - windowMs;
    for (const [k, timestamps] of this.buckets.entries()) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        this.buckets.delete(k);
      } else {
        this.buckets.set(k, fresh);
      }
    }
  }
}
