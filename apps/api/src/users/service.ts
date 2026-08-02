import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { asDatabaseClient } from "../db";
import { withOperatorTransaction } from "../infrastructure/database";
import {
  resumeAccountEntitlementsWithClient,
  suspendAccountEntitlementsWithClient,
} from "../quota/service";
import type { User } from "../types";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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
  memberships: {
    where: { role: "owner" },
    orderBy: { createdAt: "asc" },
    take: 1,
    select: { accountId: true },
  },
});

type SelectedUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function mapUser(row: SelectedUser, accountId = row.memberships[0]?.accountId): User {
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
    mfa_enabled: undefined,
    account_id: accountId,
    status: row.status,
    suspended_until: row.suspendedUntil?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function syncEntitlementsForStatus(
  tx: Prisma.TransactionClient,
  userId: string,
  status: string,
): Promise<void> {
  const client = asDatabaseClient(tx);
  const accountId = `personal:${userId}`;
  if (status === "active") {
    await resumeAccountEntitlementsWithClient(client, accountId);
  } else if (status === "suspended" || status === "blocked") {
    await suspendAccountEntitlementsWithClient(client, accountId);
  }
}

async function maybeReactivate(
  tx: Prisma.TransactionClient,
  row: SelectedUser | null,
): Promise<User | null> {
  if (!row) return null;
  const user = mapUser(row);
  if (user.status !== "suspended" || !user.suspended_until) return user;

  const until = new Date(user.suspended_until);
  if (until.getTime() > Date.now()) return user;

  const reactivated = await tx.user.update({
    where: { id: user.id },
    data: { status: "active", suspendedUntil: null, updatedAt: new Date() },
    select: userSelect,
  });
  if (user.account_id) {
    await resumeAccountEntitlementsWithClient(asDatabaseClient(tx), user.account_id);
  }
  return mapUser(reactivated, user.account_id);
}

export async function createUser(
  email: string,
  name: string,
  passwordHash: string,
  isAdmin = false,
): Promise<User> {
  return withOperatorTransaction(async (tx) => {
    const id = crypto.randomUUID();
    const normalizedEmail = normalizeEmail(email);
    const user = await tx.user.create({
      data: {
        id,
        email: email.trim(),
        normalizedEmail,
        name,
        passwordHash,
        isAdmin,
        platformRole: isAdmin ? "admin" : "user",
        status: "active",
      },
      select: userSelect,
    });
    const accountId = `personal:${id}`;
    await tx.account.upsert({
      where: { id: accountId },
      create: { id: accountId, displayName: name.trim() || normalizedEmail },
      update: {},
    });
    await tx.accountMembership.upsert({
      where: { accountId_userId: { accountId, userId: id } },
      create: { accountId, userId: id, role: "owner" },
      update: {},
    });
    return mapUser(user, accountId);
  });
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.findUnique({
      where: { normalizedEmail: normalizeEmail(email) },
      select: userSelect,
    });
    return maybeReactivate(tx, row);
  });
}

export async function getUserById(id: string): Promise<User | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.findUnique({ where: { id }, select: userSelect });
    return maybeReactivate(tx, row);
  });
}

export async function listUsers(): Promise<User[]> {
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.user.findMany({
      orderBy: { createdAt: "desc" },
      select: userSelect,
    });
    return rows.map((row) => {
      const user = mapUser(row);
      if (user.status === "suspended" && user.suspended_until && new Date(user.suspended_until).getTime() <= Date.now()) {
        return { ...user, status: "active", suspended_until: null };
      }
      return user;
    });
  });
}

export async function updateUser(
  id: string,
  updates: {
    name?: string;
    email?: string;
    password_hash?: string;
    is_admin?: boolean;
    status?: string;
    suspended_until?: string | null;
  },
): Promise<User | null> {
  const data: Prisma.UserUpdateInput = {};
  if (updates.name !== undefined) data.name = updates.name;
  if (updates.email !== undefined) {
    data.email = updates.email.trim();
    data.normalizedEmail = normalizeEmail(updates.email);
  }
  if (updates.password_hash !== undefined) {
    data.passwordHash = updates.password_hash;
    data.authVersion = { increment: 1 };
  }
  if (updates.is_admin !== undefined) {
    data.isAdmin = updates.is_admin;
    data.platformRole = updates.is_admin ? "admin" : "user";
  }
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.suspended_until !== undefined) {
    data.suspendedUntil = updates.suspended_until ? new Date(updates.suspended_until) : null;
  }
  if (Object.keys(data).length === 0) return getUserById(id);

  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.update({ where: { id }, data, select: userSelect }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "P2025") return null;
      throw error;
    });
    if (!row) return null;
    if (updates.status !== undefined) await syncEntitlementsForStatus(tx, id, updates.status);
    return mapUser(row);
  });
}

export async function suspendUser(id: string, durationMs: number): Promise<User | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.update({
      where: { id },
      data: { status: "suspended", suspendedUntil: new Date(Date.now() + durationMs), updatedAt: new Date() },
      select: userSelect,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "P2025") return null;
      throw error;
    });
    if (!row) return null;
    await syncEntitlementsForStatus(tx, id, "suspended");
    return mapUser(row);
  });
}

export async function blockUser(id: string): Promise<User | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.update({
      where: { id },
      data: { status: "blocked", suspendedUntil: null, updatedAt: new Date() },
      select: userSelect,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "P2025") return null;
      throw error;
    });
    if (!row) return null;
    await syncEntitlementsForStatus(tx, id, "blocked");
    return mapUser(row);
  });
}

export async function activateUser(id: string): Promise<User | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.user.update({
      where: { id },
      data: { status: "active", suspendedUntil: null, updatedAt: new Date() },
      select: userSelect,
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "P2025") return null;
      throw error;
    });
    if (!row) return null;
    const user = mapUser(row);
    await syncEntitlementsForStatus(tx, user.id, "active");
    return user;
  });
}

export function checkUserAccess(user: User): { allowed: true } | { allowed: false; reason: string } {
  if (user.status === "blocked") return { allowed: false, reason: "Account blocked" };
  if (user.status === "suspended") {
    if (user.suspended_until) {
      const until = new Date(user.suspended_until);
      if (until.getTime() > Date.now()) {
        const diff = until.getTime() - Date.now();
        const hours = Math.ceil(diff / (1000 * 60 * 60));
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        const label = days > 1 ? `${days} days` : `${hours} hour${hours > 1 ? "s" : ""}`;
        return { allowed: false, reason: `Account suspended. Try again in ${label}.` };
      }
    }
    return { allowed: false, reason: "Account suspended" };
  }
  return { allowed: true };
}

export type DeleteUserResult = "deleted" | "not_found" | "last_admin";
const ADMIN_DELETE_GUARD_LOCK = 4_271_001;

export async function deleteUserSafely(id: string): Promise<DeleteUserResult> {
  return withOperatorTransaction(async (tx) => {
    const target = await tx.$queryRaw<Array<{ id: string; is_admin: boolean }>>(
      Prisma.sql`SELECT id, is_admin FROM users WHERE id = ${id} FOR UPDATE`,
    );
    if (!target[0]) return "not_found";

    if (target[0].is_admin) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_DELETE_GUARD_LOCK})`;
      const adminCount = await tx.user.count({ where: { OR: [{ platformRole: "admin" }, { isAdmin: true }] } });
      if (adminCount <= 1) return "last_admin";
    }

    await tx.user.delete({ where: { id } });
    return "deleted";
  });
}

export async function countUsers(): Promise<number> {
  return withOperatorTransaction((tx) => tx.user.count());
}

export async function countAdmins(): Promise<number> {
  return withOperatorTransaction((tx) => tx.user.count({ where: { OR: [{ platformRole: "admin" }, { isAdmin: true }] } }));
}
