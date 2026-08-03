import { Module } from "@nestjs/common";
import { EmailModule } from "./email.module";
import { EmailWorkerService } from "./application/email-worker.service";

@Module({
  imports: [EmailModule],
  providers: [EmailWorkerService],
})
export class EmailWorkerModule {}
