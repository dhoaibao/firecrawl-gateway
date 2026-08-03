import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { CoreConfigModule } from "./core/config/config.module";
import { DatabaseModule } from "./core/database/database.module";
import { HealthModule } from "./core/health/health.module";
import { RateLimitModule } from "./core/rate-limit/rate-limit.module";
import { AuthModule } from "./modules/auth/auth.module";

@Module({
  imports: [CoreConfigModule, DatabaseModule, RateLimitModule, HealthModule, AuthModule],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
