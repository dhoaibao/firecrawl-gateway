import { routeModeSchema, type RouteMode } from "@firecrawl/contracts";
import { getPrisma } from "../infrastructure/database";

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

function mapSetting(setting: { key: string; value: string; updatedAt: Date }): SettingRecord {
  return {
    key: setting.key,
    value: setting.value,
    updated_at: setting.updatedAt.toISOString(),
  };
}

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

  const promise = getPrisma().runtime.setting.findUnique({ where: { key } })
    .then((setting) => setting ? mapSetting(setting) : null);

  inFlightSettings.set(key, promise);

  try {
    const value = await promise;
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
  const settings = await getPrisma().runtime.setting.findMany({ orderBy: { key: "asc" } });
  return settings.map(mapSetting);
}

export async function setSetting(key: string, value: string): Promise<SettingRecord> {
  const setting = await getPrisma().runtime.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value, updatedAt: new Date() },
  });
  invalidateCachedSetting(key);
  return mapSetting(setting);
}

export async function deleteSetting(key: string): Promise<boolean> {
  const result = await getPrisma().runtime.setting.deleteMany({ where: { key } });
  if (result.count > 0) invalidateCachedSetting(key);
  return result.count > 0;
}

export async function getDefaultRouteMode(fallback: RouteMode): Promise<RouteMode> {
  const record = await getSetting("default_route_mode");
  if (record?.value && (VALID_ROUTE_MODES as readonly string[]).includes(record.value)) {
    return record.value as RouteMode;
  }
  return fallback;
}
