import { Body, Controller, Get, Inject, Logger, Put, UseGuards } from "@nestjs/common";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import { apiError } from "../common/http";
import { AuthGuard } from "../auth/guards";
import { VALID_ROUTE_MODES } from "../proxy/policy";
import { SettingsService } from "./settings.service";
import type { CloudKeyEntry } from "../common/types";
import { loadCloudApiKeys, parseCloudKeyEntries, serializeCloudKeyEntries } from "./cloud-keys";
import { creditKeyPrefix, CreditRoutingService } from "../credits/credit-routing.service";

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
  private readonly logger = new Logger(SettingsController.name);

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
      data[row.key] =
        row.key === "firecrawl_api_keys"
          ? keyEntriesOrRaw(value.value)
          : parseValue(value.value, SETTING_TYPES[row.key] || "string");
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
      let echoed: unknown;
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
        const entries = (rawValue as unknown[]).map(toKeyEntry);
        if (entries.some((entry) => !entry))
          apiError(
            400,
            `${key} must be an array of API key strings, or { key, role } objects with role "cloud" or "fallback", of at least ${MIN_API_KEY_LENGTH} characters`,
          );
        value = encryptSettingValue(
          serializeCloudKeyEntries(entries as CloudKeyEntry[]),
          this.config.firecrawlKeysEncryptionKey,
        );
        // The stored value is encrypted, so echo the normalized entries instead.
        echoed = entries;
      } else if (type === "number") {
        const number = Number(rawValue);
        if (!Number.isFinite(number) || number < 0)
          apiError(400, `${key} must be a non-negative number`);
        value = String(number);
      } else value = String(rawValue);
      await this.settings.setSetting(key, value);
      result[key] = echoed ?? parseValue(value, type);
    }
    return { data: result };
  }

  private async fetchCreditUsage(): Promise<CreditUsageItem[]> {
    const record = await this.settings.getSetting("firecrawl_api_keys");
    if (!record?.value) return [];
    let keys: string[];
    try {
      keys = await loadCloudApiKeys(record, this.config.firecrawlKeysEncryptionKey, this.settings);
    } catch (error) {
      // Only the error class is logged: a JSON parse message can quote the key material.
      this.logger.warn(
        `Could not load the Firecrawl Cloud API keys (${(error as Error).name}); ` +
          "check FIRECRAWL_KEYS_ENCRYPTION_KEY and the stored firecrawl_api_keys setting",
      );
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

/** A plain string is a `cloud` key; an object may carry a `fallback` role. Null when malformed. */
function toKeyEntry(item: unknown): CloudKeyEntry | null {
  const entry =
    typeof item === "string"
      ? { key: item, role: "cloud" }
      : item && typeof item === "object"
        ? (item as { key?: unknown; role?: unknown })
        : null;
  if (!entry || typeof entry.key !== "string" || entry.key.length < MIN_API_KEY_LENGTH) return null;
  const role = entry.role ?? "cloud";
  return role === "cloud" || role === "fallback" ? { key: entry.key, role } : null;
}

/** Normalized key entries for the admin UI; the raw value when it is not parseable JSON. */
function keyEntriesOrRaw(value: string): unknown {
  try {
    return parseCloudKeyEntries(value);
  } catch {
    return value;
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
