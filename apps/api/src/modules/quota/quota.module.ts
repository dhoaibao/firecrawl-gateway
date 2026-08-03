import { forwardRef, Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { QuotaService } from "./application/quota.service";
import { QuotaController } from "./presentation/quota.controller";

@Module({
  imports: [DatabaseModule, AuthModule, forwardRef(() => OperatorModule)],
  controllers: [QuotaController],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
