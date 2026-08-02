import { describe, expect, it, vi, beforeEach } from "vitest";
import { clearTouchDebouncer, touchApiKey, validateApiKeyWithUser } from "./service";

const state = vi.hoisted(() => ({
  findValidWithUser: vi.fn(),
  withOperatorTransaction: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}));
const mockResumeAccountEntitlementsWithClient = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  asDatabaseClient: (tx: unknown) => tx,
}));
vi.mock("../infrastructure/database", () => ({
  withOperatorTransaction: state.withOperatorTransaction,
}));
vi.mock("./repository", () => ({
  findValidWithUser: state.findValidWithUser,
  toGatewayToken: (key: { accountId?: string; account_id?: string }) => ({
    ...key,
    account_id: key.account_id ?? key.accountId,
  }),
  toUser: (user: unknown) => user,
}));
vi.mock("../quota/service", () => ({
  resumeAccountEntitlementsWithClient: mockResumeAccountEntitlementsWithClient,
}));

const key = {
  id: "key-1",
  user_id: "user-1",
  account_id: "account-1",
  accountId: "account-1",
  name: "Production",
  key_hash: "hash",
  key_value: null,
  key_prefix: "fc_test",
  scopes: ["*"],
  expires_at: null,
  inactivity_timeout_seconds: null,
  revoked: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_used_at: null,
};

const activeUser = {
  id: "user-1",
  email: "user@example.com",
  name: "Test User",
  password_hash: "password-hash",
  is_admin: false,
  status: "active",
  suspended_until: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("validateApiKeyWithUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.withOperatorTransaction.mockImplementation(async (fn) => fn({
      user: { update: state.update },
      apiKey: { updateMany: state.updateMany },
    }));
    clearTouchDebouncer();
  });

  it("loads the API key and owner through the repository", async () => {
    state.findValidWithUser.mockResolvedValue({ key, user: activeUser });

    const result = await validateApiKeyWithUser("fc_test_key");

    expect(mockResumeAccountEntitlementsWithClient).not.toHaveBeenCalled();
    expect(state.findValidWithUser).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      key: { id: "key-1", user_id: "user-1" },
      user: { id: "user-1", email: "user@example.com", status: "active" },
    });
  });

  it("reactivates an expired suspended owner", async () => {
    const suspendedUser = {
      ...activeUser,
      status: "suspended",
      suspended_until: "2020-01-01T00:00:00.000Z",
    };
    state.findValidWithUser.mockResolvedValue({ key, user: suspendedUser });
    state.update.mockResolvedValue(activeUser);

    const result = await validateApiKeyWithUser("fc_test_key");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "account-1");
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1" } }));
    expect(result?.user).toEqual(activeUser);
  });
});

describe("touchApiKey", () => {
  it("updates the key inside an operator transaction", async () => {
    await touchApiKey("key-1");

    expect(state.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(state.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
