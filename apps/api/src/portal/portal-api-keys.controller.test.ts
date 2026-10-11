import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { UserApiKeyLimitError } from "../api-keys/api-keys.service";
import { PortalApiKeysController } from "./portal-api-keys.controller";
import { PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE, PORTAL_MAX_API_KEYS } from "./portal-limits";

const request = { user: { id: "user-1" } } as never;

const record = {
  id: "k1",
  name: "CI",
  key_hash: "hash",
  key_value: null,
  key_prefix: "fc_abcde",
  revoked: false,
  created_at: "2026-10-12T00:00:00.000Z",
  updated_at: "2026-10-12T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  rate_limit_per_minute: 120,
  monthly_quota: null,
  user_id: "user-1",
  owner_active: true,
};

async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe("PortalApiKeysController", () => {
  it("lists the user's keys without hashes or stored values", async () => {
    const keys = { listUserApiKeys: vi.fn().mockResolvedValue([record]) };
    const controller = new PortalApiKeysController(keys as never);

    const result = await controller.list(request);

    expect(keys.listUserApiKeys).toHaveBeenCalledWith("user-1");
    expect(result.data[0]).toEqual({
      id: "k1",
      name: "CI",
      key_prefix: "fc_abcde",
      created_at: record.created_at,
      last_used_at: null,
      expires_at: null,
      rate_limit_per_minute: 120,
    });
    expect(result.limits).toEqual({
      max_keys: PORTAL_MAX_API_KEYS,
      rate_limit_per_minute: PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
    });
  });

  it("creates a key with the portal defaults and returns the plaintext once", async () => {
    const keys = {
      createUserApiKey: vi.fn().mockResolvedValue({ ...record, key: "fc_secret_value" }),
    };
    const controller = new PortalApiKeysController(keys as never);

    const result = await controller.create(request, { name: "  CI  " });

    expect(keys.createUserApiKey).toHaveBeenCalledWith("user-1", "CI", {
      maxKeys: PORTAL_MAX_API_KEYS,
      rateLimitPerMinute: PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
      expiresAt: null,
    });
    expect(result.data.key).toBe("fc_secret_value");
    expect(result.data).not.toHaveProperty("key_hash");
    expect(result.data).not.toHaveProperty("user_id");
  });

  it("rejects bad input and a past expiry, and maps the cap to 409", async () => {
    const keys = { createUserApiKey: vi.fn() };
    const controller = new PortalApiKeysController(keys as never);

    expect(await status(controller.create(request, {}))).toBe(400);
    expect(await status(controller.create(request, { name: "x".repeat(101) }))).toBe(400);
    expect(
      await status(controller.create(request, { name: "ok", expires_at: "2000-01-01T00:00:00Z" })),
    ).toBe(400);
    expect(await status(controller.create(request, { name: "ok", expires_at: 5 }))).toBe(400);
    expect(keys.createUserApiKey).not.toHaveBeenCalled();

    keys.createUserApiKey.mockRejectedValueOnce(new UserApiKeyLimitError(PORTAL_MAX_API_KEYS));
    expect(await status(controller.create(request, { name: "ok" }))).toBe(409);
  });

  it("answers 404 for a key that is not the caller's", async () => {
    const keys = { revokeUserApiKey: vi.fn().mockResolvedValue(null) };
    const controller = new PortalApiKeysController(keys as never);

    expect(await status(controller.revoke(request, "other"))).toBe(404);
    expect(keys.revokeUserApiKey).toHaveBeenCalledWith("user-1", "other");
  });
});
