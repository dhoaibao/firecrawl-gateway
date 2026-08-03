import { Injectable } from "@nestjs/common";
import type { RateLimitDecision } from "../../rate-limit-store";
import { consumeRateLimitWithClient } from "../../rate-limit-store";
import { TransactionService } from "../database/transaction.service";

@Injectable()
export class RateLimitService {
  constructor(private readonly transactions: TransactionService) {}

  consume(keys: string[], limit: number, windowMs: number): Promise<RateLimitDecision> {
    return this.transactions.run((transaction) => consumeRateLimitWithClient(transaction, keys, limit, windowMs));
  }
}
