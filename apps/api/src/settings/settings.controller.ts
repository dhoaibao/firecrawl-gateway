import { Body, Controller, Get, Inject, Put, UseGuards } from "@nestjs/common";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import { apiError } from "../common/http";
import { AuthGuard } from "../auth/guards";
import { SettingsService, VALID_ROUTE_MODES } from "./settings.service";
import {
  creditKeyPrefix,
  parseCreditKeys,
  CreditRoutingService,
} from "../credits/credit-routing.service";

const VALID_SETTINGS = [
  "firecrawl_api_keys",
  "api_key_inactivity_revoke_days",
  "default_route_mode",
] as const;
const SETTING_TYPES: Record<string, "string" | "number" | "json"> = {
  firecrawl_api_keys: "json",
  api_key_inactivity_revoke_days: "number",
  default_route_mode: "string",
};
const MAX_CLOUD_API_KEYS = 10;
const MIN_API_KEY_LENGTH = 8;
export interface CreditUsageItem {
  keyIndex: number;
  keyPrefix: string;
  remainingCredits: number | null;
  planCredits: number | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  error?: string;
}

@Controller("admin/api/settings")
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly credits: CreditRoutingService,
  ) {}

  @Get("credit-usage")
  async creditUsage() {
    return { data: await this.fetchCreditUsage() };
  }

  @Get()
  async list() {
    const rows = await this.settings.listSettings();
    const data: Record<string, unknown> = {};
    for (const row of rows) {
      const value =
        row.key === "firecrawl_api_keys"
          ? decryptSettingValue(row.value, this.config.firecrawlKeysEncryptionKey)
          : { value: row.value, encrypted: false };
      data[row.key] = parseValue(value.value, SETTING_TYPES[row.key] || "string");
      if (row.key === "firecrawl_api_keys" && !value.encrypted)
        await this.settings.replaceSettingIfUnchanged(
          row.key,
          row.value,
          encryptSettingValue(row.value, this.config.firecrawlKeysEncryptionKey),
        );
    }
    return { data };
  }

  @Put()
  async update(@Body() updates: unknown) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates))
      apiError(400, "Expected JSON object with settings");
    const result: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(updates as Record<string, unknown>)) {
      if (!VALID_SETTINGS.includes(key as (typeof VALID_SETTINGS)[number]))
        apiError(400, `Invalid setting key: ${key}`);
      const type = SETTING_TYPES[key] || "string";
      let value: string;
      if (key === "default_route_mode") {
        if (
          typeof rawValue !== "string" ||
          !(VALID_ROUTE_MODES as readonly string[]).includes(rawValue)
        )
          apiError(400, `${key} must be one of ${VALID_ROUTE_MODES.join(", ")}`);
        value = rawValue;
      } else if (type === "json") {
        if (!Array.isArray(rawValue)) apiError(400, `${key} must be an array of API keys`);
        if ((rawValue as unknown[]).length > MAX_CLOUD_API_KEYS)
          apiError(400, `${key} may contain at most ${MAX_CLOUD_API_KEYS} keys`);
        if (
          (rawValue as unknown[]).some(
            (item) => typeof item !== "string" || item.length < MIN_API_KEY_LENGTH,
          )
        )
          apiError(
            400,
            `${key} must be an array of API key strings with at least ${MIN_API_KEY_LENGTH} characters`,
          );
        value = JSON.stringify(rawValue);
        if (key === "firecrawl_api_keys")
          value = encryptSettingValue(value, this.config.firecrawlKeysEncryptionKey);
      } else if (type === "number") {
        const number = Number(rawValue);
        if (!Number.isFinite(number) || number < 0)
          apiError(400, `${key} must be a non-negative number`);
        value = String(number);
      } else value = String(rawValue);
      await this.settings.setSetting(key, value);
      result[key] = parseValue(
        key === "firecrawl_api_keys" ? JSON.stringify(rawValue) : value,
        type,
      );
    }
    return { data: result };
  }

  private async fetchCreditUsage(): Promise<CreditUsageItem[]> {
    const record = await this.settings.getSetting("firecrawl_api_keys");
    if (!record?.value) return [];
    let keys: string[];
    try {
      const parsed = parseCreditKeys(record.value, this.config.firecrawlKeysEncryptionKey);
      keys = parsed.keys;
      if (!parsed.encrypted)
        await this.settings.replaceSettingIfUnchanged(
          record.key,
          record.value,
          encryptSettingValue(record.value, this.config.firecrawlKeysEncryptionKey),
        );
    } catch {
      return [];
    }
    const details = await this.credits.refreshCreditUsageForKeys(keys);
    return details.map((item, index) => ({
      keyIndex: index,
      keyPrefix: creditKeyPrefix(keys[index]),
      ...item,
    }));
  }
}

function parseValue(value: string, type: string): unknown {
  if (type === "json") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}
