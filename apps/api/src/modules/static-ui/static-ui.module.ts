import { Module } from "@nestjs/common";
import { CoreConfigModule } from "../../core/config/config.module";
import { StaticUiController } from "./static-ui.controller";

@Module({ imports: [CoreConfigModule], controllers: [StaticUiController] })
export class StaticUiModule {}
