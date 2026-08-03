import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { CoreConfigModule } from "../../core/config/config.module";
import { EmailModule } from "../email/email.module";
import { AuthModule } from "../auth/auth.module";
import { QuotaModule } from "../quota/quota.module";
import { GatewayTokensModule } from "../gateway-tokens/gateway-tokens.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PortalService } from "./application/portal.service";
import { PortalController } from "./presentation/portal.controller";

@Module({ imports: [CoreConfigModule, DatabaseModule, AuthModule, EmailModule, QuotaModule, GatewayTokensModule, IntegrationsModule], controllers: [PortalController], providers: [PortalService], exports: [PortalService] })
export class PortalModule {}
