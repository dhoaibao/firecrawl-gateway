import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import { getRequestLogger } from "./logger";
import type { RateLimitDecision } from "./rate-limit-store";

interface LocalRateLimitEntry {
  count: number;
  resetTime: number;
}

export interface RateLimitStore {
  consume(keys: string[], limit: number, windowMs: number): Promise<RateLimitDecision>;
}

const localRateLimitEntries = new Map<string, LocalRateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdFromHeader(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function rateLimitBucket(req: Request): string {
  if (req.path.startsWith("/api/v1/auth") || req.path.startsWith("/admin/api/auth")) return "auth";
  if (req.path.startsWith("/api/v1/admin") || req.path.startsWith("/admin/api")) return "operator";
  if (/^\/e\/[^/]+\/v[12]\//.test(req.path) || /^\/v[12]\//.test(req.path)) return "gateway";
  return "default";
}

function clientIp(req: Request, trustProxy: boolean | string): string {
  return (trustProxy
    ? (req.ip || req.socket.remoteAddress || "unknown")
    : (req.socket.remoteAddress || req.ip || "unknown")
  ).toString();
}

function tokenFingerprint(req: Request): string | undefined {
  const authorization = req.headers.authorization;
  if (!authorization) return undefined;
  return createHash("sha256").update(authorization).digest("hex").slice(0, 32);
}

/**
 * Build independent limits for the caller, account/token, and operation. All
 * values are bounded identifiers; raw bearer credentials never enter storage.
 */
function rateLimitKeys(req: Request, trustProxy: boolean | string): string[] {
  const bucket = rateLimitBucket(req);
  const identities = [
    `ip:${clientIp(req, trustProxy)}`,
    req.user?.account_id ? `account:${req.user.account_id}` : undefined,
    req.user?.id ? `user:${req.user.id}` : undefined,
    tokenFingerprint(req) ? `token:${tokenFingerprint(req)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const operation = `${req.method}:${req.path}`.slice(0, 256);
  return [...identities.map((identity) => `${bucket}:${identity}`), ...identities.map((identity) => `${bucket}:operation:${operation}:${identity}`)];
}

function consumeLocal(keys: string[], limit: number, windowMs: number): RateLimitDecision {
  const now = Date.now();
  let highestCount = 0;
  let resetAt = now + windowMs;

  for (const key of keys) {
    const existing = localRateLimitEntries.get(key);
    if (existing && now > existing.resetTime) localRateLimitEntries.delete(key);
    const current = localRateLimitEntries.get(key);
    const count = current ? current.count + 1 : 1;
    const nextReset = current ? current.resetTime : now + windowMs;
    localRateLimitEntries.set(key, { count, resetTime: nextReset });
    if (count > highestCount) {
      highestCount = count;
      resetAt = nextReset;
    }
  }

  return {
    allowed: highestCount <= limit,
    remaining: Math.max(0, limit - highestCount),
    resetAt: new Date(resetAt),
  };
}

export const localRateLimitStore: RateLimitStore = { consume: async (keys, limit, windowMs) => consumeLocal(keys, limit, windowMs) };

/** Periodic cleanup to prevent unbounded memory growth in test/local fallback mode. */
function cleanupStaleRateLimitEntries(): void {
  const now = Date.now();
  for (const [key, entry] of localRateLimitEntries) {
    if (now > entry.resetTime) localRateLimitEntries.delete(key);
  }
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = requestIdFromHeader(req.headers["x-request-id"]) || randomUUID();
  req.requestId = requestId;
  res.setHeader?.("X-Request-ID", requestId);
  // X-Request-ID is a client correlation value, not a quota idempotency key:
  // every HTTP request receives a fresh server-owned quota identity so a
  // replayed header cannot dispatch for free.
  req.quotaRequestId = randomUUID();
  next();
}

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const log = getRequestLogger(req);
    const meta = {
      method: req.method,
      // Query strings can contain tokens, signed URLs, and provider credentials.
      // Keep only the gateway path in operational logs.
      path: req.path,
      status,
      duration_ms: duration,
    };

    if (status >= 500) {
      log.error(meta, "request error");
    } else if (status >= 400) {
      log.warn(meta, "request warning");
    } else {
      log.info(meta, "request completed");
    }
  });

  next();
}

export function rateLimiter(
  trustProxy: boolean | string = false,
  store: RateLimitStore,
) {
  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (Math.random() < 0.01) cleanupStaleRateLimitEntries();
    const keys = rateLimitKeys(req, trustProxy);

    void store.consume(keys, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS).then((decision) => {
      const reset = Math.ceil(decision.resetAt.getTime() / 1000);
      res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
      res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
      res.setHeader("X-RateLimit-Reset", String(reset));
      if (!decision.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({
          success: false,
          error: "Too many requests. Please try again later.",
        });
        return;
      }
      next();
    }).catch((error) => {
      // A database-backed limiter must fail closed. Readiness will keep the
      // instance out of service until the shared limiter is available again.
      getRequestLogger(req).error({ err: error }, "Distributed rate limiter unavailable");
      res.status(503).json({ success: false, error: "Rate limiter unavailable" });
    });
  };
}
