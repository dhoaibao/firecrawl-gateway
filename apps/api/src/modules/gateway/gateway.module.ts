import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { GatewayTokensModule } from "../gateway-tokens/gateway-tokens.module";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { SettingsModule } from "../settings/settings.module";
import { QuotaModule } from "../quota/quota.module";
import { AccountsModule } from "../accounts/accounts.module";
import { GatewayJobsService } from "./application/gateway-jobs.service";
import { GatewayAuditService } from "./application/gateway-audit.service";
import { GatewayTransportService } from "./application/gateway-transport.service";
import { GatewayResponseService } from "./application/gateway-response.service";
import { GatewayController } from "./presentation/gateway.controller";
import { PlaygroundController } from "./presentation/playground.controller";

@Module({ imports: [DatabaseModule, AuthModule, GatewayTokensModule, InfrastructureModule, SettingsModule, QuotaModule, AccountsModule], controllers: [GatewayController, PlaygroundController], providers: [GatewayController, GatewayJobsService, GatewayAuditService, GatewayTransportService, GatewayResponseService], exports: [GatewayJobsService, GatewayAuditService, GatewayTransportService, GatewayResponseService] })
export class GatewayModule {}
