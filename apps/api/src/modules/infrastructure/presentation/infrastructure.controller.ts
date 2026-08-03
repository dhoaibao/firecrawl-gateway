import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { PlatformAdminGuard, OperatorMfaGuard, OperatorStepUpGuard } from "../../operator/presentation/operator.guards";
import { InfrastructureService, SOURCE_STATUSES } from "../application/infrastructure.service";
import { ProviderStoreService } from "../../integrations/application/provider-store.service";

const sourceSchema = z.object({ id: z.string().trim().min(1).max(255), name: z.string().trim().min(1).max(255), kind: z.enum(["cloud", "self_hosted"]), baseUrl: z.string().optional(), credentialId: z.string().optional(), priority: z.number().int().positive().optional(), hardConcurrency: z.number().int().positive().optional(), requestTimeoutMs: z.number().int().positive().optional(), responseBufferMaxBytes: z.number().int().positive().optional(), capabilities: z.array(z.string()).optional(), allowPrivateNetwork: z.boolean().optional() });
const updateSchema = sourceSchema.partial().extend({ status: z.enum(SOURCE_STATUSES).optional() });
const operatorCredentialSchema = z.object({ value: z.string().trim().min(1), source_id: z.string().trim().min(1), purpose: z.enum(["firecrawl_cloud", "self_hosted_upstream"]).optional() });

@Controller("api/v1/admin/infrastructure")
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class InfrastructureController {
  constructor(private readonly infrastructure: InfrastructureService, private readonly credentials: ProviderStoreService) {}

  @Get()
  async list() { const rows = await this.infrastructure.list(); return { data: rows.map((row) => ({ ...row, consumed: null, budget: row.monthly_budget_cents, concurrency: row.hard_concurrency, latency_ms: null })) }; }

  @Get("credentials")
  async credentialsList() { return { data: await this.credentials.listOperator() }; }

  @Post("credentials")
  @UseGuards(OperatorStepUpGuard)
  @HttpCode(201)
  async credentialsCreate(@Body(new ZodValidationPipe(operatorCredentialSchema)) body: z.infer<typeof operatorCredentialSchema>) { return { data: await this.credentials.createOperator({ value: body.value, sourceId: body.source_id, purpose: body.purpose ?? "firecrawl_cloud" }) }; }

  @Put("credentials/:id")
  @UseGuards(OperatorStepUpGuard)
  @HttpCode(201)
  async credentialsReplace(@Param("id") id: string, @Body(new ZodValidationPipe(operatorCredentialSchema)) body: z.infer<typeof operatorCredentialSchema>) { const result = await this.credentials.replaceOperator(id, { value: body.value, sourceId: body.source_id, purpose: body.purpose ?? "firecrawl_cloud" }); if (!result) throw new NotFoundException("Credential not found"); return { data: result }; }

  @Delete("credentials/:id")
  @UseGuards(OperatorStepUpGuard)
  async credentialsRevoke(@Param("id") id: string) { if (!(await this.credentials.revokeOperator(id))) throw new NotFoundException("Credential not found"); return { success: true }; }

  @Post()
  @UseGuards(OperatorStepUpGuard)
  async create(@Body(new ZodValidationPipe(sourceSchema)) body: z.infer<typeof sourceSchema>) { return { data: await this.infrastructure.create(body) }; }

  @Patch(":id")
  @UseGuards(OperatorStepUpGuard)
  async update(@Param("id") id: string, @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>) { const result = await this.infrastructure.update(id, body); if (!result) throw new NotFoundException("Infrastructure source not found"); return { data: result }; }

  @Post(":id/test")
  @UseGuards(OperatorStepUpGuard)
  async test(@Param("id") id: string) { const result = await this.infrastructure.test(id); if (!result) throw new NotFoundException("Infrastructure source not found"); return { data: result }; }

  @Post(":id/:action")
  @UseGuards(OperatorStepUpGuard)
  async action(@Param("id") id: string, @Param("action") action: string) { const status = action === "drain" ? "draining" : action === "pause" ? "paused" : action === "activate" ? "active" : null; if (!status) throw new BadRequestException("Unsupported source action"); const result = await this.infrastructure.update(id, { status }); if (!result) throw new NotFoundException("Infrastructure source not found"); return { data: result }; }
}
