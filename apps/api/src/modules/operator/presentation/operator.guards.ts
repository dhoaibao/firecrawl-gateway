import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { SessionRequest } from "../../auth/domain/auth-session";
import { AuthService } from "../../auth/application/auth.service";
import { TransactionService } from "../../../core/database/transaction.service";

type OperatorRequest = SessionRequest & { authUser?: { id: string; is_admin: boolean; platform_role?: string } };

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const user = request.authUser;
    if (!user) throw new UnauthorizedException("Unauthorized");
    if (!user.is_admin && user.platform_role !== "admin") throw new ForbiddenException("Forbidden");
    return true;
  }
}

@Injectable()
export class OperatorMfaGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly transactions: TransactionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const user = request.authUser;
    const sessionId = request.session?.sessionId;
    if (!user || !sessionId) throw new UnauthorizedException("Unauthorized");
    if (!user.is_admin && user.platform_role !== "admin") throw new ForbiddenException("Forbidden");

    const state = await this.auth.getMfaState(user.id);
    if (!state.enabled || !state.verified) throw new ForbiddenException("Operator MFA is required");

    const session = await this.transactions.runAsOperator((transaction) => transaction.authSession.findFirst({
      where: {
        userId: user.id,
        sessionIdHash: hashSessionId(sessionId),
        revokedAt: null,
        mfaVerifiedAt: { not: null },
      },
      select: { id: true },
    }));
    if (!session) throw new ForbiddenException("Operator MFA is required");
    return true;
  }
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

@Injectable()
export class OperatorStepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    // `/admin/api/*` remains a compatibility surface while callers migrate to
    // the native `/api/v1/admin/*` operator boundary.
    if (request.url.startsWith("/admin/api/")) return true;
    const stepUpAt = request.session?.operatorStepUpAt;
    if (!stepUpAt || Date.now() - stepUpAt > 10 * 60 * 1000) {
      throw new ForbiddenException({ message: "Recent password and MFA step-up is required", code: "step_up_required" });
    }
    const reason = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? (request.body as Record<string, unknown>).reason : undefined;
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) throw new BadRequestException({ message: "A non-empty mutation reason is required", code: "reason_required" });
    return true;
  }
}

@Injectable()
export class OperatorReasonGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const reason = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? (request.body as Record<string, unknown>).reason : undefined;
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) throw new BadRequestException({ message: "A non-empty mutation reason is required", code: "reason_required" });
    return true;
  }
}

export type OperatorTransaction = Prisma.TransactionClient;
