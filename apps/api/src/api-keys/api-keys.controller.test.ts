import { describe, expect, it, vi } from "vitest";
import { ApiKeysController } from "./api-keys.controller";

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    name: "production",
    key_hash: "secret-hash",
    key_value: "encrypted-secret",
    key_prefix: "fc_test",
    revoked: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

describe("ApiKeysController", () => {
  it("sanitizes list, read, and revoke responses", async () => {
    const key = record({ key: "legacy-secret" });
    const keys = {
      listApiKeys: vi.fn().mockResolvedValue([key]),
      quotaUsage: vi.fn().mockResolvedValue(new Map()),
      getApiKeyById: vi.fn().mockResolvedValue(key),
      revokeApiKey: vi.fn().mockResolvedValue(record({ revoked: true })),
    };
    const controller = new ApiKeysController(keys as never);

    const responses = [
      (await controller.list()).data[0],
      (await controller.get("key-1")).data,
      (await controller.revoke("key-1")).data,
    ];

    for (const response of responses) {
      expect(response).toEqual(
        expect.objectContaining({ id: "key-1", name: "production", key_prefix: "fc_test" }),
      );
      expect(response).not.toHaveProperty("key");
      expect(response).not.toHaveProperty("key_value");
      expect(response).not.toHaveProperty("key_hash");
    }
  });

  it("returns plaintext only from key creation", async () => {
    const created = { ...record(), key: "fc_one-time-secret" };
    const keys = {
      createApiKey: vi.fn().mockResolvedValue(created),
    };
    const controller = new ApiKeysController(keys as never);

    await expect(controller.create({ name: "production" })).resolves.toEqual({ data: created });
    expect(keys.createApiKey).toHaveBeenCalledWith("production", {
      expiresAt: undefined,
      rateLimitPerMinute: undefined,
      monthlyQuota: undefined,
    });
  });

  it("reports this month's quota usage only for keys that have a quota", async () => {
    const keys = {
      listApiKeys: vi
        .fn()
        .mockResolvedValue([
          record({ id: "with-quota", monthly_quota: 1000 }),
          record({ id: "unused-quota", monthly_quota: 500 }),
          record({ id: "no-quota", monthly_quota: null }),
        ]),
      quotaUsage: vi.fn().mockResolvedValue(new Map([["with-quota", 120]])),
    };
    const controller = new ApiKeysController(keys as never);

    const { data } = await controller.list();

    expect(data.map((key) => [key.id, key.quota_used])).toEqual([
      ["with-quota", 120],
      ["unused-quota", 0],
      ["no-quota", null],
    ]);
    expect(data[0]).not.toHaveProperty("key_hash");
  });

  describe("per-key limits", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();

    it("creates a key with an expiry and a rate limit", async () => {
      const keys = { createApiKey: vi.fn().mockResolvedValue({ ...record(), key: "fc_x" }) };
      const controller = new ApiKeysController(keys as never);

      await controller.create({
        name: "partner",
        expires_at: future,
        rate_limit_per_minute: 60,
      });

      expect(keys.createApiKey).toHaveBeenCalledWith("partner", {
        expiresAt: new Date(future),
        rateLimitPerMinute: 60,
      });
    });

    it.each([
      [{ expires_at: "not-a-date" }, /valid ISO timestamp/],
      [{ expires_at: new Date(Date.now() - 1000).toISOString() }, /in the future/],
      [{ expires_at: 12345 }, /ISO timestamp or null/],
      [{ rate_limit_per_minute: 0 }, /between 1 and/],
      [{ rate_limit_per_minute: 1.5 }, /between 1 and/],
      [{ rate_limit_per_minute: "60" }, /between 1 and/],
      [{ rate_limit_per_minute: 100_001 }, /between 1 and/],
      [{ monthly_quota: 0 }, /monthly_quota must be an integer/],
      [{ monthly_quota: 2.5 }, /monthly_quota must be an integer/],
      [{ monthly_quota: "1000" }, /monthly_quota must be an integer/],
      [{ monthly_quota: 100_000_001 }, /monthly_quota must be an integer/],
    ])("rejects invalid limits %j on create and update", async (body, message) => {
      const keys = {
        createApiKey: vi.fn(),
        updateApiKeyLimits: vi.fn(),
      };
      const controller = new ApiKeysController(keys as never);

      await expect(controller.create({ name: "k", ...body })).rejects.toMatchObject({
        status: 400,
        response: { error: expect.stringMatching(message) },
      });
      await expect(controller.update("key-1", body)).rejects.toMatchObject({ status: 400 });
      expect(keys.createApiKey).not.toHaveBeenCalled();
      expect(keys.updateApiKeyLimits).not.toHaveBeenCalled();
    });

    it("updates, clears, and leaves limits unchanged independently", async () => {
      const keys = {
        updateApiKeyLimits: vi.fn().mockResolvedValue(record({ rate_limit_per_minute: 10 })),
      };
      const controller = new ApiKeysController(keys as never);

      const response = await controller.update("key-1", {
        expires_at: null,
        rate_limit_per_minute: 10,
      });
      await controller.update("key-1", { rate_limit_per_minute: null });

      expect(keys.updateApiKeyLimits).toHaveBeenNthCalledWith(1, "key-1", {
        expiresAt: null,
        rateLimitPerMinute: 10,
        monthlyQuota: undefined,
      });
      expect(keys.updateApiKeyLimits).toHaveBeenNthCalledWith(2, "key-1", {
        expiresAt: undefined,
        rateLimitPerMinute: null,
        monthlyQuota: undefined,
      });

      await controller.update("key-1", { monthly_quota: 5000 });
      expect(keys.updateApiKeyLimits).toHaveBeenNthCalledWith(3, "key-1", {
        expiresAt: undefined,
        rateLimitPerMinute: undefined,
        monthlyQuota: 5000,
      });
      expect(response.data).not.toHaveProperty("key_hash");
      expect(response.data).not.toHaveProperty("key_value");
    });

    it("requires at least one field and reports unknown keys", async () => {
      const keys = { updateApiKeyLimits: vi.fn().mockResolvedValue(null) };
      const controller = new ApiKeysController(keys as never);

      await expect(controller.update("key-1", {})).rejects.toMatchObject({ status: 400 });
      await expect(
        controller.update("missing", { rate_limit_per_minute: 5 }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
