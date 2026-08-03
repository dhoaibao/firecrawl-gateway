import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { TransactionService } from "../database/transaction.service";
import { RateLimitService } from "./rate-limit.service";

describe("RateLimitService", () => {
  it("atomically consumes shared PostgreSQL buckets inside a runtime transaction", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([
        { key: "auth:ip:192.0.2.1", count: 2, reset_at: resetAt },
      ]),
    } as unknown as Prisma.TransactionClient;
    const transactions = {
      run: vi.fn((operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(transaction)),
    } as unknown as TransactionService;
    const service = new RateLimitService(transactions);

    await expect(service.consume(["auth:ip:192.0.2.1"], 8, 60_000)).resolves.toEqual({
      allowed: true,
      remaining: 6,
      resetAt,
    });
    expect(transactions.run).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });
});
