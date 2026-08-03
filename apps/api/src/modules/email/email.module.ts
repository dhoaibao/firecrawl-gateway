import { Module } from "@nestjs/common";
import { CoreConfigModule } from "../../core/config/config.module";
import { DatabaseModule } from "../../core/database/database.module";
import { EmailService } from "./application/email.service";

@Module({
  imports: [CoreConfigModule, DatabaseModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
