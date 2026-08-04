import type { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfigService } from "../../../core/config/config.service";
import type { TransactionService } from "../../../core/database/transaction.service";
import { BootstrapAdminService } from "./bootstrap-admin.service";

function createService(transaction: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const transactions = {
    runAsOperator: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(transaction as Prisma.TransactionClient)),
  } as unknown as TransactionService;
  const config = {
    adminEmail: "Admin@Example.com",
    adminPassword: "a sufficiently long bootstrap password",
    bcryptRounds: 4,
    ...overrides,
  } as AppConfigService;
  return { service: new BootstrapAdminService(config, transactions), transactions };
}

describe("BootstrapAdminService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a verified admin and personal account when no matching user exists", async () => {
    const userCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue(null), create: userCreate },
      account: { create: vi.fn().mockResolvedValue({}) },
      accountMembership: { create: vi.fn().mockResolvedValue({}) },
    };
    const { service } = createService(transaction);

    await service.onApplicationBootstrap();

    const data = userCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      email: "admin@example.com",
      normalizedEmail: "admin@example.com",
      isAdmin: true,
      platformRole: "admin",
      status: "active",
    });
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    await expect(bcrypt.compare("a sufficiently long bootstrap password", data.passwordHash)).resolves.toBe(true);
  });

  it("does not modify an existing account", async () => {
    const userCreate = vi.fn();
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "existing-user" }), create: userCreate },
      account: { create: vi.fn() },
      accountMembership: { create: vi.fn() },
    };
    const { service } = createService(transaction);

    await service.onApplicationBootstrap();

    expect(userCreate).not.toHaveBeenCalled();
    expect(transaction.account.create).not.toHaveBeenCalled();
  });
});
