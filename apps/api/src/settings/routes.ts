import { Router } from "express";
import type { GatewayConfig } from "../types";
import * as settingsService from "./service";
import { VALID_ROUTE_MODES } from "./service";
import { decryptSettingValue, encryptSettingValue } from "./crypto";

const VALID_SETTINGS = [
  "firecrawl_api_keys",
  "user_inactivity_suspend_days",
  "api_key_inactivity_revoke_days",
  "default_route_mode",
  "self_hosted_firecrawl_url",
] as const;

const SETTING_TYPES: Record<string, "string" | "number" | "boolean" | "json"> = {
  firecrawl_api_keys: "json",
  user_inactivity_suspend_days: "number",
  api_key_inactivity_revoke_days: "number",
  default_route_mode: "string",
  self_hosted_firecrawl_url: "string",
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

export function createSettingsRouter(config: GatewayConfig) {
  const router = Router();

  router.get("/credit-usage", async (_req, res, next) => {
    try {
      const items = await fetchCreditUsage(config);
      res.json({ data: items });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (_req, res, next) => {
    try {
      const rows = await settingsService.listSettings();
      const settings: Record<string, unknown> = {};
      for (const row of rows) {
        const value = row.key === "firecrawl_api_keys"
          ? decryptSettingValue(row.value, config.firecrawlKeysEncryptionKey)
          : { value: row.value, encrypted: false };
        settings[row.key] = parseValue(value.value, SETTING_TYPES[row.key] || "string");
        if (row.key === "firecrawl_api_keys" && !value.encrypted) {
          await settingsService.setSetting(row.key, encryptSettingValue(row.value, config.firecrawlKeysEncryptionKey));
        }
      }
      res.json({ data: settings });
    } catch (error) {
      next(error);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        res.status(400).json({ success: false, error: "Expected JSON object with settings" });
        return;
      }

      const result: Record<string, unknown> = {};
      for (const [key, rawValue] of Object.entries(updates)) {
        if (!VALID_SETTINGS.includes(key as typeof VALID_SETTINGS[number])) {
          res.status(400).json({ success: false, error: `Invalid setting key: ${key}` });
          return;
        }

        const type = SETTING_TYPES[key] || "string";
        let value: string;

        if (key === "default_route_mode") {
          if (
            typeof rawValue !== "string" ||
            !(VALID_ROUTE_MODES as readonly string[]).includes(rawValue)
          ) {
            res.status(400).json({
              success: false,
              error: `${key} must be one of ${VALID_ROUTE_MODES.join(", ")}`,
            });
            return;
          }
          value = rawValue;
        } else if (key === "self_hosted_firecrawl_url") {
          const rawUrl = String(rawValue).trim();
          if (!rawUrl) {
            value = "";
          } else {
            try {
              const url = new URL(rawUrl);
              if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("invalid URL");
              value = url.toString().replace(/\/+$/, "");
            } catch {
              res.status(400).json({ success: false, error: `${key} must be a valid HTTP(S) URL` });
              return;
            }
          }
        } else if (type === "json") {
          if (key === "firecrawl_api_keys") {
            if (!Array.isArray(rawValue)) {
              res.status(400).json({ success: false, error: `${key} must be an array of API keys` });
              return;
            }
            if (rawValue.length > MAX_CLOUD_API_KEYS) {
              res.status(400).json({ success: false, error: `${key} may contain at most ${MAX_CLOUD_API_KEYS} keys` });
              return;
            }
            for (const k of rawValue) {
              if (typeof k !== "string" || k.length < MIN_API_KEY_LENGTH) {
                res.status(400).json({ success: false, error: `${key} must be an array of API key strings with at least ${MIN_API_KEY_LENGTH} characters` });
                return;
              }
            }
          }
          value = JSON.stringify(rawValue);
          if (key === "firecrawl_api_keys") {
            value = encryptSettingValue(value, config.firecrawlKeysEncryptionKey);
          }
        } else if (type === "boolean") {
          value = String(rawValue === true || rawValue === "true");
        } else if (type === "number") {
          const num = Number(rawValue);
          if (!Number.isFinite(num) || num < 0) {
            res.status(400).json({ success: false, error: `${key} must be a non-negative number` });
            return;
          }
          value = String(num);
        } else {
          value = String(rawValue);
        }

        await settingsService.setSetting(key, value);
        const responseValue = key === "firecrawl_api_keys"
          ? JSON.stringify(rawValue)
          : value;
        result[key] = parseValue(responseValue, type);
      }

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseValue(value: string, type: string): unknown {
  if (type === "json") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (type === "boolean") {
    return value === "true";
  }
  if (type === "number") {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }
  return value;
}

async function fetchCreditUsage(config: GatewayConfig): Promise<CreditUsageItem[]> {
  const keys = await getFirecrawlApiKeys(config);

  return Promise.all(
    keys.map((apiKey, keyIndex) =>
      fetchCreditUsageForKey(config.cloudBaseUrl, keyIndex, apiKey),
    ),
  );
}

async function getFirecrawlApiKeys(config: GatewayConfig): Promise<string[]> {
  const record = await settingsService.getSetting("firecrawl_api_keys");
  if (!record?.value) return [];
  try {
    const decrypted = decryptSettingValue(record.value, config.firecrawlKeysEncryptionKey);
    if (!decrypted.encrypted) {
      await settingsService.setSetting(
        "firecrawl_api_keys",
        encryptSettingValue(record.value, config.firecrawlKeysEncryptionKey),
      );
    }
    const parsed = JSON.parse(decrypted.value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string" && k.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function fetchCreditUsageForKey(
  cloudBaseUrl: string,
  keyIndex: number,
  apiKey: string,
): Promise<CreditUsageItem> {
  const keyPrefix = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${cloudBaseUrl}/v2/team/credit-usage`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        keyIndex,
        keyPrefix,
        remainingCredits: null,
        planCredits: null,
        billingPeriodStart: null,
        billingPeriodEnd: null,
        error: `HTTP ${response.status}: ${body || response.statusText}`,
      };
    }

    const json = (await response.json()) as {
      data?: {
        remainingCredits?: number;
        planCredits?: number;
        billingPeriodStart?: string | null;
        billingPeriodEnd?: string | null;
      };
    };

    return {
      keyIndex,
      keyPrefix,
      remainingCredits: json.data?.remainingCredits ?? null,
      planCredits: json.data?.planCredits ?? null,
      billingPeriodStart: json.data?.billingPeriodStart ?? null,
      billingPeriodEnd: json.data?.billingPeriodEnd ?? null,
    };
  } catch (error) {
    return {
      keyIndex,
      keyPrefix,
      remainingCredits: null,
      planCredits: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      error: (error as Error).message,
    };
  }
}

