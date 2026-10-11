import { Injectable, Inject, type NestMiddleware } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { API_CONFIG } from "./config.provider";
import type { ApiConfig } from "./config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
// Local counters are flushed to Postgres at most once per interval.
const FLUSH_INTERVAL_MS = 5_000;
// Buckets are keyed by the attacker-controlled client IP, so the map is FIFO-bounded.
const MAX_BUCKETS = 10_000;

// Probes and the metrics scrape must not depend on Postgres (the limiter flushes
// there), so they keep answering while the database is slow. The metrics route
// still requires its bearer token.
const EXEMPT_PATHS = new Set(["/health", "/ready", "/admin/api/metrics"]);

function isExemptPath(url: string): boolean {
  return EXEMPT_PATHS.has(url.split("?", 1)[0]);
}

interface RateLimitBucket {
  /** Requests counted locally since the last successful flush. */
  pendingDelta: number;
  /** Authoritative count as of the last successful flush. */
  syncedCount: number;
  resetAt: number;
  lastFlushAt: number;
}

// Accepted trade-off (user-approved): enforcement is approximate. A client
// can exceed MAX_REQUESTS by roughly what one instance absorbs within a
// flush interval, multiplied by the number of active instances. This is
// deliberate, not a bug.
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly flushInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly metrics: MetricsService,
  ) {}

  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    if (isExemptPath(request.url)) return next();
    const ip = request.ip || request.raw.socket.remoteAddress || "unknown";
    try {
      const now = Date.now();
      let bucket = this.buckets.get(ip);
      if (bucket && bucket.resetAt <= now) {
        // Lazily drop buckets whose window has expired; a fresh one is
        // created below with zeroed counters.
        this.buckets.delete(ip);
        bucket = undefined;
      }
      if (!bucket) {
        // resetAt starts provisional until a flush returns the authoritative
        // value; lastFlushAt = 0 forces an initial sync on first sight.
        bucket = { pendingDelta: 0, syncedCount: 0, resetAt: now + WINDOW_MS, lastFlushAt: 0 };
        this.recordBucket(ip, bucket);
      }
      bucket.pendingDelta += 1;
      let effective = bucket.syncedCount + bucket.pendingDelta;
      let resetAt = bucket.resetAt;
      if (now - bucket.lastFlushAt >= FLUSH_INTERVAL_MS) {
        await this.flushBucket(ip, bucket);
        effective = bucket.syncedCount + bucket.pendingDelta;
        resetAt = bucket.resetAt;
      }
      reply.header("X-RateLimit-Limit", String(MAX_REQUESTS));
      reply.header("X-RateLimit-Remaining", String(Math.max(0, MAX_REQUESTS - effective)));
      reply.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
      if (effective > MAX_REQUESTS) {
        this.metrics.recordRateLimited();
        void reply
          .code(429)
          .send({ success: false, error: "Too many requests. Please try again later." });
        return;
      }
    } catch {
      // A rate limiter failure must never throw, never 500, and never break
      // the request. Behavior change from the previous implementation: a
      // Postgres outage no longer disables rate limiting entirely — local
      // counting keeps enforcing approximately while flushes fail.
    }
    next();
  }

  private flushBucket(ip: string, bucket: RateLimitBucket): Promise<void> {
    const inFlight = this.flushInFlight.get(ip);
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
      VALUES (${ip}, ${delta}, NOW() + interval '1 minute')
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
        if (this.flushInFlight.get(ip) === request) this.flushInFlight.delete(ip);
      });
    this.flushInFlight.set(ip, request);
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
