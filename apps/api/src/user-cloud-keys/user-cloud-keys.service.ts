import { Inject, Injectable, Logger } from "@nestjs/common";
import crypto from "node:crypto";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import type { CloudKeyEntry } from "../common/types";
import { CreditRoutingService } from "../credits/credit-routing.service";
import { PrismaService } from "../prisma/prisma.service";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_USERS = 10_000;
/** Cloud API keys one user may store. */
export const MAX_USER_CLOUD_KEYS = 5;
/** An explicit verification of the same key is refused again for this long. */
const VERIFY_INTERVAL_MS = 10_000;
const VERIFY_TRACKER_LIMIT = 10_000;

export type CloudKeyRole = "cloud" | "fallback";

/** A stored key as shown to its owner; the key itself is never part of it. */
export interface UserCloudKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  role: CloudKeyRole;
  created_at: string;
  last_verified_at: string | null;
}

export interface CloudKeyStatus {
  /** `valid`: Cloud accepted the key. `invalid`: Cloud rejected it. `unavailable`: could not be checked. */
  status: "valid" | "invalid" | "unavailable";
  remaining_credits: number | null;
  plan_credits: number | null;
  billing_period_end: string | null;
}

export type UserCloudKeyFailure =
  "limit_reached" | "duplicate" | "invalid_key" | "unverifiable" | "verify_too_soon" | "unreadable";

export class UserCloudKeyError extends Error {
  constructor(readonly reason: UserCloudKeyFailure) {
    super(reason);
    this.name = "UserCloudKeyError";
  }
}

function toRecord(row: {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  createdAt: Date;
  lastVerifiedAt: Date | null;
}): UserCloudKeyRecord {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    role: row.role === "fallback" ? "fallback" : "cloud",
    created_at: row.createdAt.toISOString(),
    last_verified_at: row.lastVerifiedAt?.toISOString() ?? null,
  };
}

/**
 * Reads a portal user's own Firecrawl Cloud API keys (bring your own key) as
 * routing entries. These keys are used only for requests made with that user's
 * virtual keys; they never join the admin's shared pool and the admin's pool is
 * never used for them.
 */
@Injectable()
export class UserCloudKeysService {
  private readonly logger = new Logger(UserCloudKeysService.name);
  private readonly cache = new Map<string, { entries: CloudKeyEntry[]; expiresAt: number }>();
  private readonly warned = new Set<string>();
  private readonly lastVerifiedAt = new Map<string, number>();
  // Bumped by every invalidation. A read that began before one is not cached: it may
  // hold rows that were just deleted, and caching it would bring them back for the TTL.
  private epoch = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly credits: CreditRoutingService,
  ) {}

  async list(userId: string): Promise<UserCloudKeyRecord[]> {
    const rows = await this.prisma.userCloudKey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }

  /**
   * Stores a key after Cloud accepted it. A key Cloud rejects, or one that could not
   * be checked, is not stored. The key is encrypted at rest and never returned.
   */
  async add(
    userId: string,
    input: { name: string; key: string; role: CloudKeyRole },
  ): Promise<{ key: UserCloudKeyRecord; status: CloudKeyStatus }> {
    this.invalidate(userId);
    const existing = await this.prisma.userCloudKey.count({ where: { userId } });
    if (existing >= MAX_USER_CLOUD_KEYS) throw new UserCloudKeyError("limit_reached");
    if ((await this.loadEntries(userId)).some((entry) => entry.key === input.key))
      throw new UserCloudKeyError("duplicate");

    const details = await this.credits.refreshCreditUsage(input.key, { force: true });
    const status = this.statusOf(details);
    if (status.status === "invalid") throw new UserCloudKeyError("invalid_key");
    if (status.status === "unavailable") throw new UserCloudKeyError("unverifiable");

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-cloud-keys:${userId}`}))`;
      const stored = await tx.userCloudKey.findMany({
        where: { userId },
        select: { keyValue: true },
      });
      if (stored.length >= MAX_USER_CLOUD_KEYS) throw new UserCloudKeyError("limit_reached");
      // Re-checked under the lock: two concurrent adds of the same key both passed the
      // earlier check, and each would otherwise take a slot of its own.
      if (stored.some((row) => this.decryptsTo(row.keyValue, input.key)))
        throw new UserCloudKeyError("duplicate");
      return tx.userCloudKey.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          name: input.name,
          keyValue: encryptSettingValue(input.key, this.config.firecrawlKeysEncryptionKey),
          keyPrefix: input.key.slice(0, 6),
          role: input.role,
          lastVerifiedAt: new Date(),
        },
      });
    });
    this.invalidate(userId);
    return { key: toRecord(row), status };
  }

  /** Renames a key or changes its role; null when it is not the user's. */
  async update(
    userId: string,
    id: string,
    changes: { name?: string; role?: CloudKeyRole },
  ): Promise<UserCloudKeyRecord | null> {
    const result = await this.prisma.userCloudKey.updateMany({
      where: { id, userId },
      data: {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.role !== undefined ? { role: changes.role } : {}),
      },
    });
    this.invalidate(userId);
    if (result.count === 0) return null;
    const row = await this.prisma.userCloudKey.findFirst({ where: { id, userId } });
    return row ? toRecord(row) : null;
  }

  /** Deletes one of the user's keys; false when it is not theirs. */
  async remove(userId: string, id: string): Promise<boolean> {
    const result = await this.prisma.userCloudKey.deleteMany({ where: { id, userId } });
    this.invalidate(userId);
    this.lastVerifiedAt.delete(`${userId}:${id}`);
    return result.count > 0;
  }

  /**
   * Re-checks a stored key with Cloud right now. A key with credits is re-enabled for
   * routing (this is how a key that hit its credit limit comes back after a top-up,
   * besides the bounded automatic re-check). Returns null when the key is not the
   * user's. The same key is not re-checked more often than every few seconds.
   */
  async verify(userId: string, id: string): Promise<CloudKeyStatus | null> {
    const row = await this.prisma.userCloudKey.findFirst({ where: { id, userId } });
    if (!row) return null;
    const trackerKey = `${userId}:${id}`;
    const now = Date.now();
    if ((this.lastVerifiedAt.get(trackerKey) ?? 0) + VERIFY_INTERVAL_MS > now)
      throw new UserCloudKeyError("verify_too_soon");
    if (this.lastVerifiedAt.size >= VERIFY_TRACKER_LIMIT) this.lastVerifiedAt.clear();
    this.lastVerifiedAt.set(trackerKey, now);

    let apiKey: string;
    try {
      const decrypted = decryptSettingValue(row.keyValue, this.config.firecrawlKeysEncryptionKey);
      if (!decrypted.encrypted || !decrypted.value) throw new Error("not encrypted");
      apiKey = decrypted.value;
    } catch {
      throw new UserCloudKeyError("unreadable");
    }
    const status = this.statusOf(await this.credits.refreshCreditUsage(apiKey, { force: true }));
    if (status.status === "valid") {
      await this.prisma.userCloudKey.update({
        where: { id: row.id },
        data: { lastVerifiedAt: new Date() },
      });
    }
    return status;
  }

  private decryptsTo(storedValue: string, apiKey: string): boolean {
    try {
      const decrypted = decryptSettingValue(storedValue, this.config.firecrawlKeysEncryptionKey);
      return decrypted.encrypted && decrypted.value === apiKey;
    } catch {
      return false;
    }
  }

  private statusOf(details: {
    remainingCredits: number | null;
    planCredits: number | null;
    billingPeriodEnd: string | null;
    error?: string;
    httpStatus?: number;
  }): CloudKeyStatus {
    const base = {
      remaining_credits: details.remainingCredits,
      plan_credits: details.planCredits,
      billing_period_end: details.billingPeriodEnd,
    };
    if (!details.error) return { status: "valid", ...base };
    // Only Cloud's own rejection of the credential means the key is bad; a timeout,
    // a 5xx or a malformed answer says nothing about it.
    const rejected = details.httpStatus === 401 || details.httpStatus === 403;
    return { status: rejected ? "invalid" : "unavailable", ...base };
  }

  /**
   * The user's keys in creation order. A key that cannot be decrypted is skipped
   * (and reported once, by user id only); a database failure rejects so the caller
   * can answer with an error instead of treating the user as having no keys.
   */
  async loadEntries(userId: string): Promise<CloudKeyEntry[]> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return [...cached.entries];
    const epochAtStart = this.epoch;
    const rows = await this.prisma.userCloudKey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, keyValue: true, role: true },
    });
    const entries: CloudKeyEntry[] = [];
    for (const row of rows) {
      try {
        const decrypted = decryptSettingValue(row.keyValue, this.config.firecrawlKeysEncryptionKey);
        // User keys are only ever stored encrypted; a plaintext row is not trusted.
        if (!decrypted.encrypted || !decrypted.value) continue;
        entries.push({
          key: decrypted.value,
          role: row.role === "fallback" ? "fallback" : "cloud",
        });
      } catch (error) {
        if (!this.warned.has(row.id)) {
          this.warned.add(row.id);
          // Only the error class and the row id: the message could quote key material.
          this.logger.warn(
            `Could not decrypt a stored user Cloud API key (${(error as Error).name}, id ${row.id}); ` +
              "check FIRECRAWL_KEYS_ENCRYPTION_KEY",
          );
        }
      }
    }
    if (epochAtStart === this.epoch) this.remember(userId, entries);
    return [...entries];
  }

  /** Drops a user's cached keys, e.g. right after they changed them. */
  invalidate(userId: string): void {
    this.epoch += 1;
    this.cache.delete(userId);
  }

  private remember(userId: string, entries: CloudKeyEntry[]): void {
    if (this.cache.has(userId)) this.cache.delete(userId);
    else if (this.cache.size >= CACHE_MAX_USERS) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(userId, { entries: [...entries], expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
