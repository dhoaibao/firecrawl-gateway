import { describe, expect, it, vi } from "vitest";
import { withClient } from "../db";
import { validateApiKeyWithUser } from "./service";

vi.mock("../db", () => ({ withClient: vi.fn() }));

describe("validateApiKeyWithUser", () => {
  it("loads the API key and owner in one query", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "key-1",
        user_id: "user-1",
        name: "Production",
        key_hash: "hash",
        key_prefix: "fc_test",
        revoked: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_used_at: null,
        owner_id: "user-1",
        owner_email: "user@example.com",
        owner_name: "Test User",
        owner_password_hash: "password-hash",
        owner_is_admin: false,
        owner_status: "active",
        owner_suspended_until: null,
        owner_created_at: "2026-01-01T00:00:00.000Z",
        owner_updated_at: "2026-01-01T00:00:00.000Z",
        owner_expired_suspension: false,
      }],
    });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ query } as never));

    const result = await validateApiKeyWithUser("fc_test_key");

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      key: { id: "key-1", user_id: "user-1" },
      user: { id: "user-1", email: "user@example.com", status: "active" },
    });
  });

  it("reactivates an expired suspended owner", async () => {
    const reactivatedUser = {
      id: "user-1",
      email: "user@example.com",
      name: "Test User",
      password_hash: "password-hash",
      is_admin: false,
      status: "active",
      suspended_until: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "key-1",
        user_id: "user-1",
        name: "Production",
        key_hash: "hash",
        key_prefix: "fc_test",
        revoked: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_used_at: null,
        owner_id: "user-1",
        owner_email: "user@example.com",
        owner_name: "Test User",
        owner_password_hash: "password-hash",
        owner_is_admin: false,
        owner_status: "active",
        owner_suspended_until: null,
        owner_created_at: "2026-01-01T00:00:00.000Z",
        owner_updated_at: "2026-01-01T00:00:00.000Z",
        owner_expired_suspension: true,
      }] })
      .mockResolvedValueOnce({ rows: [reactivatedUser] });
    vi.mocked(withClient).mockImplementation(async (fn) => fn({ query } as never));

    const result = await validateApiKeyWithUser("fc_test_key");

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(
      "UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 RETURNING *",
      ["user-1"],
    );
    expect(result?.user).toEqual(reactivatedUser);
  });
});
