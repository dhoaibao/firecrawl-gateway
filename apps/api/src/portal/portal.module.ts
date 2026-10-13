import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { AuditModule } from "../audit/audit.module";
import { PortalAuthModule } from "../portal-auth/portal-auth.module";
import { UserCloudKeysModule } from "../user-cloud-keys/user-cloud-keys.module";
import { PortalAccountController } from "./portal-account.controller";
import { PortalApiKeysController } from "./portal-api-keys.controller";
import { PortalCloudKeysController } from "./portal-cloud-keys.controller";

// The portal's account API: a signed-in user's own virtual keys and Cloud keys.
@Module({
  imports: [PortalAuthModule, ApiKeysModule, UserCloudKeysModule, AuditModule],
  controllers: [PortalAccountController, PortalApiKeysController, PortalCloudKeysController],
})
export class PortalModule {}
