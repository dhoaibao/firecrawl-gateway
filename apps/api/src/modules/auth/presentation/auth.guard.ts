import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { SessionRequest } from "../domain/auth-session";
import { AuthService } from "../application/auth.service";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const userId = request.session?.userId;
    const sessionId = request.session?.sessionId;
    if (!userId || !sessionId) throw new UnauthorizedException("Unauthorized");
    const user = await this.auth.authorizeSession(sessionId, userId);
    if (!user) throw new UnauthorizedException("Unauthorized");
    const access = this.auth.checkAccess(user);
    if (!access.allowed) throw new ForbiddenException(access.reason);
    request.authUser = user;
    return true;
  }
}
