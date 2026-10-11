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
  /** The pinned window end this bucket was created with, reused by scheduled flushes. */
  fixedResetAt?: Date;
}

export interface RateLimitCounterOptions {
  /**
   * Also flush a bucket that has pending increments after the flush interval even
   * if no further request arrives, so idle usage is persisted promptly. Off for the
   * per-IP limiter, whose bucket count is attacker-controlled; meant for the few
   * long-lived counters (per-key limits and quotas).
   */
  scheduleFlush?: boolean;
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
 * multiplied by the number of active instances. The same holds in the other
 * direction: a flush whose acknowledgement is lost after PostgreSQL committed it
 * is replayed, so it can be counted twice (over-counting by at most one flush
 * interval's requests). The flush is not idempotent because making it so would
 * need per-instance state in the database. This is deliberate, not a bug.
 */
export class RateLimitCounter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly flushInFlight = new Map<string, Promise<void>>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: RateLimitCounterOptions = {},
  ) {}

  /**
   * Counts one request against `key`. Postgres flush failures never throw. The
   * window is one minute from first sight unless `fixedResetAt` pins its end
   * (used for calendar-month quotas, where the key itself carries the period).
   */
  async hit(key: string, fixedResetAt?: Date): Promise<RateLimitHit> {
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
        resetAt: fixedResetAt?.getTime() ?? now + RATE_LIMIT_WINDOW_MS,
        lastFlushAt: 0,
        fixedResetAt,
      };
      this.recordBucket(key, bucket);
    }
    bucket.pendingDelta += 1;
    if (now - bucket.lastFlushAt >= FLUSH_INTERVAL_MS)
      await this.flushBucket(key, bucket, fixedResetAt);
    if (this.options.scheduleFlush && bucket.pendingDelta > 0) this.scheduleFlush(key, bucket);
    return { count: bucket.syncedCount + bucket.pendingDelta, resetAt: bucket.resetAt };
  }

  /**
   * Persists every pending increment now and stops scheduled flushes. Called at
   * shutdown (before the database disconnects) so accepted requests are not lost.
   */
  async drain(): Promise<void> {
    this.draining = true;
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    // Each pass first lets writes already in flight settle (a failed one restores
    // its delta), then flushes whatever is still pending.
    for (let pass = 0; pass < 3; pass += 1) {
      await Promise.allSettled([...this.flushInFlight.values()]);
      const pending = [...this.buckets].filter(([, bucket]) => bucket.pendingDelta > 0);
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map(([key, bucket]) => this.flushIfCurrent(key, bucket)));
    }
  }

  /**
   * Flushes a bucket outside `hit()` (timer or drain). Increments that belong to a
   * window which has already ended are dropped instead: writing them now would
   * seed the next window with the previous one's requests. (`hit()` already drops
   * an expired bucket lazily; these paths have to do the same check.)
   */
  private flushIfCurrent(key: string, bucket: RateLimitBucket): Promise<void> {
    if (bucket.resetAt <= Date.now()) {
      bucket.pendingDelta = 0;
      return Promise.resolve();
    }
    return this.flushBucket(key, bucket, bucket.fixedResetAt);
  }

  private scheduleFlush(key: string, bucket: RateLimitBucket): void {
    if (this.draining || this.flushTimers.has(key)) return;
    const delay = Math.max(1_000, bucket.lastFlushAt + FLUSH_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      // A replaced or already-flushed bucket needs nothing.
      if (this.buckets.get(key) !== bucket || bucket.pendingDelta <= 0) return;
      void this.flushIfCurrent(key, bucket).finally(() => {
        // A failed flush restores its delta; retry on the next interval instead of
        // waiting for another request, until the window itself has ended.
        if (
          bucket.pendingDelta > 0 &&
          bucket.resetAt > Date.now() &&
          this.buckets.get(key) === bucket
        )
          this.scheduleFlush(key, bucket);
      });
    }, delay);
    // A pending flush must never keep the process alive; drain() covers shutdown.
    timer.unref?.();
    this.flushTimers.set(key, timer);
  }

  private flushBucket(key: string, bucket: RateLimitBucket, fixedResetAt?: Date): Promise<void> {
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
      VALUES (${key}, ${delta}, COALESCE(${fixedResetAt ?? null}::timestamptz, NOW() + interval '1 minute'))
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= NOW() THEN ${delta} ELSE rate_limits.count + ${delta} END,
        reset_at = CASE WHEN rate_limits.reset_at <= NOW() THEN COALESCE(${fixedResetAt ?? null}::timestamptz, NOW() + interval '1 minute') ELSE rate_limits.reset_at END
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
