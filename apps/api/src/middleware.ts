import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { getRequestLogger } from "./logger";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;

/** Periodic cleanup to prevent unbounded memory growth from stale IPs */
function cleanupStaleRateLimitEntries(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}

export function requestIdMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) || randomUUID();
  req.requestId = requestId;
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
      url: req.originalUrl || req.url,
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

export function rateLimiter(trustProxy: boolean | string = false) {
  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Use Express's computed client IP only when a trusted reverse proxy is configured;
    // otherwise fall back to the direct socket address to prevent X-Forwarded-For spoofing.
    const ip = trustProxy
      ? (req.ip || req.socket.remoteAddress || "unknown").toString()
      : (req.socket.remoteAddress || req.ip || "unknown").toString();
    const now = Date.now();

    // Run periodic cleanup (~1% chance per request) to prevent unbounded growth
    if (Math.random() < 0.01) {
      cleanupStaleRateLimitEntries();
    }

    const entry = rateLimitStore.get(ip);

    if (entry && now > entry.resetTime) {
      rateLimitStore.delete(ip);
    }

    const current = rateLimitStore.get(ip);
    const count = current ? current.count + 1 : 1;
    const resetTime = current ? current.resetTime : now + RATE_LIMIT_WINDOW_MS;

    if (count > RATE_LIMIT_MAX) {
      res.status(429).json({
        success: false,
        error: "Too many requests. Please try again later.",
      });
      return;
    }

    rateLimitStore.set(ip, { count, resetTime });
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, RATE_LIMIT_MAX - count)),
    );
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetTime / 1000)));
    next();
  };
}
