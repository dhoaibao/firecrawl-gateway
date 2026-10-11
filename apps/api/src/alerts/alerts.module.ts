import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { AlertService } from "./alert.service";

// MetricsModule and CreditsModule are global; the alert settings come from SettingsModule.
@Module({ imports: [SettingsModule], providers: [AlertService] })
export class AlertsModule {}
