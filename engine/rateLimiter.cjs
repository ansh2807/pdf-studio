// Per-key token-bucket rate limiter. Dependency-free, in-memory (single
// process - fine for a single-container VPS deploy; would need a shared store
// behind a load balancer, not a concern at this scale).
//
// Built for the AI proxy routes (/api/native/ai, /api/native/ai-models):
// those routes relay to an outside AI provider using a key the CALLER
// supplies, so there's no server-side key to leak - but with no limiter,
// ANY visitor could use the public server as a free, anonymous relay at
// server-bandwidth cost, indefinitely. A per-IP bucket closes that off
// without breaking the one legitimate caller (Photo Studio's own AI-enhance
// button, used occasionally, well under the cap).
//
// `now` is injectable so this can be unit-tested with a fake clock instead of
// real setTimeout/Date.now() waits.

class RateLimiter {
  constructor({ capacity = 10, refillPerSec = 10 / 60, now = Date.now } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
  }

  /** Returns { allowed, retryAfterSec, remaining }. Consumes a token iff allowed. */
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    }
    const elapsedSec = Math.max(0, (t - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = t;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }
    const deficit = 1 - b.tokens;
    const retryAfterSec = Math.ceil(deficit / this.refillPerSec);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  /** Drop buckets untouched for longer than maxAgeSec, so the Map doesn't grow
   * unbounded on a long-running server with many distinct visitor IPs. */
  sweep(maxAgeSec = 3600) {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if ((t - b.last) / 1000 > maxAgeSec) this.buckets.delete(key);
    }
  }

  size() { return this.buckets.size; }
}

module.exports = { RateLimiter };
