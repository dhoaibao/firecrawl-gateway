import { Module } from "@nestjs/common";
import { CoreConfigModule } from "./core/config/config.module";
import { DatabaseModule } from "./core/database/database.module";
import { QuotaModule } from "./modules/quota/quota.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { WorkerModule } from "./modules/worker/worker.module";
import { EmailWorkerModule } from "./modules/email/email-worker.module";
import { AuditModule } from "./modules/audit/audit.module";

@Module({
  imports: [CoreConfigModule, DatabaseModule, QuotaModule, WebhooksModule, WorkerModule, EmailWorkerModule, AuditModule],
})
export class WorkerAppModule {}
