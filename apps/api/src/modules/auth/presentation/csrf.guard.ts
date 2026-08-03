import crypto from "node:crypto";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { SessionRequest } from "../domain/auth-session";
import { AppConfigService } from "../../../core/config/config.service";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(config: AppConfigService) {
    this.allowedOrigins = new Set(config.corsOrigins);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    if (!MUTATING_METHODS.has(request.method) || !request.session?.userId) return true;

    const origin = request.headers.origin;
    const host = request.headers.host ?? "";
    const sameOrigin = `${request.protocol}://${host}`;
    if (!origin || (origin !== sameOrigin && !this.allowedOrigins.has(origin))) {
      throw new ForbiddenException("CSRF validation failed");
    }

    const supplied = request.headers["x-csrf-token"];
    const token = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!request.session.csrfToken || !token || !safeEqual(request.session.csrfToken, token)) {
      throw new ForbiddenException("CSRF validation failed");
    }
    return true;
  }
}
