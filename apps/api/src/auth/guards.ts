import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { RequestWithContext } from "../common/types";
import { SessionService } from "./session.service";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function deny(reply: FastifyReply, status: number, error: string): false {
  void reply.code(status).send({ success: false, error });
  return false;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    if (!this.config.authEnabled)
      return deny(reply, 404, "Admin API is unavailable when AUTH_ENABLED=false.");
    // A browser sends Origin on every state-changing request. The admin cookie is
    // SameSite=Lax, so a sibling site (such as the portal) would otherwise be able to
    // trigger an admin action; only the admin's own origins may.
    const origin = request.headers.origin;
    if (origin && !SAFE_METHODS.has(request.method.toUpperCase())) {
      const allowed = [this.config.adminOrigin, this.config.apiOrigin].filter(Boolean);
      if (allowed.length && !allowed.includes(origin)) return deny(reply, 403, "Forbidden origin");
    }
    const admin = this.sessions.getAdmin(request);
    if (!admin) return deny(reply, 401, "Unauthorized");
    request.admin = admin;
    return true;
  }
}
