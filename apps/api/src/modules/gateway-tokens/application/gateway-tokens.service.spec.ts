import { describe, expect, it, vi } from "vitest";
import { GatewayTokensService } from "./gateway-tokens.service";

function serviceWith(rows: unknown[]) {
  const transaction = { apiKey: { findMany: vi.fn().mockResolvedValue(rows), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const transactions = { runAsOperator: vi.fn((callback: (tx: typeof transaction) => unknown) => callback(transaction)) };
  return { service: new GatewayTokensService(transactions as never), transaction };
}

describe("GatewayTokensService.authenticate", () => {
  it("authenticates verified active tokens and asynchronously touches usage", async () => {
    const { service, transaction } = serviceWith([{ id: "token-1", userId: "user-1", accountId: "account-1", scopes: ["v1:scrape"], expiresAt: null, inactivityTimeoutSeconds: null, lastUsedAt: null, createdAt: new Date(), user: { status: "active", suspendedUntil: null } }]);
    const result = await service.authenticate("fc_test-token");
    expect(result).toMatchObject({ tokenId: "token-1", userId: "user-1", accountId: "account-1", scopes: ["v1:scrape"], userStatus: "active" });
    expect(transaction.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "token-1" } }));
  });

  it("rejects absent, expired, and inactive token rows", async () => {
    const now = Date.now();
    const { service } = serviceWith([
      { id: "expired", userId: "u", accountId: "a", scopes: ["*"], expiresAt: new Date(now - 1), inactivityTimeoutSeconds: null, lastUsedAt: null, createdAt: new Date(now - 10), user: { status: "active", suspendedUntil: null } },
      { id: "inactive", userId: "u", accountId: "a", scopes: ["*"], expiresAt: null, inactivityTimeoutSeconds: 1, lastUsedAt: new Date(now - 2_000), createdAt: new Date(now - 3_000), user: { status: "active", suspendedUntil: null } },
    ]);
    expect(await service.authenticate("fc_test-token")).toBeNull();
    const empty = serviceWith([]).service;
    expect(await empty.authenticate("fc_missing")).toBeNull();
  });
});
