import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "./prisma.service";
import { TransactionService } from "./transaction.service";

function createService() {
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  } as unknown as Prisma.TransactionClient;
  const transactionClient = {
    $transaction: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(transaction)),
  };
  const prisma = {
    runtime: transactionClient,
    operator: transactionClient,
  } as unknown as PrismaService;
  return { service: new TransactionService(prisma), transaction, prisma };
}

describe("TransactionService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the bounded runtime role for unscoped and account transactions", async () => {
    const { service, transaction } = createService();
    const operation = vi.fn().mockResolvedValue("ok");

    await expect(service.runForAccount("account-1", operation)).resolves.toBe("ok");

    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL ROLE firecrawl_gateway_runtime");
    expect(operation).toHaveBeenCalledWith(transaction);
    const accountContextCall = vi.mocked(transaction.$executeRaw).mock.calls.at(-1);
    expect(accountContextCall?.[1]).toBe("account-1");
  });

  it("uses the operator role without inheriting tenant context", async () => {
    const { service, transaction } = createService();

    await service.runAsOperator(async () => undefined);

    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL ROLE firecrawl_gateway_operator");
    const accountContextCall = vi.mocked(transaction.$executeRaw).mock.calls.at(-1);
    expect(accountContextCall?.[1]).toBe("");
  });
});
