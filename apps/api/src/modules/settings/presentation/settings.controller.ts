import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { PlatformAdminGuard, OperatorMfaGuard, OperatorStepUpGuard } from "../../operator/presentation/operator.guards";
import { SettingsService } from "../application/settings.service";

const settingsSchema = z.record(z.string(), z.unknown());

@Controller(["api/v1/admin/settings", "admin/api/settings"])
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}
  @Get()
  async list() { return { data: await this.settings.list() }; }
  @Put()
  @UseGuards(OperatorStepUpGuard)
  async update(@Body(new ZodValidationPipe(settingsSchema)) body: Record<string, unknown>) { return { data: await this.settings.update(body) }; }
}
