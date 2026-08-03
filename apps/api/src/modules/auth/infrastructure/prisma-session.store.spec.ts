import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { TransactionService } from "../../../core/database/transaction.service";
import { PrismaSessionStore } from "./prisma-session.store";

function createStore(session: Record<string, unknown>) {
  const transactions = {
    run: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation({ session } as unknown as Prisma.TransactionClient)),
  } as unknown as TransactionService;
  return { store: new PrismaSessionStore(transactions), transactions };
}

describe("PrismaSessionStore", () => {
  it("reads sessions through a runtime-role transaction", async () => {
    const stored = { cookie: { maxAge: 60_000 }, userId: "user-1" };
    const session = {
      findUnique: vi.fn().mockResolvedValue({ sess: stored, expire: new Date(Date.now() + 60_000) }),
      deleteMany: vi.fn(),
    };
    const { store, transactions } = createStore(session);

    const result = await new Promise((resolve, reject) => {
      store.get("session-1", (error, value) => error ? reject(error) : resolve(value));
    });

    expect(result).toEqual(stored);
    expect(transactions.run).toHaveBeenCalledOnce();
    expect(session.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes expired sessions in the same bounded transaction", async () => {
    const session = {
      findUnique: vi.fn().mockResolvedValue({ sess: {}, expire: new Date(Date.now() - 1) }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const { store } = createStore(session);

    const result = await new Promise((resolve, reject) => {
      store.get("session-1", (error, value) => error ? reject(error) : resolve(value));
    });

    expect(result).toBeNull();
    expect(session.deleteMany).toHaveBeenCalledWith({ where: { sid: "session-1" } });
  });
});
