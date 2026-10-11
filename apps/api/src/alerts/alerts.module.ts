import { Module } from "@nestjs/common";
import { AlertService } from "./alert.service";

// MetricsModule and CreditsModule are global, so only the service is provided here.
@Module({ providers: [AlertService] })
export class AlertsModule {}
