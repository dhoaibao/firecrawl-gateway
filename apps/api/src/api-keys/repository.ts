import { Prisma } from "@prisma/client";
import type { GatewayToken, User } from "../types";

const keySelect = Prisma.validator<Prisma.ApiKeySelect>()({
  id: true,
  userId: true,
  accountId: true,
  name: true,
  keyHash: true,
  keyValue: true,
  keyPrefix: true,
  scopes: true,
  expiresAt: true,
  inactivityTimeoutSeconds: true,
  revoked: true,
  createdAt: true,
  updatedAt: true,
  lastUsedAt: true,
});

const userSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  email: true,
  normalizedEmail: true,
  name: true,
  passwordHash: true,
  isAdmin: true,
  platformRole: true,
  emailVerifiedAt: true,
  authVersion: true,
  status: true,
  suspendedUntil: true,
  createdAt: true,
  updatedAt: true,
});

type KeyRow = Prisma.ApiKeyGetPayload<{ select: typeof keySelect }>;
type AuthenticatedRow = Prisma.ApiKeyGetPayload<{
  select: typeof keySelect & { user: { select: typeof userSelect } };
}>;

export function toGatewayToken(row: KeyRow): GatewayToken {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    key_hash: row.keyHash,
    key_value: row.keyValue,
    key_prefix: row.keyPrefix,
    scopes: row.scopes,
    expires_at: row.expiresAt?.toISOString() ?? null,
    inactivity_timeout_seconds: row.inactivityTimeoutSeconds,
    revoked: row.revoked,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
  };
}

export function toUser(row: {
  id: string;
  email: string;
  normalizedEmail: string;
  name: string;
  passwordHash: string;
  isAdmin: boolean;
  platformRole: string;
  emailVerifiedAt: Date | null;
  authVersion: number;
  status: string;
  suspendedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}, accountId?: string): User {
  return {
    id: row.id,
    email: row.email,
    normalized_email: row.normalizedEmail,
    name: row.name,
    password_hash: row.passwordHash,
    is_admin: row.isAdmin,
    platform_role: row.platformRole,
    email_verified_at: row.emailVerifiedAt?.toISOString() ?? null,
    auth_version: row.authVersion,
    account_id: accountId,
    status: row.status,
    suspended_until: row.suspendedUntil?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function create(
  tx: Prisma.TransactionClient,
  data: {
    id: string;
    userId: string;
    accountId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: Date | null;
    inactivityTimeoutSeconds: number | null;
  },
): Promise<KeyRow> {
  return tx.apiKey.create({ data, select: keySelect });
}

export async function listForUser(
  tx: Prisma.TransactionClient,
  accountId: string,
  userId: string,
): Promise<KeyRow[]> {
  return tx.apiKey.findMany({
    where: { accountId, userId },
    orderBy: { createdAt: "desc" },
    select: keySelect,
  });
}

export async function listAll(tx: Prisma.TransactionClient): Promise<KeyRow[]> {
  return tx.apiKey.findMany({ orderBy: { createdAt: "desc" }, select: keySelect });
}

export async function findById(
  tx: Prisma.TransactionClient,
  id: string,
  accountId?: string,
): Promise<KeyRow | null> {
  return tx.apiKey.findFirst({
    where: { id, ...(accountId ? { accountId } : {}) },
    select: keySelect,
  });
}

export async function revoke(
  tx: Prisma.TransactionClient,
  id: string,
  accountId?: string,
): Promise<KeyRow | null> {
  const result = await tx.apiKey.updateMany({
    where: { id, ...(accountId ? { accountId } : {}) },
    data: { revoked: true, updatedAt: new Date() },
  });
  if (result.count === 0) return null;
  return findById(tx, id, accountId);
}

function isActive(row: KeyRow, now: number): boolean {
  if (row.revoked) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now) return false;
  if (row.inactivityTimeoutSeconds !== null) {
    const lastUsed = row.lastUsedAt?.getTime() ?? row.createdAt.getTime();
    if (lastUsed + row.inactivityTimeoutSeconds * 1000 <= now) return false;
  }
  return true;
}

export async function findValidByHash(
  tx: Prisma.TransactionClient,
  keyHash: string,
): Promise<KeyRow | null> {
  const rows = await tx.apiKey.findMany({
    where: { keyHash, revoked: false },
    orderBy: { createdAt: "asc" },
    select: keySelect,
  });
  return rows.find((row) => isActive(row, Date.now())) ?? null;
}

export async function findValidWithUser(
  tx: Prisma.TransactionClient,
  keyHash: string,
): Promise<{ key: KeyRow; user: User } | null> {
  const rows = await tx.apiKey.findMany({
    where: {
      keyHash,
      revoked: false,
      user: { emailVerifiedAt: { not: null } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      ...keySelect,
      user: { select: userSelect },
    },
  });
  const row = rows.find((candidate) => isActive(candidate, Date.now())) as AuthenticatedRow | undefined;
  if (!row) return null;
  return { key: row, user: toUser(row.user, row.accountId) };
}
