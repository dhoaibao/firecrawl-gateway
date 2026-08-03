import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { ProviderStoreService } from "./application/provider-store.service";
import { ProviderStoreController } from "./presentation/provider-store.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ProviderStoreController],
  providers: [ProviderStoreService],
  exports: [ProviderStoreService],
})
export class IntegrationsModule {}
