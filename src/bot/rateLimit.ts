/**
 * Sliding-window rate limiter.
 *
 * A reaction menu is a cheap way for one member to hammer the role endpoints:
 * add, remove, add, remove. Discord will rate-limit the bot globally if that is
 * left unchecked, and the symptom is that every other member's reaction starts
 * failing too. This caps the actions of a single member without touching anyone
 * else's, and it is deliberately in-memory: a restart resetting the counters is
 * harmless, and persisting them would add a write on the hot path.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an action. Returns false when the caller is over the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Milliseconds until `key` may act again, or 0 when it may act now. */
  retryAfterMs(key: string): number {
    const recent = this.hits.get(key) ?? [];
    if (recent.length < this.limit) return 0;
    const oldest = Math.min(...recent);
    return Math.max(0, oldest + this.windowMs - this.now());
  }

  /** Drops entries whose window has fully expired, to bound memory. */
  prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const recent = times.filter((ts) => ts > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
