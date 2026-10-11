import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsController } from "./settings.controller";
import { decryptSettingValue, encryptSettingValue, generateEncryptionKey } from "../common/crypto";

const encryptionKey = generateEncryptionKey();
const config = {
  cloudBaseUrl: "https://api.firecrawl.dev",
  firecrawlKeysEncryptionKey: encryptionKey,
};

describe("SettingsController creditUsage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates authoritative refresh to the shared credit service and maps key metadata", async () => {
    const rawKeys = ["fc_test_key_1234567890abcdef"];
    const encrypted = encryptSettingValue(JSON.stringify(rawKeys), encryptionKey);
    const settings = {
      getSetting: vi.fn().mockResolvedValue({ key: "firecrawl_api_keys", value: encrypted }),
      setSetting: vi.fn().mockResolvedValue(undefined),
    };
    const credits = {
      refreshCreditUsageForKeys: vi.fn().mockResolvedValue([
        {
          remainingCredits: 500,
          planCredits: 1000,
          billingPeriodStart: "2026-08-01T00:00:00Z",
          billingPeriodEnd: "2026-09-01T00:00:00Z",
        },
      ]),
    };

    const controller = new SettingsController(settings as never, config as never, credits as never);
    await expect(controller.creditUsage()).resolves.toEqual({
      data: [
        {
          keyIndex: 0,
          keyPrefix: "fc_test_...cdef",
          remainingCredits: 500,
          planCredits: 1000,
          billingPeriodStart: "2026-08-01T00:00:00Z",
          billingPeriodEnd: "2026-09-01T00:00:00Z",
        },
      ],
    });
    expect(credits.refreshCreditUsageForKeys).toHaveBeenCalledWith(rawKeys);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("encrypts a legacy plaintext key setting before refreshing it", async () => {
    const rawKeys = ["fc_test_key_1234567890abcdef"];
    const settings = {
      getSetting: vi
        .fn()
        .mockResolvedValue({ key: "firecrawl_api_keys", value: JSON.stringify(rawKeys) }),
      setSetting: vi.fn().mockResolvedValue(undefined),
      replaceSettingIfUnchanged: vi.fn().mockResolvedValue(true),
    };
    const credits = {
      refreshCreditUsageForKeys: vi.fn().mockResolvedValue([
        {
          remainingCredits: null,
          planCredits: null,
          billingPeriodStart: null,
          billingPeriodEnd: null,
          error: "upstream unavailable",
        },
      ]),
    };

    const controller = new SettingsController(settings as never, config as never, credits as never);
    await controller.creditUsage();

    expect(settings.replaceSettingIfUnchanged).toHaveBeenCalledWith(
      "firecrawl_api_keys",
      JSON.stringify(rawKeys),
      expect.stringMatching(/^enc:v1:/),
    );
    expect(settings.setSetting).not.toHaveBeenCalled();
    expect(credits.refreshCreditUsageForKeys).toHaveBeenCalledWith(rawKeys);
  });

  it("returns an empty list when no Firecrawl keys are configured", async () => {
    const settings = { getSetting: vi.fn().mockResolvedValue(null), setSetting: vi.fn() };
    const credits = { refreshCreditUsageForKeys: vi.fn() };
    const controller = new SettingsController(settings as never, config as never, credits as never);

    await expect(controller.creditUsage()).resolves.toEqual({ data: [] });
    expect(credits.refreshCreditUsageForKeys).not.toHaveBeenCalled();
  });
});

describe("SettingsController key roles", () => {
  const first = "fc_test_key_1234567890abcdef";
  const second = "fc_test_key_fedcba0987654321";

  it("stores fallback keys as objects and cloud keys as plain strings, then echoes entries", async () => {
    const settings = { setSetting: vi.fn().mockResolvedValue(undefined) };
    const controller = new SettingsController(settings as never, config as never, {} as never);

    const response = await controller.update({
      firecrawl_api_keys: [first, { key: second, role: "fallback" }],
    });

    expect(response.data.firecrawl_api_keys).toEqual([
      { key: first, role: "cloud" },
      { key: second, role: "fallback" },
    ]);
    const stored = settings.setSetting.mock.calls[0][1] as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(decryptSettingValue(stored, encryptionKey).value).toBe(
      JSON.stringify([first, { key: second, role: "fallback" }]),
    );
  });

  it("rejects an unknown role or a too-short key", async () => {
    const controller = new SettingsController({} as never, config as never, {} as never);

    await expect(
      controller.update({ firecrawl_api_keys: [{ key: first, role: "primary" }] }),
    ).rejects.toThrow();
    await expect(
      controller.update({ firecrawl_api_keys: [{ key: "short", role: "fallback" }] }),
    ).rejects.toThrow();
  });

  it("accepts hybrid as the default route mode", async () => {
    const settings = { setSetting: vi.fn().mockResolvedValue(undefined) };
    const controller = new SettingsController(settings as never, config as never, {} as never);

    await expect(controller.update({ default_route_mode: "hybrid" })).resolves.toEqual({
      data: { default_route_mode: "hybrid" },
    });
  });

  it("lists legacy string keys as cloud-role entries", async () => {
    const stored = encryptSettingValue(JSON.stringify([first]), encryptionKey);
    const settings = {
      listSettings: vi
        .fn()
        .mockResolvedValue([{ key: "firecrawl_api_keys", value: stored, updated_at: "" }]),
    };
    const controller = new SettingsController(settings as never, config as never, {} as never);

    await expect(controller.list()).resolves.toEqual({
      data: { firecrawl_api_keys: [{ key: first, role: "cloud" }] },
    });
  });
});

describe("SettingsController list legacy migration", () => {
  it("migrates a legacy plaintext key setting conditionally, not with an unconditional write", async () => {
    const plaintext = JSON.stringify(["fc_test_key_1234567890abcdef"]);
    const settings = {
      listSettings: vi
        .fn()
        .mockResolvedValue([{ key: "firecrawl_api_keys", value: plaintext, updated_at: "" }]),
      setSetting: vi.fn(),
      replaceSettingIfUnchanged: vi.fn().mockResolvedValue(true),
    };
    const controller = new SettingsController(settings as never, config as never, {} as never);

    await controller.list();

    expect(settings.replaceSettingIfUnchanged).toHaveBeenCalledWith(
      "firecrawl_api_keys",
      plaintext,
      expect.stringMatching(/^enc:v1:/),
    );
    expect(settings.setSetting).not.toHaveBeenCalled();
  });
});

describe("SettingsController runtime settings", () => {
  const TOKEN = "123456789:AAH_test-token_0123456789abcdef";

  function makeController(rows: Array<{ key: string; value: string }> = []) {
    const settings = {
      setSetting: vi.fn().mockResolvedValue(undefined),
      listSettings: vi.fn().mockResolvedValue(rows),
    };
    const controller = new SettingsController(settings as never, config as never, {} as never);
    return { controller, settings };
  }

  it("stores the response cache TTL and alert thresholds as validated whole numbers", async () => {
    const { controller, settings } = makeController();

    const result = await controller.update({
      response_cache_ttl_seconds: 900,
      alert_credits_low_threshold: "250",
      alert_fallback_ratio_percent: 0,
    });

    expect(settings.setSetting).toHaveBeenCalledWith("response_cache_ttl_seconds", "900");
    expect(settings.setSetting).toHaveBeenCalledWith("alert_credits_low_threshold", "250");
    expect(settings.setSetting).toHaveBeenCalledWith("alert_fallback_ratio_percent", "0");
    expect(result.data).toEqual({
      response_cache_ttl_seconds: 900,
      alert_credits_low_threshold: 250,
      alert_fallback_ratio_percent: 0,
    });
  });

  it.each([
    ["response_cache_ttl_seconds", 86_401],
    ["response_cache_ttl_seconds", -1],
    ["response_cache_ttl_seconds", 1.5],
    ["alert_fallback_ratio_percent", 101],
    ["alert_credits_low_threshold", "abc"],
    ["alert_credits_low_threshold", ""],
    ["alert_credits_low_threshold", 1_000_000_001],
  ])("rejects %s = %j", async (key, value) => {
    const { controller, settings } = makeController();

    await expect(controller.update({ [key]: value })).rejects.toMatchObject({ status: 400 });
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("encrypts the Telegram bot token at rest and never echoes it back", async () => {
    const { controller, settings } = makeController();

    const result = await controller.update({ telegram_bot_token: ` ${TOKEN} ` });

    const [key, stored] = settings.setSetting.mock.calls[0] as [string, string];
    expect(key).toBe("telegram_bot_token");
    expect(stored).not.toContain(TOKEN);
    expect(decryptSettingValue(stored, encryptionKey).value).toBe(TOKEN);
    expect(result.data.telegram_bot_token).toBe("123456789:••••••••");
    expect(JSON.stringify(result)).not.toContain("AAH_test");
  });

  it("clears the token and the chat id with an empty string", async () => {
    const { controller, settings } = makeController();

    const result = await controller.update({ telegram_bot_token: "", telegram_chat_id: "  " });

    expect(settings.setSetting).toHaveBeenCalledWith("telegram_bot_token", "");
    expect(settings.setSetting).toHaveBeenCalledWith("telegram_chat_id", "");
    expect(result.data).toEqual({ telegram_bot_token: "", telegram_chat_id: "" });
  });

  it.each([
    ["telegram_bot_token", "not-a-token"],
    ["telegram_bot_token", "123456789:••••••••"],
    ["telegram_bot_token", 12345],
    ["telegram_chat_id", "my chat; DROP"],
    ["telegram_chat_id", "@x"],
    ["telegram_chat_id", 42],
  ])("rejects %s = %j", async (key, value) => {
    const { controller, settings } = makeController();

    await expect(controller.update({ [key]: value })).rejects.toMatchObject({ status: 400 });
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("writes nothing when a later field in the same payload is invalid", async () => {
    const { controller, settings } = makeController();

    await expect(
      controller.update({
        default_route_mode: "cloud-first",
        response_cache_ttl_seconds: 900,
        telegram_chat_id: "-100123",
        telegram_bot_token: "definitely not a token",
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ["response_cache_ttl_seconds", null],
    ["response_cache_ttl_seconds", false],
    ["response_cache_ttl_seconds", true],
    ["response_cache_ttl_seconds", []],
    ["response_cache_ttl_seconds", [50]],
    ["response_cache_ttl_seconds", {}],
    ["alert_credits_low_threshold", null],
    ["alert_credits_low_threshold", [5]],
    ["alert_fallback_ratio_percent", false],
    ["alert_fallback_ratio_percent", true],
    ["api_key_inactivity_revoke_days", null],
    ["api_key_inactivity_revoke_days", false],
    ["api_key_inactivity_revoke_days", [7]],
  ])("rejects non-number JSON for %s = %j instead of coercing it", async (key, value) => {
    const { controller, settings } = makeController();

    await expect(controller.update({ [key]: value })).rejects.toMatchObject({ status: 400 });
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("still accepts plain numeric strings and numbers", async () => {
    const { controller, settings } = makeController();

    await controller.update({
      response_cache_ttl_seconds: "900",
      api_key_inactivity_revoke_days: 30,
    });

    expect(settings.setSetting).toHaveBeenCalledWith("response_cache_ttl_seconds", "900");
    expect(settings.setSetting).toHaveBeenCalledWith("api_key_inactivity_revoke_days", "30");
  });

  it("accepts a numeric or @channel chat id", async () => {
    const { controller, settings } = makeController();

    await controller.update({ telegram_chat_id: "-1001234567890" });
    await controller.update({ telegram_chat_id: "@my_alert_channel" });

    expect(settings.setSetting).toHaveBeenNthCalledWith(1, "telegram_chat_id", "-1001234567890");
    expect(settings.setSetting).toHaveBeenNthCalledWith(2, "telegram_chat_id", "@my_alert_channel");
  });

  it("lists the bot token masked, and empty when unset or unreadable", async () => {
    const { controller } = makeController([
      { key: "telegram_bot_token", value: encryptSettingValue(TOKEN, encryptionKey) },
      { key: "telegram_chat_id", value: "-100123" },
      { key: "response_cache_ttl_seconds", value: "600" },
    ]);
    const unreadable = makeController([
      { key: "telegram_bot_token", value: encryptSettingValue(TOKEN, "f".repeat(64)) },
    ]);
    const unset = makeController([{ key: "telegram_bot_token", value: "" }]);

    const listed = await controller.list();

    expect(listed.data).toEqual({
      telegram_bot_token: "123456789:••••••••",
      telegram_chat_id: "-100123",
      response_cache_ttl_seconds: 600,
    });
    expect(JSON.stringify(listed)).not.toContain("AAH_test");
    expect((await unreadable.controller.list()).data.telegram_bot_token).toBe("");
    expect((await unset.controller.list()).data.telegram_bot_token).toBe("");
  });
});
