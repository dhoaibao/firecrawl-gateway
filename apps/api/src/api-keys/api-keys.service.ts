import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { encryptSettingValue } from "../common/crypto";
import { RateLimitCounter } from "../common/rate-limit-counter";
import { effectiveLimits } from "../users/user-limits";
import { lockUser, UserInactiveError } from "../users/user-lock";

const API_KEY_VALIDATION_CACHE_TTL_MS = 30_000;

export { UserInactiveError };

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  key_value: string | null;
  key_prefix: string;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  /** ISO timestamp after which the key is rejected; null means it never expires. */
  expires_at: string | null;
  /** Requests per minute allowed for this key; null means no per-key limit. */
  rate_limit_per_minute: number | null;
  /** Requests allowed per calendar month (UTC); null means no quota. */
  monthly_quota: number | null;
  /** The portal user who owns the key; null for global keys created by the admin. */
  user_id: string | null;
  /**
   * False when the key belongs to a user who is suspended, deleted or missing. Such a
   * key is still recognised (so callers can reject it rather than treat it as an
   * anonymous request); global keys are always active.
   */
  owner_active: boolean;
}

/** Optional per-key limits; `null` clears a limit, `undefined` leaves it unchanged. */
export interface ApiKeyLimits {
  expiresAt?: Date | null;
  rateLimitPerMinute?: number | null;
  monthlyQuota?: number | null;
}

export interface ApiKeyRateLimitResult {
  limit: number;
  remaining: number;
  /** Unix milliseconds at which the current window ends. */
  resetAt: number;
  exceeded: boolean;
}

/** Whether the key's expiry has passed. Checked per request, never cached. */
export function isApiKeyExpired(key: Pick<ApiKeyRecord, "expires_at">, now = Date.now()): boolean {
  return Boolean(key.expires_at) && Date.parse(key.expires_at as string) <= now;
}

function toKey(key: {
  id: string;
  name: string;
  keyHash: string;
  keyValue: string | null;
  keyPrefix: string;
  revoked: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  expiresAt?: Date | null;
  rateLimitPerMinute?: number | null;
  monthlyQuota?: number | null;
  userId?: string | null;
}): ApiKeyRecord {
  return {
    id: key.id,
    name: key.name,
    key_hash: key.keyHash,
    key_value: key.keyValue,
    key_prefix: key.keyPrefix,
    revoked: key.revoked,
    created_at: key.createdAt.toISOString(),
    updated_at: key.updatedAt.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    expires_at: key.expiresAt?.toISOString() ?? null,
    rate_limit_per_minute: key.rateLimitPerMinute ?? null,
    monthly_quota: key.monthlyQuota ?? null,
    user_id: key.userId ?? null,
    owner_active: true,
  };
}

/** Prisma `data` fragment for the limits the caller actually provided. */
function limitsData(limits: ApiKeyLimits) {
  return {
    ...(limits.expiresAt !== undefined ? { expiresAt: limits.expiresAt } : {}),
    ...(limits.rateLimitPerMinute !== undefined
      ? { rateLimitPerMinute: limits.rateLimitPerMinute }
      : {}),
    ...(limits.monthlyQuota !== undefined ? { monthlyQuota: limits.monthlyQuota } : {}),
  };
}

/** The quota counter key for the UTC calendar month containing `now`, and when that month ends. */
function quotaWindow(keyId: string, now = new Date()): { counterKey: string; resetAt: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    counterKey: `quota:${keyId}:${year}-${String(month + 1).padStart(2, "0")}`,
    resetAt: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/** The user already holds the maximum number of active virtual API keys. */
export class UserApiKeyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`api key limit reached (${limit})`);
    this.name = "UserApiKeyLimitError";
  }
}

@Injectable()
export class ApiKeysService implements OnModuleDestroy {
  private readonly lastTouchById = new Map<string, number>();
  private readonly validationCache = new Map<
    string,
    { value: ApiKeyRecord | null; expiresAt: number }
  >();
  private readonly validationInFlight = new Map<string, Promise<ApiKeyRecord | null>>();
  private readonly validationCacheMaxSize = 10_000;
  private readonly touchDebounceMs = 60_000;
  private readonly touchTrackerMaxSize = 10_000;

  // Own counter (and bucket map) so attacker-controlled client IPs in the
  // per-IP middleware can never evict per-key buckets.
  private readonly rateLimits: RateLimitCounter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    // Few, long-lived buckets: flush them on a timer too so idle usage (a monthly
    // quota especially) is persisted even when no later request arrives.
    this.rateLimits = new RateLimitCounter(prisma, { scheduleFlush: true });
  }

  /** Persists pending per-key counts while the database is still connected. */
  async onModuleDestroy(): Promise<void> {
    await this.rateLimits.drain();
  }

  async createApiKey(name: string, limits: ApiKeyLimits = {}) {
    const key = `fc_${crypto.randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.apiKey.create({
      data: {
        id: crypto.randomUUID(),
        name,
        keyHash: this.hashApiKey(key),
        keyValue: encryptSettingValue(key, this.config.firecrawlKeysEncryptionKey),
        keyPrefix: key.slice(0, 8),
        ...limitsData(limits),
      },
    });
    const { key_value: _keyValue, ...keyData } = toKey(row);
    return { ...keyData, key };
  }

  /**
   * Creates a virtual key owned by a portal user. Only a hash is stored (no recoverable
   * `key_value`), so the plaintext in the result is the only time it can be seen.
   * Under the per-user lock, the user's state and limit overrides are read in the same
   * transaction as the insert: a suspended or deleted user gets no key, and the key
   * always carries the limits in force when it was created (an admin's change waits
   * for the lock and then rewrites it).
   */
  async createUserApiKey(userId: string, name: string, options: { expiresAt?: Date | null } = {}) {
    const key = `fc_${crypto.randomBytes(32).toString("base64url")}`;
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          status: true,
          deletedAt: true,
          maxApiKeys: true,
          rateLimitPerMinute: true,
          monthlyQuota: true,
        },
      });
      if (!user || user.status !== "active" || user.deletedAt !== null)
        throw new UserInactiveError();
      const limits = effectiveLimits(user);
      const active = await tx.apiKey.count({ where: { userId, revoked: false } });
      if (active >= limits.maxApiKeys) throw new UserApiKeyLimitError(limits.maxApiKeys);
      return tx.apiKey.create({
        data: {
          id: crypto.randomUUID(),
          name,
          keyHash: this.hashApiKey(key),
          keyValue: null,
          keyPrefix: key.slice(0, 8),
          userId,
          rateLimitPerMinute: limits.rateLimitPerMinute,
          ...(limits.monthlyQuota ? { monthlyQuota: limits.monthlyQuota } : {}),
          ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        },
      });
    });
    const { key_value: _keyValue, key_hash: _keyHash, ...record } = toKey(row);
    return { ...record, key };
  }

  /** The user's active keys, newest first. */
  async listUserApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId, revoked: false },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toKey);
  }

  /** Revokes one of the user's own keys; null when the key is not theirs or is already gone. */
  async revokeUserApiKey(userId: string, id: string): Promise<ApiKeyRecord | null> {
    const existing = await this.prisma.apiKey.findFirst({
      where: { id, userId, revoked: false },
    });
    if (!existing) return null;
    return this.revokeApiKey(existing.id);
  }

  /** Changes a key's limits; null when the key does not exist. Takes effect immediately. */
  async updateApiKeyLimits(id: string, limits: ApiKeyLimits): Promise<ApiKeyRecord | null> {
    try {
      const updated = toKey(
        await this.prisma.apiKey.update({
          where: { id },
          data: limitsData(limits),
        }),
      );
      this.validationCache.delete(updated.key_hash);
      this.validationInFlight.delete(updated.key_hash);
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
        return null;
      throw error;
    }
  }

  /**
   * Counts one request against the key's per-minute limit. Returns null when the
   * key has no limit (or counting failed: the limiter fails open, like the per-IP one).
   */
  async hitRateLimit(key: ApiKeyRecord): Promise<ApiKeyRateLimitResult | null> {
    const limit = key.rate_limit_per_minute;
    if (limit === null || limit === undefined) return null;
    try {
      const { count, resetAt } = await this.rateLimits.hit(`key:${key.id}`);
      return { limit, remaining: Math.max(0, limit - count), resetAt, exceeded: count > limit };
    } catch {
      return null;
    }
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(toKey);
  }

  /**
   * Counts one request against the key's monthly quota (UTC calendar month).
   * Returns null when the key has no quota (or on an unexpected counting error,
   * in which case the request is allowed). While the database is unreachable the
   * counter keeps counting from memory, which is a lower bound of real usage, so
   * a key within its quota is not rejected for that. Enforcement is approximate:
   * across the flush interval and instances, and a flush whose acknowledgement
   * is lost after it committed can be counted twice (see `RateLimitCounter`).
   */
  async hitQuota(key: ApiKeyRecord): Promise<ApiKeyRateLimitResult | null> {
    const limit = key.monthly_quota;
    if (limit === null || limit === undefined) return null;
    try {
      const { counterKey, resetAt: monthEnd } = quotaWindow(key.id);
      const { count, resetAt } = await this.rateLimits.hit(counterKey, monthEnd);
      return { limit, remaining: Math.max(0, limit - count), resetAt, exceeded: count > limit };
    } catch {
      return null;
    }
  }

  /** Requests counted against each key's quota this month (as of the last flush), by key id. */
  async quotaUsage(keys: ApiKeyRecord[]): Promise<Map<string, number>> {
    const usage = new Map<string, number>();
    const withQuota = keys.filter((key) => key.monthly_quota !== null);
    if (withQuota.length === 0) return usage;
    const counterKeys = new Map(withQuota.map((key) => [quotaWindow(key.id).counterKey, key.id]));
    const rows = await this.prisma.rateLimit.findMany({
      where: { key: { in: [...counterKeys.keys()] }, resetAt: { gt: new Date() } },
      select: { key: true, count: true },
    });
    for (const row of rows) {
      const id = counterKeys.get(row.key);
      if (id) usage.set(id, row.count);
    }
    return usage;
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findUnique({ where: { id } });
    return row ? toKey(row) : null;
  }

  async revokeApiKey(id: string): Promise<ApiKeyRecord | null> {
    try {
      const revoked = toKey(
        await this.prisma.apiKey.update({ where: { id }, data: { revoked: true } }),
      );
      this.validationCache.delete(revoked.key_hash);
      this.validationInFlight.delete(revoked.key_hash);
      return revoked;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
        return null;
      throw error;
    }
  }

  async validateApiKey(key: string): Promise<ApiKeyRecord | null> {
    const keyHash = this.hashApiKey(key);
    const cached = this.validationCache.get(keyHash);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.validationCache.delete(keyHash);
    const existing = this.validationInFlight.get(keyHash);
    if (existing) return existing;
    const request = this.prisma.apiKey
      .findFirst({ where: { keyHash, revoked: false } })
      .then(async (row) => {
        if (!row) return null;
        const record = toKey(row);
        // A portal user's key stops working with its owner. It is flagged rather than
        // dropped, so an open deployment cannot mistake it for an anonymous request
        // (global keys have no owner and skip this lookup).
        if (row.userId) record.owner_active = await this.ownerIsActive(row.userId);
        return record;
      });
    this.validationInFlight.set(keyHash, request);
    try {
      const value = await request;
      if (this.validationInFlight.get(keyHash) === request) this.recordValidation(keyHash, value);
      return value;
    } finally {
      if (this.validationInFlight.get(keyHash) === request) this.validationInFlight.delete(keyHash);
    }
  }

  private async ownerIsActive(userId: string): Promise<boolean> {
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, deletedAt: true },
    });
    return owner !== null && owner.status === "active" && owner.deletedAt === null;
  }

  async touchApiKey(id: string): Promise<void> {
    const now = Date.now();
    const last = this.lastTouchById.get(id);
    if (last && now - last < this.touchDebounceMs) {
      this.recordTouch(id, last);
      return;
    }
    await this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(now) } });
    this.recordTouch(id, now);
  }

  clearValidationCache(): void {
    this.validationCache.clear();
    this.validationInFlight.clear();
  }

  hashApiKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  private recordValidation(keyHash: string, value: ApiKeyRecord | null): void {
    if (this.validationCache.has(keyHash)) this.validationCache.delete(keyHash);
    else if (this.validationCache.size >= this.validationCacheMaxSize) {
      const oldest = this.validationCache.keys().next().value;
      if (oldest) this.validationCache.delete(oldest);
    }
    this.validationCache.set(keyHash, {
      value,
      expiresAt: Date.now() + API_KEY_VALIDATION_CACHE_TTL_MS,
    });
  }

  private recordTouch(id: string, timestamp: number): void {
    if (this.lastTouchById.has(id)) this.lastTouchById.delete(id);
    else if (this.lastTouchById.size >= this.touchTrackerMaxSize) {
      const oldest = this.lastTouchById.keys().next().value;
      if (oldest) this.lastTouchById.delete(oldest);
    }
    this.lastTouchById.set(id, timestamp);
  }
}
