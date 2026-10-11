import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CreditsModule } from "../credits/credits.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { AuthModule } from "../auth/auth.module";
import { SettingsModule } from "../settings/settings.module";
import { UserCloudKeysModule } from "../user-cloud-keys/user-cloud-keys.module";
import { ProxyRoutes } from "./proxy.routes";
import { ProxyService } from "./proxy.service";

@Module({
  imports: [
    AuditModule,
    ApiKeysModule,
    AuthModule,
    SettingsModule,
    CreditsModule,
    UserCloudKeysModule,
  ],
  providers: [ProxyService, ProxyRoutes],
})
export class ProxyModule {}
