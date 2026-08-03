import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UnauthorizedException, UseGuards, ForbiddenException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest } from "../../auth/domain/auth-session";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { AuthService } from "../../auth/application/auth.service";
import { ProviderStoreService } from "../application/provider-store.service";

const reauthSchema = z.object({ current_password: z.string().min(1), mfa_code: z.string().trim().optional(), recovery_code: z.string().trim().optional() });
const valueSchema = reauthSchema.extend({ value: z.string().trim().min(1).max(4096) });

@Controller(["api/v1/app/credentials", "admin/api/credentials"])
@UseGuards(AuthGuard)
export class ProviderStoreController {
  constructor(private readonly store: ProviderStoreService, private readonly auth: AuthService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return { data: await this.store.list(accountId(request)) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(valueSchema)) body: z.infer<typeof valueSchema>, @Req() request: AuthenticatedRequest) {
    this.requireVerified(request);
    await this.reauthenticate(request, body);
    const created = await this.store.create(accountId(request), body.value);
    return { data: (await this.store.validate(accountId(request), created.id)) ?? created };
  }

  @Put(":id")
  @HttpCode(HttpStatus.CREATED)
  async replace(@Param("id") id: string, @Body(new ZodValidationPipe(valueSchema)) body: z.infer<typeof valueSchema>, @Req() request: AuthenticatedRequest) {
    this.requireVerified(request);
    await this.reauthenticate(request, body);
    const created = await this.store.replace(accountId(request), id, body.value);
    if (!created) throw new NotFoundException("Credential not found");
    return { data: (await this.store.validate(accountId(request), created.id)) ?? created };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param("id") id: string, @Body(new ZodValidationPipe(reauthSchema)) body: z.infer<typeof reauthSchema>, @Req() request: AuthenticatedRequest) {
    await this.reauthenticate(request, body);
    if (!(await this.store.revoke(accountId(request), id))) throw new NotFoundException("Credential not found");
  }

  @Post(":id/validate")
  async validate(@Param("id") id: string, @Body(new ZodValidationPipe(reauthSchema)) body: z.infer<typeof reauthSchema>, @Req() request: AuthenticatedRequest) {
    await this.reauthenticate(request, body);
    const result = await this.store.validate(accountId(request), id);
    if (!result) throw new NotFoundException("Credential not found");
    return { data: result };
  }

  private async reauthenticate(request: AuthenticatedRequest, body: { current_password: string; mfa_code?: string; recovery_code?: string }) {
    if (!(await this.auth.verifyPassword(body.current_password, request.authUser.password_hash))) throw new UnauthorizedException("Current password is incorrect");
    const mfa = await this.auth.getMfaState(request.authUser.id);
    if (!mfa.enabled) return;
    const valid = body.recovery_code ? await this.auth.consumeRecoveryCode(request.authUser.id, body.recovery_code) : await this.auth.verifyMfaCode(request.authUser.id, body.mfa_code ?? "");
    if (!valid) throw new UnauthorizedException("MFA is required");
  }

  private requireVerified(request: AuthenticatedRequest): void {
    if (request.authUser.email_verified_at === null) throw new ForbiddenException("Email verification is required");
  }
}

function accountId(request: AuthenticatedRequest): string {
  const id = request.authUser.account_id;
  if (!id) throw new ForbiddenException("An account is required");
  return id;
}
