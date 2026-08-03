import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { OperatorMfaGuard, OperatorStepUpGuard, PlatformAdminGuard } from "../../operator/presentation/operator.guards";
import { QuotaRejectionError, QuotaService } from "../application/quota.service";

const policySchema = z.object({
  default_grant: z.number().int().nonnegative().optional(),
  commitment_ceiling: z.number().int().nonnegative().optional(),
  hard_monthly_cap: z.number().int().nonnegative().optional(),
  admissions_enabled: z.boolean().optional(),
  included_traffic_enabled: z.boolean().optional(),
  warning_thresholds: z.unknown().optional(),
  reason: z.string().trim().min(1).max(500),
});

const accountReasonSchema = z.object({ account_id: z.string().trim().min(1), reason: z.string().trim().min(1).max(500) });
const adjustSchema = z.object({ amount: z.number().int().refine((value) => value !== 0), reason: z.string().trim().min(1).max(500) });
const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });

@Controller(["api/v1/admin/capacity", "admin/api/quota"])
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get("policy")
  async policy() {
    return { data: await this.quota.getPolicySummary() };
  }

  @Patch("policy")
  @UseGuards(OperatorStepUpGuard)
  async updatePolicy(@Body(new ZodValidationPipe(policySchema)) body: z.infer<typeof policySchema>) {
    return { data: await this.quota.updatePolicy({
      defaultGrant: body.default_grant,
      commitmentCeiling: body.commitment_ceiling,
      hardMonthlyCap: body.hard_monthly_cap,
      admissionsEnabled: body.admissions_enabled,
      includedTrafficEnabled: body.included_traffic_enabled,
      warningThresholds: body.warning_thresholds,
      actor: "operator",
      reason: body.reason,
    }) };
  }

  @Get("waitlist")
  async waitlist(@Query(new ZodValidationPipe(limitSchema)) query: z.infer<typeof limitSchema>) {
    return { data: await this.quota.listWaitlist(query.limit) };
  }

  @Post("waitlist/admit")
  @UseGuards(OperatorStepUpGuard)
  async admit(@Body(new ZodValidationPipe(accountReasonSchema)) body: z.infer<typeof accountReasonSchema>) {
    return { data: await this.runQuota(() => this.quota.admitAccount(body.account_id, "operator", body.reason)) };
  }

  @Post("waitlist/skip")
  @UseGuards(OperatorStepUpGuard)
  async skip(@Body(new ZodValidationPipe(accountReasonSchema)) body: z.infer<typeof accountReasonSchema>) {
    const result = await this.quota.skipAccount(body.account_id, "operator", body.reason);
    if (!result) throw new BadRequestException("No waitlisted enrollment for this account");
    return { data: result };
  }

  @Post("accounts/:accountId/admit")
  @UseGuards(OperatorStepUpGuard)
  async admitAccount(@Param("accountId") accountId: string, @Body(new ZodValidationPipe(z.object({ reason: z.string().trim().min(1).max(500) }))) body: { reason: string }) {
    return { data: await this.runQuota(() => this.quota.admitAccount(accountId, "operator", body.reason)) };
  }

  @Post("accounts/:accountId/revoke")
  @UseGuards(OperatorStepUpGuard)
  async revoke(@Param("accountId") accountId: string, @Body(new ZodValidationPipe(z.object({ reason: z.string().trim().min(1).max(500) }))) body: { reason: string }) {
    return { data: await this.quota.revokeAccount(accountId, "operator", body.reason) };
  }

  @Post("accounts/:accountId/adjust")
  @UseGuards(OperatorStepUpGuard)
  async adjust(@Param("accountId") accountId: string, @Body(new ZodValidationPipe(adjustSchema)) body: z.infer<typeof adjustSchema>) {
    return { data: await this.quota.adjustAllowance(accountId, body.amount, "operator", body.reason) };
  }

  @Get("entitlements")
  async entitlements(@Query(new ZodValidationPipe(limitSchema)) query: z.infer<typeof limitSchema>) {
    return { data: await this.quota.listEntitlements(query.limit) };
  }

  @Get("events")
  async events(@Query(new ZodValidationPipe(limitSchema)) query: z.infer<typeof limitSchema>) {
    return { data: await this.quota.listEvents(query.limit) };
  }

  private async runQuota<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QuotaRejectionError) throw new BadRequestException({ success: false, error: error.rejection.message, code: error.rejection.code });
      throw error;
    }
  }
}
