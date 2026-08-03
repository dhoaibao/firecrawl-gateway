import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../../core/database/database.module";
import { AccountsModule } from "../accounts/accounts.module";
import { QuotaModule } from "../quota/quota.module";
import { GatewayTokensModule } from "../gateway-tokens/gateway-tokens.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { OperatorMfaGuard, OperatorReasonGuard, OperatorStepUpGuard, PlatformAdminGuard } from "./presentation/operator.guards";
import { AdminAuditController, OperatorController } from "./presentation/operator.controller";

@Module({
  imports: [AuthModule, DatabaseModule, forwardRef(() => AccountsModule), forwardRef(() => QuotaModule), forwardRef(() => GatewayTokensModule), IntegrationsModule],
  controllers: [OperatorController, AdminAuditController],
  providers: [PlatformAdminGuard, OperatorMfaGuard, OperatorStepUpGuard, OperatorReasonGuard],
  exports: [PlatformAdminGuard, OperatorMfaGuard, OperatorStepUpGuard, OperatorReasonGuard],
})
export class OperatorModule {}
