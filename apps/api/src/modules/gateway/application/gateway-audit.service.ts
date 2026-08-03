import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { TransactionService } from "../../../core/database/transaction.service";

@Injectable()
export class GatewayAuditService {
  constructor(private readonly transactions: TransactionService) {}

  async write(input: {
    method: string;
    path: string;
    routeMode: string;
    backendUsed: string;
    fundingType: string;
    fallbackUsed: boolean;
    fallbackReason: string;
    statusCode: number;
    durationMs: number;
    userId?: string;
    accountId?: string;
    requestId?: string;
  }): Promise<void> {
    await this.transactions.runAsOperator((transaction) => transaction.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        createdAt: new Date(),
        method: input.method,
        path: input.path,
        routeMode: input.routeMode,
        backendUsed: input.backendUsed,
        fundingType: input.fundingType,
        fallbackUsed: input.fallbackUsed,
        fallbackReason: input.fallbackReason,
        statusCode: input.statusCode,
        durationMs: input.durationMs,
        userId: input.userId ?? null,
        accountId: input.accountId ?? null,
        requestId: input.requestId ?? null,
      },
    }).then(() => undefined));
  }
}
