import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsController } from "./settings.controller";
import { encryptSettingValue, generateEncryptionKey } from "../common/crypto";

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
