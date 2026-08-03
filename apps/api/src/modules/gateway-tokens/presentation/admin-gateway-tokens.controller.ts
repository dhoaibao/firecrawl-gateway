import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../auth/domain/auth-session";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { AuthService } from "../../auth/application/auth.service";
import { OperatorMfaGuard, OperatorStepUpGuard, PlatformAdminGuard } from "../../operator/presentation/operator.guards";
import { GatewayTokensService } from "../application/gateway-tokens.service";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";

const reauthSchema = z.object({ current_password: z.string().min(1), mfa_code: z.string().trim().optional(), recovery_code: z.string().trim().optional() });
const createSchema = reauthSchema.extend({ name: z.string().trim().min(1).max(255), scopes: z.array(z.string().trim().min(1)).max(50).optional(), expiresAt: z.string().datetime().nullable().optional(), inactivityTimeoutSeconds: z.number().int().positive().nullable().optional() });

@Controller("admin/api/api-keys")
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class AdminGatewayTokensController {
  constructor(private readonly tokens: GatewayTokensService, private readonly auth: AuthService) {}
  @Get()
  async list() { return { data: await this.tokens.listAll() }; }
  @Post()
  @UseGuards(OperatorStepUpGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>, @Req() request: AuthenticatedRequest) { await this.reauthenticate(request, body); const accountId = request.authUser.account_id ?? `personal:${request.authUser.id}`; return { data: await this.tokens.create({ userId: request.authUser.id, accountId, name: body.name, scopes: body.scopes, expiresAt: body.expiresAt, inactivityTimeoutSeconds: body.inactivityTimeoutSeconds }) }; }
  @Delete(":id")
  @UseGuards(OperatorStepUpGuard)
  async revoke(@Param("id") id: string, @Body(new ZodValidationPipe(reauthSchema)) body: z.infer<typeof reauthSchema>, @Req() request: AuthenticatedRequest) { await this.reauthenticate(request, body); const result = await this.tokens.revokeAny(id); if (!result) throw new UnauthorizedException("Gateway token not found"); return { data: result }; }
  private async reauthenticate(request: AuthenticatedRequest, body: { current_password: string; mfa_code?: string; recovery_code?: string }) { if (!(await this.auth.verifyPassword(body.current_password, request.authUser.password_hash))) throw new UnauthorizedException("Current password is incorrect"); const mfa = await this.auth.getMfaState(request.authUser.id); if (!mfa.enabled) return; const valid = body.recovery_code ? await this.auth.consumeRecoveryCode(request.authUser.id, body.recovery_code) : await this.auth.verifyMfaCode(request.authUser.id, body.mfa_code ?? ""); if (!valid) throw new UnauthorizedException("MFA is required"); }
}
