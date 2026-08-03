import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const quota = vi.hoisted(() => ({
  admit: vi.fn(),
  resume: vi.fn(),
  databaseClient: { query: vi.fn() },
}));
const otp = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("../../../db", () => ({
  asDatabaseClient: vi.fn(() => quota.databaseClient),
}));
vi.mock("../../../quota/service", () => ({
  admitAccountWithClient: quota.admit,
  resumeAccountEntitlementsWithClient: quota.resume,
}));
vi.mock("../../../auth/crypto", () => ({
  decryptAuthValue: vi.fn(() => "totp-secret"),
  encryptAuthValue: vi.fn(() => "encrypted-secret"),
}));
vi.mock("otplib", () => ({
  generateSecret: vi.fn(() => "totp-secret"),
  generateURI: vi.fn(() => "otpauth://firecrawl"),
  verify: otp.verify,
}));

import type { AppConfigService } from "../../../core/config/config.service";
import type { TransactionService } from "../../../core/database/transaction.service";
import { AuthService } from "./auth.service";

const config = {
  authEncryptionKey: "a".repeat(64),
  bcryptRounds: 12,
  publicAppUrl: "http://localhost:3000",
} as AppConfigService;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.com",
    normalizedEmail: "user@example.com",
    name: "User",
    passwordHash: "$2b$12$LQv3c1yqBWxqk5f7VfYJ6eQZ2q9mT4r7e3W8mM5vG2cR9aK6nPq1S",
    isAdmin: false,
    platformRole: "user",
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    authVersion: 1,
    status: "active",
    suspendedUntil: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    memberships: [{ accountId: "personal:user-1" }],
    ...overrides,
  };
}

function createService(transaction: Record<string, unknown>) {
  const transactions = {
    runAsOperator: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(transaction as Prisma.TransactionClient)),
  } as unknown as TransactionService;
  return new AuthService(transactions, config);
}

describe("AuthService security-sensitive flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quota.admit.mockResolvedValue({ status: "enrolled" });
    quota.resume.mockResolvedValue(null);
    otp.verify.mockResolvedValue({ valid: true, timeStep: 12_345 });
  });

  it("admits the personal account in the email-verification transaction", async () => {
    const transaction = {
      authToken: {
        findFirst: vi.fn().mockResolvedValue({ id: "token-1", userId: "user-1", purpose: "email_verification", metadata: {} }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: { update: vi.fn().mockResolvedValue({}) },
      securityEvent: { create: vi.fn().mockResolvedValue({}) },
    };

    await expect(createService(transaction).consumeEmailVerification("token")).resolves.toBe(true);

    expect(quota.admit).toHaveBeenCalledWith(quota.databaseClient, "personal:user-1");
  });

  it("resumes the personal account entitlement when an expired suspension is reactivated", async () => {
    const suspended = userRow({ status: "suspended", suspendedUntil: new Date(Date.now() - 60_000) });
    const transaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(suspended),
        update: vi.fn().mockResolvedValue(userRow()),
      },
    };

    await expect(createService(transaction).getUserById("user-1")).resolves.toMatchObject({ status: "active" });

    expect(quota.resume).toHaveBeenCalledWith(quota.databaseClient, "personal:user-1");
  });

  it("rejects an email change when another user already owns the address", async () => {
    const transaction = {
      user: { findFirst: vi.fn().mockResolvedValue({ id: "user-2" }) },
    };
    const service = createService(transaction);
    const user = userRow() as unknown as Parameters<AuthService["requestEmailChange"]>[0];

    await expect(service.requestEmailChange(user, "taken@example.com", {})).resolves.toBe(false);
  });

  it("promotes a non-null pending secret during first-time MFA enrollment", async () => {
    const factor = {
      secretEncrypted: "encrypted-secret",
      pendingSecretEncrypted: "encrypted-secret",
      enabledAt: null,
      lastUsedStep: null,
    };
    const transaction = {
      mfaFactor: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(factor),
        update: vi.fn().mockResolvedValue({}),
      },
      securityEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createService(transaction);
    const user = {
      id: "user-1",
      email: "user@example.com",
    } as Parameters<AuthService["beginMfaSetup"]>[0];

    await service.beginMfaSetup(user, {});
    await expect(service.verifyMfaCode("user-1", "123456", true)).resolves.toBe(true);

    expect(transaction.mfaFactor.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ pendingSecretEncrypted: "encrypted-secret" }),
    }));
    expect(transaction.mfaFactor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        secretEncrypted: "encrypted-secret",
        pendingSecretEncrypted: null,
      }),
    }));
  });
});
