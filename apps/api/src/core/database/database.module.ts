import { Global, Module } from "@nestjs/common";
import { DatabaseReadinessService } from "./database-readiness.service";
import { PrismaService } from "./prisma.service";
import { TransactionService } from "./transaction.service";

@Global()
@Module({
  providers: [PrismaService, TransactionService, DatabaseReadinessService],
  exports: [TransactionService, DatabaseReadinessService],
})
export class DatabaseModule {}
