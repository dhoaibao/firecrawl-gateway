import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import type { User } from "../../../types";
import { TransactionService } from "../../../core/database/transaction.service";
import { AppConfigService } from "../../../core/config/config.service";
import { QuotaService } from "../../quota/application/quota.service";

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

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

@Injectable()
export class AccountsService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly config: AppConfigService,
    private readonly quota: QuotaService,
  ) {}

  async listUsers(): Promise<User[]> {
    return this.transactions.runAsOperator(async (transaction) => {
      const rows = await transaction.user.findMany({ orderBy: { createdAt: "desc" }, select: userSelect });
      return rows.map((row) => mapUser(row));
    });
  }

  async findAccountByPublicId(publicId: string): Promise<{ id: string; status: string; fundingPreference: string } | null> {
    return this.transactions.runAsOperator((transaction) => transaction.account.findUnique({ where: { publicId }, select: { id: true, status: true, fundingPreference: true } }));
  }

  async getUser(id: string): Promise<User | null> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.user.findUnique({ where: { id }, select: userSelect });
      return row ? mapUser(row) : null;
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.user.findUnique({
        where: { normalizedEmail: normalizeEmail(email) },
        select: userSelect,
      });
      return row ? mapUser(row) : null;
    });
  }

  async createUser(input: { email: string; name: string; password: string; isAdmin?: boolean }): Promise<User> {
    const normalizedEmail = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, this.config.bcryptRounds);
    return this.transactions.runAsOperator(async (transaction) => {
      const id = crypto.randomUUID();
      const accountId = `personal:${id}`;
      const row = await transaction.user.create({
        data: {
          id,
          email: input.email.trim(),
          normalizedEmail,
          name: input.name.trim(),
          passwordHash,
          isAdmin: input.isAdmin === true,
          platformRole: input.isAdmin === true ? "admin" : "user",
          status: "active",
        },
        select: userSelect,
      });
      await transaction.account.create({ data: { id: accountId, displayName: input.name.trim() || normalizedEmail } });
      await transaction.accountMembership.create({ data: { accountId, userId: id, role: "owner" } });
      return mapUser(row, accountId);
    });
  }

  async updateUser(id: string, input: {
    name?: string;
    email?: string;
    password?: string;
    isAdmin?: boolean;
    status?: "active" | "suspended" | "blocked";
    suspendedUntil?: string | null;
  }): Promise<User | null> {
    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.email !== undefined) {
      data.email = input.email.trim();
      data.normalizedEmail = normalizeEmail(input.email);
    }
    if (input.password !== undefined) {
      data.passwordHash = await bcrypt.hash(input.password, this.config.bcryptRounds);
      data.authVersion = { increment: 1 };
    }
    if (input.isAdmin !== undefined) {
      data.isAdmin = input.isAdmin;
      data.platformRole = input.isAdmin ? "admin" : "user";
    }
    if (input.status !== undefined) data.status = input.status;
    if (input.suspendedUntil !== undefined) data.suspendedUntil = input.suspendedUntil ? new Date(input.suspendedUntil) : null;
    if (Object.keys(data).length === 0) return this.getUser(id);

    const previous = input.status === undefined ? null : await this.getUser(id);
    const updated = await this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.user.update({ where: { id }, data, select: userSelect }).catch((error: unknown) => {
        if ((error as { code?: string }).code === "P2025") return null;
        throw error;
      });
      return row ? mapUser(row) : null;
    });
    if (updated && previous && previous.status !== updated.status) {
      const accountId = updated.account_id ?? `personal:${updated.id}`;
      if (updated.status === "active") await this.quota.resumeAccount(accountId);
      else await this.quota.suspendAccount(accountId);
    }
    return updated;
  }

  async deleteUser(id: string): Promise<"deleted" | "not_found" | "last_admin"> {
    return this.transactions.runAsOperator(async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id }, select: { id: true, isAdmin: true, platformRole: true } });
      if (!target) return "not_found";
      if (target.isAdmin || target.platformRole === "admin") {
        const adminCount = await transaction.user.count({ where: { OR: [{ isAdmin: true }, { platformRole: "admin" }] } });
        if (adminCount <= 1) return "last_admin";
      }
      await transaction.user.delete({ where: { id } });
      return "deleted";
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapUser(row: UserRow, accountId = row.memberships[0]?.accountId): User {
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
    account_id: accountId ?? `personal:${row.id}`,
    status: row.status,
    suspended_until: row.suspendedUntil?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
