import crypto from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { authenticatedUserSchema } from "@firecrawl/contracts";
import { z } from "zod";
import type { User } from "../../../types";
import { serializeUser } from "../../../users/serialization";
import { AppConfigService } from "../../../core/config/config.service";
import { requestMetadata } from "../../../common/http/request-context";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AuthAttemptService } from "../application/auth-attempt.service";
import { AuthService } from "../application/auth.service";
import { AuthEnabledGuard } from "./auth-enabled.guard";
import { AuthGuard } from "./auth.guard";
import {
  changeEmailSchema,
  changePasswordSchema,
  emailSchema,
  loginMfaSchema,
  loginSchema,
  mfaCodeSchema,
  reauthenticateSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
} from "./auth.schemas";
import type {
  AuthenticatedRequest,
  CookieReply as FastifyReply,
  SessionRequest as FastifyRequest,
} from "../domain/auth-session";

const GENERIC_AUTH_MESSAGE = "If the account can be processed, you will receive an email shortly.";
const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;

type AuthRequest = FastifyRequest & AuthenticatedRequest;

function metadata(request: FastifyRequest): { ip: string; userAgent?: string } {
  const context = requestMetadata(request);
  return { ip: context.clientIp, userAgent: context.userAgent };
}

@Controller(["api/v1/auth", "admin/api/auth"])
@UseGuards(AuthEnabledGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly attempts: AuthAttemptService,
    private readonly config: AppConfigService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: FastifyRequest,
  ) {
    if (!(await this.attempts.allow("login", `${request.ip}:${body.email.toLowerCase()}`))) {
      throw new HttpException("Too many authentication attempts", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.auth.authenticate(body.email, body.password);
    if (!user) throw new UnauthorizedException("Invalid email or password");
    await request.session.regenerate();
    const mfa = await this.auth.getMfaState(user.id);
    if (mfa.enabled) {
      request.session.pendingMfaUserId = user.id;
      request.session.pendingMfaAt = Date.now();
      await request.session.save();
      return { success: true, mfa_required: true };
    }
    await this.establishSession(request, user);
    return { success: true, data: authenticatedUserSchema.parse(serializeUser(user)) };
  }

  @Post("login/mfa")
  @HttpCode(HttpStatus.OK)
  async loginMfa(
    @Body(new ZodValidationPipe(loginMfaSchema)) body: z.infer<typeof loginMfaSchema>,
    @Req() request: FastifyRequest,
  ) {
    const userId = request.session.pendingMfaUserId;
    const pendingAt = request.session.pendingMfaAt;
    if (!userId || !pendingAt || Date.now() - pendingAt > MFA_CHALLENGE_TTL_MS) {
      throw new UnauthorizedException("Invalid or expired MFA challenge");
    }
    if (!(await this.attempts.allow("mfa", `${request.ip}:${userId}`))) {
      throw new HttpException("Too many authentication attempts", HttpStatus.TOO_MANY_REQUESTS);
    }
    const valid = body.recovery_code
      ? await this.auth.consumeRecoveryCode(userId, body.recovery_code)
      : await this.auth.verifyMfaCode(userId, body.code ?? "");
    if (!valid) throw new UnauthorizedException("Invalid authentication code");
    const user = await this.auth.getUserById(userId);
    if (!user) throw new UnauthorizedException("Invalid authentication code");
    await request.session.regenerate();
    await this.establishSession(request, user, true);
    return { success: true, data: authenticatedUserSchema.parse(serializeUser(user)) };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (request.session.sessionId) await this.auth.revokeSession(request.session.sessionId);
    await request.session.destroy();
    reply.clearCookie(this.config.sessionCookieName, { path: "/" });
    return { success: true };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() request: AuthRequest) {
    return { data: authenticatedUserSchema.parse(serializeUser(request.authUser)) };
  }

  @Get("csrf")
  async csrf(@Req() request: FastifyRequest) {
    request.session.csrfToken ??= crypto.randomBytes(32).toString("base64url");
    await request.session.save();
    return { data: { token: request.session.csrfToken } };
  }

  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Req() request: FastifyRequest,
  ) {
    if (!this.config.registrationEnabled) return { success: true, message: GENERIC_AUTH_MESSAGE };
    const passwordError = this.auth.passwordError(body.password);
    if (passwordError) throw new BadRequestException(passwordError);
    if (!(await this.attempts.allow("register", `${request.ip}:${body.email.toLowerCase()}`))) {
      throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.auth.register({ ...body, ...metadata(request) });
    return { success: true, message: GENERIC_AUTH_MESSAGE };
  }

  @Post("verification/request")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestVerification(
    @Body(new ZodValidationPipe(emailSchema)) body: z.infer<typeof emailSchema>,
    @Req() request: FastifyRequest,
  ) {
    if (await this.attempts.allow("verification", `${request.ip}:${body.email.toLowerCase()}`)) {
      await this.auth.requestEmailVerification(body.email);
    }
    return { success: true, message: GENERIC_AUTH_MESSAGE };
  }

  @Post("verification/consume")
  @HttpCode(HttpStatus.OK)
  async consumeVerification(@Body(new ZodValidationPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    const success = await this.auth.consumeEmailVerification(body.token);
    if (!success) throw new BadRequestException("Invalid or expired verification token");
    return { success: true };
  }

  @Post("password/forgot")
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(
    @Body(new ZodValidationPipe(emailSchema)) body: z.infer<typeof emailSchema>,
    @Req() request: FastifyRequest,
  ) {
    if (await this.attempts.allow("password-reset", `${request.ip}:${body.email.toLowerCase()}`)) {
      await this.auth.requestPasswordReset(body.email);
    }
    return { success: true, message: GENERIC_AUTH_MESSAGE };
  }

  @Post("password/reset")
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    const passwordError = this.auth.passwordError(body.new_password);
    if (passwordError) throw new BadRequestException(passwordError);
    if (!(await this.auth.resetPassword(body.token, body.new_password))) {
      throw new BadRequestException("Invalid or expired reset token");
    }
    return { success: true };
  }

  @Post("email")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthGuard)
  async changeEmail(
    @Body(new ZodValidationPipe(changeEmailSchema)) body: z.infer<typeof changeEmailSchema>,
    @Req() request: AuthRequest,
  ) {
    await this.verifySensitiveAction(request.authUser, body.current_password, body.mfa_code, body.recovery_code);
    const queued = await this.auth.requestEmailChange(request.authUser, body.email, metadata(request));
    if (!queued) throw new ConflictException("Email is already in use");
    return { success: true, message: GENERIC_AUTH_MESSAGE };
  }

  @Post("password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Req() request: AuthRequest,
  ) {
    const passwordError = this.auth.passwordError(body.new_password);
    if (passwordError) throw new BadRequestException(passwordError);
    await this.verifySensitiveAction(request.authUser, body.current_password, body.mfa_code);
    await this.auth.changePassword(request.authUser.id, body.new_password, metadata(request));
    return { success: true };
  }

  @Get("mfa")
  @UseGuards(AuthGuard)
  async mfa(@Req() request: AuthRequest) {
    return { data: await this.auth.getMfaState(request.authUser.id) };
  }

  @Post("mfa/setup")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async setupMfa(
    @Body(new ZodValidationPipe(reauthenticateSchema)) body: z.infer<typeof reauthenticateSchema>,
    @Req() request: AuthRequest,
  ) {
    await this.verifySensitiveAction(request.authUser, body.current_password, body.mfa_code, body.recovery_code);
    return { data: await this.auth.beginMfaSetup(request.authUser, metadata(request)) };
  }

  @Post("mfa/enable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async enableMfa(
    @Body(new ZodValidationPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>,
    @Req() request: AuthRequest,
  ) {
    if (!(await this.auth.verifyMfaCode(request.authUser.id, body.code, true))) {
      throw new UnauthorizedException("Invalid authentication code");
    }
    const recoveryCodes = await this.auth.createRecoveryCodes(request.authUser.id, "mfa_enabled", metadata(request));
    await this.auth.markSessionMfaVerified(request.session.sessionId, request.authUser);
    return { success: true, recovery_codes: recoveryCodes };
  }

  @Post("mfa/recovery-codes")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async recoveryCodes(
    @Body(new ZodValidationPipe(reauthenticateSchema)) body: z.infer<typeof reauthenticateSchema>,
    @Req() request: AuthRequest,
  ) {
    await this.verifySensitiveAction(request.authUser, body.current_password, body.mfa_code, body.recovery_code, true);
    const recoveryCodes = await this.auth.createRecoveryCodes(
      request.authUser.id,
      "mfa_recovery_codes_regenerated",
      metadata(request),
    );
    return { recovery_codes: recoveryCodes };
  }

  @Post("mfa/disable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async disableMfa(
    @Body(new ZodValidationPipe(reauthenticateSchema)) body: z.infer<typeof reauthenticateSchema>,
    @Req() request: AuthRequest,
  ) {
    await this.verifySensitiveAction(request.authUser, body.current_password, body.mfa_code, body.recovery_code, true);
    await this.auth.disableMfa(request.authUser.id);
    return { success: true };
  }

  @Get("sessions")
  @UseGuards(AuthGuard)
  async sessions(@Req() request: AuthRequest) {
    return { data: await this.auth.listSessions(request.authUser.id) };
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async revokeSession(@Param("id") id: string, @Req() request: AuthRequest) {
    await this.auth.revokeSessionById(id, request.authUser.id, metadata(request));
    return { success: true };
  }

  @Post("sessions/revoke-all")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async revokeAllSessions(@Req() request: AuthRequest) {
    await this.auth.revokeAllSessions(request.authUser.id, metadata(request));
    return { success: true };
  }

  private async establishSession(request: FastifyRequest, user: User, mfaVerified = false): Promise<void> {
    request.session.userId = user.id;
    delete request.session.pendingMfaUserId;
    delete request.session.pendingMfaAt;
    await this.auth.createSession({ sessionId: request.session.sessionId, user, mfaVerified, ...metadata(request) });
    await request.session.save();
  }

  private async verifySensitiveAction(
    user: User,
    password: string,
    mfaCode?: string,
    recoveryCode?: string,
    requireMfa = false,
  ): Promise<void> {
    if (!(await this.auth.verifyPassword(password, user.password_hash))) {
      throw new UnauthorizedException("Current password is incorrect");
    }
    const mfa = await this.auth.getMfaState(user.id);
    if (!mfa.enabled) {
      if (requireMfa) throw new UnauthorizedException("MFA is required");
      return;
    }
    const valid = recoveryCode
      ? await this.auth.consumeRecoveryCode(user.id, recoveryCode)
      : await this.auth.verifyMfaCode(user.id, mfaCode ?? "");
    if (!valid) throw new UnauthorizedException("MFA is required");
  }
}
