import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { RequestWithContext } from "../common/types";
import { UsersService } from "../users/users.service";

/** The portal session cookie. Distinct from the admin's `firecrawl.sid`, so neither guard accepts the other. */
export const USER_SESSION_COOKIE = "fg.portal";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function deny(reply: FastifyReply, status: number, error: string): false {
  void reply.code(status).send({ success: false, error });
  return false;
}

/**
 * Whether a state-changing request comes from the portal itself. A cookie-bearing
 * request from any other site, or from a sibling subdomain, is refused even though
 * the cookie would be sent.
 */
export function isTrustedOrigin(config: ApiConfig, request: RequestWithContext): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  return Boolean(config.portalOrigin) && request.headers.origin === config.portalOrigin;
}

/** Requires a valid portal user session and attaches `request.user`. */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    if (!isTrustedOrigin(this.config, request)) return deny(reply, 403, "Forbidden origin");
    const token = request.cookies?.[USER_SESSION_COOKIE];
    if (!token) return deny(reply, 401, "Unauthorized");
    const user = await this.users.validateSession(token);
    if (!user) return deny(reply, 401, "Unauthorized");
    request.user = user;
    return true;
  }
}
