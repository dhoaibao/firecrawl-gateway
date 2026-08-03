import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { CoreConfigModule } from "../../core/config/config.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { InfrastructureService } from "./application/infrastructure.service";
import { InfrastructureController } from "./presentation/infrastructure.controller";

@Module({
  imports: [CoreConfigModule, DatabaseModule, AuthModule, OperatorModule, IntegrationsModule],
  controllers: [InfrastructureController],
  providers: [InfrastructureService],
  exports: [InfrastructureService],
})
export class InfrastructureModule {}
