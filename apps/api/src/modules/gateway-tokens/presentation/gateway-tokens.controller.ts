import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest } from "../../auth/domain/auth-session";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { AuthService } from "../../auth/application/auth.service";
import { GatewayTokensService } from "../application/gateway-tokens.service";

const reauthenticationSchema = z.object({
  current_password: z.string().min(1),
  mfa_code: z.string().trim().optional(),
  recovery_code: z.string().trim().optional(),
});

const createSchema = reauthenticationSchema.extend({
  name: z.string().trim().min(1).max(255),
  scopes: z.array(z.string().trim().min(1)).max(50).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  inactivityTimeoutSeconds: z.number().int().positive().nullable().optional(),
});

@Controller("api/v1/app/tokens")
@UseGuards(AuthGuard)
export class GatewayTokensController {
  constructor(
    private readonly tokens: GatewayTokensService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return { data: await this.tokens.list(accountId(request)) };
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const token = await this.tokens.get(id, accountId(request));
    if (!token) throw new UnauthorizedException("Gateway token not found");
    if (token.user_id !== request.authUser.id) throw new UnauthorizedException("Gateway token not found");
    return { data: token };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>, @Req() request: AuthenticatedRequest) {
    if (request.authUser.email_verified_at === null) throw new ForbiddenException("Email verification is required");
    if (body.expiresAt) {
      const expiresAt = Date.parse(body.expiresAt);
      if (expiresAt <= Date.now() || expiresAt > Date.now() + 365 * 24 * 60 * 60 * 1000) throw new BadRequestException("expiresAt must be within the next 365 days");
    }
    if (body.inactivityTimeoutSeconds !== undefined && body.inactivityTimeoutSeconds !== null && body.inactivityTimeoutSeconds > 365 * 24 * 60 * 60) throw new BadRequestException("inactivityTimeoutSeconds exceeds the maximum lifetime");
    await this.reauthenticate(request, body);
    try {
      const token = await this.tokens.create({
        userId: request.authUser.id,
        accountId: accountId(request),
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt,
        inactivityTimeoutSeconds: body.inactivityTimeoutSeconds,
      });
      return { data: token };
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new ConflictException("Gateway token already exists");
      throw error;
    }
  }

  @Delete(":id")
  async revoke(@Param("id") id: string, @Body(new ZodValidationPipe(reauthenticationSchema)) body: z.infer<typeof reauthenticationSchema>, @Req() request: AuthenticatedRequest) {
    await this.reauthenticate(request, body);
    const existing = await this.tokens.get(id, accountId(request));
    if (!existing || existing.user_id !== request.authUser.id) throw new UnauthorizedException("Gateway token not found");
    const token = await this.tokens.revoke(id, accountId(request));
    return { data: token };
  }

  private async reauthenticate(request: AuthenticatedRequest, body: z.infer<typeof reauthenticationSchema>): Promise<void> {
    if (!(await this.auth.verifyPassword(body.current_password, request.authUser.password_hash))) {
      throw new UnauthorizedException("Current password is incorrect");
    }
    const mfa = await this.auth.getMfaState(request.authUser.id);
    if (!mfa.enabled) return;
    const valid = body.recovery_code
      ? await this.auth.consumeRecoveryCode(request.authUser.id, body.recovery_code)
      : await this.auth.verifyMfaCode(request.authUser.id, body.mfa_code ?? "");
    if (!valid) throw new UnauthorizedException("MFA is required");
  }
}

function accountId(request: AuthenticatedRequest): string {
  return request.authUser.account_id ?? `personal:${request.authUser.id}`;
}
