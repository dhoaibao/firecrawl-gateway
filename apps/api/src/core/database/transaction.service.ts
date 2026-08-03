import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";

const TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 15_000,
} as const;
const STATEMENT_TIMEOUT = "14s";
const LOCK_TIMEOUT = "5s";

export type TransactionOperation<T> = (transaction: Prisma.TransactionClient) => Promise<T>;

@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(operation: TransactionOperation<T>): Promise<T> {
    return this.runWithContext({}, operation);
  }

  runForAccount<T>(accountId: string, operation: TransactionOperation<T>): Promise<T> {
    if (!accountId.trim()) throw new Error("Account context is required");
    return this.runWithContext({ accountId }, operation);
  }

  runAsOperator<T>(operation: TransactionOperation<T>): Promise<T> {
    return this.runWithContext({ operator: true }, operation);
  }

  private runWithContext<T>(
    context: { accountId?: string; operator?: boolean },
    operation: TransactionOperation<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        context.operator
          ? "SET LOCAL ROLE firecrawl_gateway_operator"
          : "SET LOCAL ROLE firecrawl_gateway_runtime",
      );
      await transaction.$executeRaw`
        SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)
      `;
      await transaction.$executeRaw`
        SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)
      `;
      await transaction.$executeRaw`
        SELECT set_config('app.account_id', ${context.accountId ?? ""}, true)
      `;
      return operation(transaction);
    }, TRANSACTION_OPTIONS);
  }
}
