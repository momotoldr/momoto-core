/**
 * Minimal in-memory fixed-window rate limiter (Phase 5 hardening).
 *
 * Keyed by an arbitrary string (socket id for socket events, client IP for HTTP).
 * Single-instance only; the Redis scale path (Phase 5, optional) would move this to
 * a shared store. `sweep()` reclaims expired windows so the map can't grow unbounded.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt for `key`; returns true if it's within the window's budget. */
  allow(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count += 1
    return true
  }

  /**
   * Would `allow(key)` succeed right now — without spending a hit? For counters that
   * should only tick on *failure* (e.g. bad logins), gate with `peek`, then call
   * `allow` on the failure path and `reset` on success.
   */
  peek(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) return true
    return entry.count < this.limit
  }

  /** Forget a key (e.g. on socket disconnect) so it doesn't linger until sweep. */
  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Drop windows that have elapsed. Returns how many entries were reclaimed. */
  sweep(now: number = Date.now()): number {
    let removed = 0
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) {
        this.hits.delete(key)
        removed += 1
      }
    }
    return removed
  }
}
