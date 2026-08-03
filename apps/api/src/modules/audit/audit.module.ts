import { Module } from "@nestjs/common";
import { CoreConfigModule } from "../../core/config/config.module";
import { AuditRetentionService } from "./application/audit-retention.service";

@Module({
  imports: [CoreConfigModule],
  providers: [AuditRetentionService],
  exports: [AuditRetentionService],
})
export class AuditModule {}
