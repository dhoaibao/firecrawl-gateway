import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** Fixed window length; it matches the `interval '1 minute'` written to `rate_limits`. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
// Local counters are flushed to Postgres at most once per interval.
const FLUSH_INTERVAL_MS = 5_000;
// Buckets may be keyed by attacker-controlled values (client IPs), so the map is FIFO-bounded.
const MAX_BUCKETS = 10_000;

interface RateLimitBucket {
  /** Requests counted locally since the last successful flush. */
  pendingDelta: number;
  /** Authoritative count as of the last successful flush. */
  syncedCount: number;
  resetAt: number;
  lastFlushAt: number;
}

export interface RateLimitHit {
  /** Requests counted for this key in the current window, including this one. */
  count: number;
  /** Unix milliseconds at which the current window ends. */
  resetAt: number;
}

/**
 * Hybrid fixed-window counter: requests are counted in memory and flushed to the
 * Postgres `rate_limits` table at most once per interval, so a hit normally costs
 * no query.
 *
 * Accepted trade-off (user-approved): enforcement is approximate. A client can
 * exceed a limit by roughly what one instance absorbs within a flush interval,
 * multiplied by the number of active instances. This is deliberate, not a bug.
 */
export class RateLimitCounter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly flushInFlight = new Map<string, Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  /** Counts one request against `key`. Postgres flush failures never throw. */
  async hit(key: string): Promise<RateLimitHit> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      // Lazily drop buckets whose window has expired; a fresh one is
      // created below with zeroed counters.
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      // resetAt starts provisional until a flush returns the authoritative
      // value; lastFlushAt = 0 forces an initial sync on first sight.
      bucket = {
        pendingDelta: 0,
        syncedCount: 0,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
        lastFlushAt: 0,
      };
      this.recordBucket(key, bucket);
    }
    bucket.pendingDelta += 1;
    if (now - bucket.lastFlushAt >= FLUSH_INTERVAL_MS) await this.flushBucket(key, bucket);
    return { count: bucket.syncedCount + bucket.pendingDelta, resetAt: bucket.resetAt };
  }

  private flushBucket(key: string, bucket: RateLimitBucket): Promise<void> {
    const inFlight = this.flushInFlight.get(key);
    if (inFlight) return inFlight;
    const delta = bucket.pendingDelta;
    if (delta <= 0) {
      bucket.lastFlushAt = Date.now();
      return Promise.resolve();
    }
    // Capture and zero pendingDelta BEFORE awaiting so requests arriving
    // during the flush accumulate into a fresh pendingDelta and survive.
    bucket.pendingDelta = 0;
    bucket.lastFlushAt = Date.now();
    const request = this.prisma
      .$queryRaw<Array<{ count: number; reset_at: Date }>>(
        Prisma.sql`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${key}, ${delta}, NOW() + interval '1 minute')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= NOW() THEN ${delta} ELSE rate_limits.count + ${delta} END,
        reset_at = CASE WHEN rate_limits.reset_at <= NOW() THEN NOW() + interval '1 minute' ELSE rate_limits.reset_at END
      RETURNING count, reset_at
    `,
      )
      .then((rows) => {
        const entry = rows[0];
        if (entry) {
          bucket.syncedCount = Number(entry.count);
          bucket.resetAt = new Date(entry.reset_at).getTime();
        }
      })
      .catch(() => {
        // Restore the captured delta so no increments are lost; local
        // counting continues to enforce until the next flush attempt.
        bucket.pendingDelta += delta;
      })
      .finally(() => {
        if (this.flushInFlight.get(key) === request) this.flushInFlight.delete(key);
      });
    this.flushInFlight.set(key, request);
    return request;
  }

  private recordBucket(key: string, bucket: RateLimitBucket): void {
    if (this.buckets.has(key)) this.buckets.delete(key);
    else if (this.buckets.size >= MAX_BUCKETS) {
      // Evicting a bucket with an unflushed pendingDelta discards those
      // counts, which biases toward allowing traffic (accepted fail-open).
      const oldest = this.buckets.keys().next().value;
      if (oldest) this.buckets.delete(oldest);
    }
    this.buckets.set(key, bucket);
  }
}
