import { forwardRef, Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { QuotaModule } from "../quota/quota.module";
import { AccountsService } from "./application/accounts.service";
import { AccountsController } from "./presentation/accounts.controller";

@Module({
  imports: [DatabaseModule, AuthModule, forwardRef(() => OperatorModule), QuotaModule],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
