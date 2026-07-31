import { withClient } from "../db";
import { routeModeSchema, type RouteMode } from "@firecrawl/contracts";

export const VALID_ROUTE_MODES = routeModeSchema.options;

export type { RouteMode };

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

const CACHE_TTL_MS = 5000;

interface CacheEntry {
  value: SettingRecord | null;
  expiresAt: number;
}

const settingsCache = new Map<string, CacheEntry>();
const inFlightSettings = new Map<string, Promise<SettingRecord | null>>();

export function clearSettingsCache(): void {
  settingsCache.clear();
  inFlightSettings.clear();
}

function getCachedSetting(key: string): SettingRecord | null | undefined {
  const entry = settingsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    settingsCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedSetting(key: string, value: SettingRecord | null): void {
  settingsCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function invalidateCachedSetting(key: string): void {
  settingsCache.delete(key);
  inFlightSettings.delete(key);
}

export async function getSetting(key: string): Promise<SettingRecord | null> {
  const cached = getCachedSetting(key);
  if (cached !== undefined) return cached;

  const existing = inFlightSettings.get(key);
  if (existing) return existing;

  const promise = withClient(async (client) => {
    const result = await client.query<SettingRecord>(
      "SELECT key, value, updated_at FROM settings WHERE key = $1",
      [key],
    );
    return result.rows[0] || null;
  });

  inFlightSettings.set(key, promise);

  try {
    const value = await promise;
    // Only cache if our in-flight request is still the active one. If the
    // setting was written while we were fetching, invalidateCachedSetting will
    // have removed the in-flight entry and we must not overwrite the new value.
    if (inFlightSettings.get(key) === promise) {
      setCachedSetting(key, value);
    }
    return value;
  } finally {
    if (inFlightSettings.get(key) === promise) {
      inFlightSettings.delete(key);
    }
  }
}

export async function listSettings(): Promise<SettingRecord[]> {
  return withClient(async (client) => {
    const result = await client.query<SettingRecord>(
      "SELECT key, value, updated_at FROM settings ORDER BY key",
    );
    return result.rows;
  });
}

export async function setSetting(
  key: string,
  value: string,
): Promise<SettingRecord> {
  const record = await withClient(async (client) => {
    const result = await client.query<SettingRecord>(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, value],
    );
    return result.rows[0];
  });
  invalidateCachedSetting(key);
  return record;
}

export async function deleteSetting(key: string): Promise<boolean> {
  const deleted = await withClient(async (client) => {
    const result = await client.query(
      "DELETE FROM settings WHERE key = $1",
      [key],
    );
    return result.rowCount !== null && result.rowCount > 0;
  });
  if (deleted) {
    invalidateCachedSetting(key);
  }
  return deleted;
}

export async function getDefaultRouteMode(
  fallback: RouteMode,
): Promise<RouteMode> {
  const record = await getSetting("default_route_mode");
  if (record?.value && (VALID_ROUTE_MODES as readonly string[]).includes(record.value)) {
    return record.value as RouteMode;
  }
  return fallback;
}
