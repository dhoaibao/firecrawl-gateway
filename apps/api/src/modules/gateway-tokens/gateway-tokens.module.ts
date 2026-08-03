import { forwardRef, Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { GatewayTokensService } from "./application/gateway-tokens.service";
import { GatewayTokensController } from "./presentation/gateway-tokens.controller";
import { AdminGatewayTokensController } from "./presentation/admin-gateway-tokens.controller";

@Module({
  imports: [DatabaseModule, AuthModule, forwardRef(() => OperatorModule)],
  controllers: [GatewayTokensController, AdminGatewayTokensController],
  providers: [GatewayTokensService],
  exports: [GatewayTokensService],
})
export class GatewayTokensModule {}
