import { Injectable, Inject, type NestMiddleware } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { API_CONFIG } from "./config.provider";
import type { ApiConfig } from "./config";
import { RateLimitCounter } from "./rate-limit-counter";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";

const MAX_REQUESTS = 300;

// Probes and the metrics scrape must not depend on Postgres (the limiter flushes
// there), so they keep answering while the database is slow. The metrics route
// still requires its bearer token.
const EXEMPT_PATHS = new Set(["/health", "/ready", "/admin/api/metrics"]);

function isExemptPath(url: string): boolean {
  return EXEMPT_PATHS.has(url.split("?", 1)[0]);
}

/**
 * Per-IP limiter in front of every route. Counting, flushing and the
 * accepted approximate-enforcement trade-off live in `RateLimitCounter`.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly counter: RateLimitCounter;

  constructor(
    prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly metrics: MetricsService,
  ) {
    this.counter = new RateLimitCounter(prisma);
  }

  async use(request: FastifyRequest, reply: FastifyReply, next: () => void): Promise<void> {
    if (isExemptPath(request.url)) return next();
    const ip = request.ip || request.raw.socket.remoteAddress || "unknown";
    try {
      const { count: effective, resetAt } = await this.counter.hit(ip);
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
}
