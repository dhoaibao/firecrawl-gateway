import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiKeysService } from "../api-keys/api-keys.service";
import {
  PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
  PORTAL_MAX_API_KEYS,
  effectiveLimits,
} from "../users/user-limits";
import { PrismaService } from "../prisma/prisma.service";
import { UserCloudKeysService } from "../user-cloud-keys/user-cloud-keys.service";
import { lockUser } from "../users/user-lock";

export type UserState = "active" | "suspended" | "deleted";
export type UserStateFilter = UserState | "all";

export class UserAdminError extends Error {
  constructor(readonly reason: "not_found" | "deleted") {
    super(reason);
    this.name = "UserAdminError";
  }
}

/** Fields an admin may change; `undefined` leaves one alone, `null` clears an override. */
export interface UserPatch {
  status?: "active" | "suspended";
  maxApiKeys?: number | null;
  rateLimitPerMinute?: number | null;
  monthlyQuota?: number | null;
}

type UserRow = Prisma.UserGetPayload<{ include: { identities: { select: { provider: true } } } }>;

function stateOf(user: { status: string; deletedAt: Date | null }): UserState {
  if (user.deletedAt) return "deleted";
  return user.status === "suspended" ? "suspended" : "active";
}

function summarize(user: UserRow, counts: { apiKeys: number; cloudKeys: number }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatarUrl,
    state: stateOf(user),
    providers: user.identities.map((identity) => identity.provider),
    api_keys: counts.apiKeys,
    cloud_keys: counts.cloudKeys,
    created_at: user.createdAt.toISOString(),
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
    deleted_at: user.deletedAt?.toISOString() ?? null,
    /** The admin's overrides; null means the portal default applies. */
    limits: {
      max_api_keys: user.maxApiKeys,
      rate_limit_per_minute: user.rateLimitPerMinute,
      monthly_quota: user.monthlyQuota,
    },
  };
}

export const PORTAL_DEFAULTS = {
  max_api_keys: PORTAL_MAX_API_KEYS,
  rate_limit_per_minute: PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
  monthly_quota: null,
} as const;

/** Administrator view and control of portal users. */
@Injectable()
export class UsersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
    private readonly userCloudKeys: UserCloudKeysService,
  ) {}

  async list(filter: { search?: string; state: UserStateFilter; limit: number; offset: number }) {
    const where: Prisma.UserWhereInput = {
      ...(filter.state === "deleted"
        ? { deletedAt: { not: null } }
        : filter.state === "all"
          ? {}
          : { deletedAt: null, ...(filter.state === "suspended" ? { status: "suspended" } : {}) }),
      ...(filter.state === "active" ? { status: "active" } : {}),
      ...(filter.search
        ? {
            OR: [
              { email: { contains: filter.search, mode: "insensitive" } },
              { name: { contains: filter.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: filter.limit,
        skip: filter.offset,
        include: {
          identities: { select: { provider: true } },
          _count: { select: { cloudKeys: true } },
        },
      }),
    ]);
    const keyCounts = await this.prisma.apiKey.groupBy({
      by: ["userId"],
      where: { userId: { in: rows.map((row) => row.id) }, revoked: false },
      _count: { _all: true },
    });
    const activeKeys = new Map(keyCounts.map((row) => [row.userId, row._count._all]));
    return {
      total,
      users: rows.map((row) =>
        summarize(row, { apiKeys: activeKeys.get(row.id) ?? 0, cloudKeys: row._count.cloudKeys }),
      ),
    };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { identities: true },
    });
    if (!user) throw new UserAdminError("not_found");
    const [keys, cloudKeys, sessions] = await Promise.all([
      this.prisma.apiKey.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" } }),
      this.prisma.userCloudKey.findMany({ where: { userId: id }, orderBy: { createdAt: "asc" } }),
      this.prisma.userSession.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    const activeKeys = keys.filter((key) => !key.revoked).length;
    return {
      ...summarize(user, { apiKeys: activeKeys, cloudKeys: cloudKeys.length }),
      effective_limits: (() => {
        const limits = effectiveLimits({
          maxApiKeys: user.maxApiKeys,
          rateLimitPerMinute: user.rateLimitPerMinute,
          monthlyQuota: user.monthlyQuota,
        });
        return {
          max_api_keys: limits.maxApiKeys,
          rate_limit_per_minute: limits.rateLimitPerMinute,
          monthly_quota: limits.monthlyQuota,
        };
      })(),
      active_sessions: sessions,
      identities: user.identities.map((identity) => ({
        provider: identity.provider,
        email: identity.email,
        linked_at: identity.createdAt.toISOString(),
      })),
      api_key_list: keys.map((key) => ({
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        revoked: key.revoked,
        created_at: key.createdAt.toISOString(),
        last_used_at: key.lastUsedAt?.toISOString() ?? null,
        expires_at: key.expiresAt?.toISOString() ?? null,
        rate_limit_per_minute: key.rateLimitPerMinute,
        monthly_quota: key.monthlyQuota,
      })),
      cloud_key_list: cloudKeys.map((key) => ({
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        role: key.role,
        last_verified_at: key.lastVerifiedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Suspends or reactivates a user and/or changes their limit overrides. A changed
   * rate limit or quota is applied to the user's active keys right away; a lowered
   * key cap only stops new keys (existing ones are not revoked). Suspension signs the
   * user out everywhere and, through the owner check, stops their keys.
   */
  async update(id: string, patch: UserPatch) {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, id);
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new UserAdminError("not_found");
      if (user.deletedAt) throw new UserAdminError("deleted");

      const data: Prisma.UserUpdateInput = {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.maxApiKeys !== undefined ? { maxApiKeys: patch.maxApiKeys } : {}),
        ...(patch.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: patch.rateLimitPerMinute }
          : {}),
        ...(patch.monthlyQuota !== undefined ? { monthlyQuota: patch.monthlyQuota } : {}),
      };
      const keyData: Prisma.ApiKeyUpdateManyMutationInput = {
        ...(patch.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: patch.rateLimitPerMinute ?? PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE }
          : {}),
        ...(patch.monthlyQuota !== undefined ? { monthlyQuota: patch.monthlyQuota } : {}),
      };
      if (Object.keys(data).length) await tx.user.update({ where: { id }, data });
      if (Object.keys(keyData).length)
        await tx.apiKey.updateMany({ where: { userId: id, revoked: false }, data: keyData });
      // Same transaction and lock as the status change: no session can be created in between.
      if (patch.status === "suspended")
        await tx.userSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
    });
    // Takes effect at once on this instance; others pick it up within the cache TTL.
    this.apiKeys.clearValidationCache();
    return this.get(id);
  }

  /**
   * Soft-deletes a user: signs them out, revokes their virtual keys and purges their
   * stored Cloud keys. The row stays (with `deleted_at`) so the email cannot be
   * re-registered silently and audit history keeps its owner.
   */
  async remove(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, id);
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new UserAdminError("not_found");
      if (user.deletedAt) throw new UserAdminError("deleted");
      await tx.user.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.apiKey.updateMany({
        where: { userId: id, revoked: false },
        data: { revoked: true },
      });
      await tx.userCloudKey.deleteMany({ where: { userId: id } });
      await tx.userSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    this.apiKeys.clearValidationCache();
    this.userCloudKeys.invalidate(id);
  }
}
