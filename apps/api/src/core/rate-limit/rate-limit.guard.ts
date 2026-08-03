import { createHash } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { rootLogger } from "../../logger";
import { RateLimitService } from "./rate-limit.service";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;

type RateLimitRequest = FastifyRequest & {
  requestId?: string;
  session?: { userId?: string };
};

function pathFor(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] || "/";
}

function rateLimitBucket(path: string): string {
  if (path.startsWith("/api/v1/auth") || path.startsWith("/admin/api/auth")) return "auth";
  if (path.startsWith("/api/v1/admin") || path.startsWith("/admin/api")) return "operator";
  if (/^\/e\/[^/]+\/v[12]\//.test(path) || /^\/v[12]\//.test(path)) return "gateway";
  return "default";
}

function tokenFingerprint(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return authorization
    ? createHash("sha256").update(authorization).digest("hex").slice(0, 32)
    : undefined;
}

function rateLimitKeys(request: RateLimitRequest): string[] {
  const path = pathFor(request);
  const bucket = rateLimitBucket(path);
  const fingerprint = tokenFingerprint(request);
  const identities = [
    `ip:${request.ip || "unknown"}`,
    request.session?.userId ? `user:${request.session.userId}` : undefined,
    fingerprint ? `token:${fingerprint}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const operation = `${request.method}:${path}`.slice(0, 256);
  return [
    ...identities.map((identity) => `${bucket}:${identity}`),
    ...identities.map((identity) => `${bucket}:operation:${operation}:${identity}`),
  ];
}

function isExempt(path: string): boolean {
  return path === "/health" || path === "/ready" || path.startsWith("/api/v1/webhooks/");
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimits: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RateLimitRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    if (isExempt(pathFor(request))) return true;

    try {
      const decision = await this.rateLimits.consume(rateLimitKeys(request), RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
      reply.header("x-ratelimit-limit", String(RATE_LIMIT_MAX));
      reply.header("x-ratelimit-remaining", String(decision.remaining));
      reply.header("x-ratelimit-reset", String(Math.ceil(decision.resetAt.getTime() / 1_000)));
      if (!decision.allowed) {
        reply.header("retry-after", String(Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1_000))));
        throw new HttpException("Too many requests. Please try again later.", HttpStatus.TOO_MANY_REQUESTS);
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rootLogger.error({ err: error, request_id: request.requestId }, "Distributed rate limiter unavailable");
      throw new ServiceUnavailableException("Rate limiter unavailable");
    }
  }
}
