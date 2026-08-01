import { beforeEach, describe, expect, it, vi } from "vitest";
import { withClient } from "../db";
import { activateUser, getUserByEmail, getUserById } from "./service";

const mockResumeAccountEntitlementsWithClient = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  withClient: vi.fn(),
  withOperatorTransaction: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock("../quota/service", () => ({
  resumeAccountEntitlementsWithClient: mockResumeAccountEntitlementsWithClient,
}));

describe("user reactivation", () => {
  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    mockResumeAccountEntitlementsWithClient.mockReset();
  });

  it("resumes quota entitlements in the same transaction as expired user reactivation", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        password_hash: "hash",
        is_admin: false,
        status: "suspended",
        suspended_until: "2026-01-01T00:00:00.000Z",
        email_verified_at: "2025-01-01T00:00:00.000Z",
        account_id: "personal:user-1",
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        password_hash: "hash",
        is_admin: false,
        status: "active",
        suspended_until: null,
        email_verified_at: "2025-01-01T00:00:00.000Z",
        account_id: "personal:user-1",
      }] }),
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client as never));

    const user = await getUserByEmail("user@example.com");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(client, "personal:user-1");
    expect(user).toMatchObject({ id: "user-1", status: "active", suspended_until: null });
  });

  it("also resumes quota during session-deserialization user lookup", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        password_hash: "hash",
        is_admin: false,
        status: "suspended",
        suspended_until: "2026-01-01T00:00:00.000Z",
        account_id: "personal:user-1",
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        status: "active",
        suspended_until: null,
      }] }),
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client as never));

    await getUserById("user-1");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(client, "personal:user-1");
  });

  it("atomically activates an admin-restored user with quota", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{
      id: "user-1",
      email: "user@example.com",
      name: "Test User",
      password_hash: "hash",
      is_admin: false,
      status: "active",
      suspended_until: null,
    }] }) };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client as never));

    const user = await activateUser("user-1");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(client, "personal:user-1");
    expect(user?.status).toBe("active");
  });

  it("does not expose a half-reactivated user when quota resume fails", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        password_hash: "hash",
        is_admin: false,
        status: "suspended",
        suspended_until: "2026-01-01T00:00:00.000Z",
        email_verified_at: "2025-01-01T00:00:00.000Z",
        account_id: "personal:user-1",
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "user-1", status: "active", suspended_until: null }] }),
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client as never));
    mockResumeAccountEntitlementsWithClient.mockRejectedValueOnce(new Error("quota unavailable"));

    await expect(getUserByEmail("user@example.com")).rejects.toThrow("quota unavailable");
  });
});
