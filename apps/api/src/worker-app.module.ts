import { Module } from "@nestjs/common";
import { CoreConfigModule } from "./core/config/config.module";
import { DatabaseModule } from "./core/database/database.module";

@Module({
  imports: [CoreConfigModule, DatabaseModule],
})
export class WorkerAppModule {}
