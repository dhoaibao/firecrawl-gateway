import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { ApiConfigModule } from "./common/config.module";
import { RateLimitMiddleware } from "./common/rate-limit.middleware";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { SettingsModule } from "./settings/settings.module";
import { AuditModule } from "./audit/audit.module";
import { ProxyModule } from "./proxy/proxy.module";
import { HealthModule } from "./health/health.module";
import { CronModule } from "./cron/cron.module";
import { CreditsModule } from "./credits/credits.module";
import { MetricsModule } from "./metrics/metrics.module";

@Module({
  imports: [
    ApiConfigModule,
    CreditsModule,
    MetricsModule,
    PrismaModule,
    AuthModule,
    ApiKeysModule,
    SettingsModule,
    AuditModule,
    ProxyModule,
    HealthModule,
    CronModule,
  ],
  providers: [RateLimitMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).forRoutes({ path: "*path", method: RequestMethod.ALL });
  }
}
