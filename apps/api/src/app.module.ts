import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { CoreConfigModule } from "./core/config/config.module";
import { DatabaseModule } from "./core/database/database.module";
import { HealthModule } from "./core/health/health.module";
import { RateLimitModule } from "./core/rate-limit/rate-limit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { QuotaModule } from "./modules/quota/quota.module";
import { GatewayTokensModule } from "./modules/gateway-tokens/gateway-tokens.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { InfrastructureModule } from "./modules/infrastructure/infrastructure.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { PortalModule } from "./modules/portal/portal.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { GatewayModule } from "./modules/gateway/gateway.module";
import { StaticUiModule } from "./modules/static-ui/static-ui.module";

@Module({
  imports: [CoreConfigModule, DatabaseModule, RateLimitModule, HealthModule, AuthModule, QuotaModule, AccountsModule, GatewayTokensModule, IntegrationsModule, InfrastructureModule, SettingsModule, PortalModule, WebhooksModule, GatewayModule, StaticUiModule],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
