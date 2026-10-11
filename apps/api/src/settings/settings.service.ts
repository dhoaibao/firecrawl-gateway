import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { VALID_ROUTE_MODES, type RouteMode } from "../proxy/policy";

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

export function parseRouteMode(setting: SettingRecord | null, fallback: RouteMode): RouteMode {
  return setting && (VALID_ROUTE_MODES as readonly string[]).includes(setting.value)
    ? (setting.value as RouteMode)
    : fallback;
}

function toRecord(row: { key: string; value: string; updatedAt: Date }): SettingRecord {
  return { key: row.key, value: row.value, updated_at: row.updatedAt.toISOString() };
}

@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, { value: SettingRecord | null; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<SettingRecord | null>>();
  private readonly ttl = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async getSetting(key: string): Promise<SettingRecord | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.cache.delete(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const request = this.prisma.setting
      .findUnique({ where: { key } })
      .then((row) => (row ? toRecord(row) : null));
    return this.track(key, request);
  }

  /** Reads several settings, fetching all cache misses in a single query. */
  async getSettings<K extends string>(
    keys: readonly K[],
  ): Promise<Record<K, SettingRecord | null>> {
    const now = Date.now();
    const missing: K[] = [];
    const lookups: Promise<[K, SettingRecord | null]>[] = [];
    for (const key of new Set(keys)) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > now) {
        lookups.push(Promise.resolve([key, cached.value]));
        continue;
      }
      this.cache.delete(key);
      const existing = this.inflight.get(key);
      if (existing) lookups.push(existing.then((value): [K, SettingRecord | null] => [key, value]));
      else missing.push(key);
    }
    if (missing.length) {
      const batch = this.prisma.setting
        .findMany({ where: { key: { in: missing } } })
        .then((rows) => new Map(rows.map((row) => [row.key, toRecord(row)])));
      for (const key of missing) {
        const request = batch.then((rows) => rows.get(key) ?? null);
        lookups.push(
          this.track(key, request).then((value): [K, SettingRecord | null] => [key, value]),
        );
      }
    }
    return Object.fromEntries(await Promise.all(lookups)) as Record<K, SettingRecord | null>;
  }

  private async track(key: string, request: Promise<SettingRecord | null>) {
    this.inflight.set(key, request);
    try {
      const value = await request;
      if (this.inflight.get(key) === request)
        this.cache.set(key, { value, expiresAt: Date.now() + this.ttl });
      return value;
    } finally {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    }
  }

  async listSettings(): Promise<SettingRecord[]> {
    const rows = await this.prisma.setting.findMany({ orderBy: { key: "asc" } });
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updated_at: row.updatedAt.toISOString(),
    }));
  }

  async setSetting(key: string, value: string): Promise<SettingRecord> {
    const row = await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.cache.delete(key);
    this.inflight.delete(key);
    return { key: row.key, value: row.value, updated_at: row.updatedAt.toISOString() };
  }

  /** Updates a setting only if it still holds `expected`; returns whether it changed. */
  async replaceSettingIfUnchanged(key: string, expected: string, value: string): Promise<boolean> {
    const { count } = await this.prisma.setting.updateMany({
      where: { key, value: expected },
      data: { value },
    });
    this.cache.delete(key);
    this.inflight.delete(key);
    return count > 0;
  }

  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
