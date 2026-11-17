import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { CreditsModule } from "../credits/credits.module";
import { SettingsModule } from "../settings/settings.module";
import { CronController } from "./cron.controller";
import { CronService } from "./cron.service";

@Module({
  imports: [SettingsModule, CreditsModule, ApiKeysModule],
  controllers: [CronController],
  providers: [CronService],
})
export class CronModule {}
