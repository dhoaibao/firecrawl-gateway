import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { SettingsService } from "./application/settings.service";
import { SettingsController } from "./presentation/settings.controller";

@Module({ imports: [DatabaseModule, AuthModule, OperatorModule], controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
