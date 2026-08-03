import { Body, Controller, ForbiddenException, Get, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest } from "../../auth/domain/auth-session";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { PortalService } from "../application/portal.service";
import { requestMetadata } from "../../../common/http/request-context";

const reauthenticationSchema = z.object({ current_password: z.string().min(1), mfa_code: z.string().trim().optional(), recovery_code: z.string().trim().optional() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(255).optional(), funding_preference: z.enum(["byok", "included", "auto"]).optional() });

@Controller("api/v1/app")
@UseGuards(AuthGuard)
export class PortalController {
  constructor(private readonly portal: PortalService) {}
  @Get(["overview", "dashboard"])
  async overview(@Req() request: AuthenticatedRequest) { return { data: await this.portal.overview(request.authUser) }; }
  @Get("account")
  async account(@Req() request: AuthenticatedRequest) { return { data: await this.portal.getAccount(requiredAccount(request)) }; }
  @Patch("account")
  async updateAccount(@Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>, @Req() request: AuthenticatedRequest) { return { data: await this.portal.updateAccount(request.authUser, body) }; }
  @Post("account/export")
  async exportAccount(@Body(new ZodValidationPipe(reauthenticationSchema)) body: z.infer<typeof reauthenticationSchema>, @Req() request: AuthenticatedRequest) { return { data: await this.portal.exportAccount(request.authUser, body, requestMetadata(request)) }; }
  @Post("account/deletion-request")
  async requestDeletion(@Body(new ZodValidationPipe(reauthenticationSchema)) body: z.infer<typeof reauthenticationSchema>, @Req() request: AuthenticatedRequest) { return { data: await this.portal.requestDeletion(request.authUser, body, requestMetadata(request)) }; }
  @Get("endpoint")
  async endpoint(@Req() request: AuthenticatedRequest) { return { data: await this.portal.endpoint(requiredAccount(request)) }; }
  @Get("quota")
  async quota(@Req() request: AuthenticatedRequest) { return { data: await this.portal.quotaSummary(requiredAccount(request)) }; }
  @Get("usage")
  async usage(@Query() query: Record<string, unknown>, @Req() request: AuthenticatedRequest) { return { data: await this.portal.usage(requiredAccount(request), query) }; }
  @Get("request-history")
  async history(@Query() query: Record<string, unknown>, @Req() request: AuthenticatedRequest) { return { data: await this.portal.history(requiredAccount(request), query) }; }
  @Get("security/events")
  async security(@Query("limit") limit: string | undefined, @Req() request: AuthenticatedRequest) { return { data: await this.portal.securityEvents(request.authUser.id, Number(limit) || 50) }; }
}
function requiredAccount(request: AuthenticatedRequest): string { if (!request.authUser.account_id) throw new ForbiddenException("An account is required"); return request.authUser.account_id; }
