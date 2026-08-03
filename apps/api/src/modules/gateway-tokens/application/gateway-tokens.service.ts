import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { TransactionService } from "../../../core/database/transaction.service";

export interface GatewayTokenAuthentication {
  tokenId: string;
  userId: string;
  accountId: string;
  scopes: string[];
  userStatus: string;
  suspendedUntil: string | null;
}

export interface GatewayTokenView {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  inactivity_timeout_seconds: number | null;
  status: "active" | "expired" | "inactive" | "revoked";
  revoked: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  key?: string;
}

@Injectable()
export class GatewayTokensService {
  constructor(private readonly transactions: TransactionService) {}

  async listAll(): Promise<GatewayTokenView[]> {
    const rows = await this.transactions.runAsOperator((transaction) => transaction.apiKey.findMany({ orderBy: { createdAt: "desc" } }));
    return rows.map(serializeToken);
  }

  async list(accountId: string): Promise<GatewayTokenView[]> {
    const rows = await this.transactions.runForAccount(accountId, (transaction) => transaction.apiKey.findMany({ where: { accountId }, orderBy: { createdAt: "desc" } }));
    return rows.map(serializeToken);
  }

  async get(id: string, accountId: string): Promise<GatewayTokenView | null> {
    const row = await this.transactions.runForAccount(accountId, (transaction) => transaction.apiKey.findFirst({ where: { id, accountId } }));
    return row ? serializeToken(row) : null;
  }

  async authenticate(rawToken: string): Promise<GatewayTokenAuthentication | null> {
    const keyHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const now = Date.now();
    const match = await this.transactions.runAsOperator(async (transaction) => {
      const rows = await transaction.apiKey.findMany({
        where: { keyHash, revoked: false, user: { emailVerifiedAt: { not: null } } },
        orderBy: { createdAt: "asc" },
        select: { id: true, userId: true, accountId: true, scopes: true, expiresAt: true, inactivityTimeoutSeconds: true, lastUsedAt: true, createdAt: true, user: { select: { status: true, suspendedUntil: true } } },
      });
      return rows.find((row) => {
        if (row.expiresAt && row.expiresAt.getTime() <= now) return false;
        const lastUsed = row.lastUsedAt?.getTime() ?? row.createdAt.getTime();
        return row.inactivityTimeoutSeconds === null || lastUsed + row.inactivityTimeoutSeconds * 1000 > now;
      }) ?? null;
    });
    if (!match) return null;
    void this.transactions.runAsOperator((transaction) => transaction.apiKey.updateMany({ where: { id: match.id }, data: { lastUsedAt: new Date() } })).catch(() => undefined);
    return { tokenId: match.id, userId: match.userId, accountId: match.accountId, scopes: match.scopes, userStatus: match.user.status, suspendedUntil: match.user.suspendedUntil?.toISOString() ?? null };
  }

  async create(input: { userId: string; accountId: string; name: string; scopes?: string[]; expiresAt?: string | null; inactivityTimeoutSeconds?: number | null }): Promise<GatewayTokenView> {
    const token = `fc_${crypto.randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const row = await this.transactions.runForAccount(input.accountId, (transaction) => transaction.apiKey.create({
      data: {
        id: crypto.randomUUID(),
        userId: input.userId,
        accountId: input.accountId,
        name: input.name.trim(),
        keyHash: hash(token),
        keyValue: null,
        keyPrefix: token.slice(0, 8),
        scopes: normalizeScopes(input.scopes),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        inactivityTimeoutSeconds: input.inactivityTimeoutSeconds ?? null,
        createdAt: now,
        updatedAt: now,
      },
    }));
    return { ...serializeToken(row), key: token };
  }

  async revoke(id: string, accountId: string): Promise<GatewayTokenView | null> {
    const row = await this.transactions.runForAccount(accountId, async (transaction) => {
      const existing = await transaction.apiKey.findFirst({ where: { id, accountId } });
      if (!existing) return null;
      return transaction.apiKey.update({ where: { id }, data: { revoked: true, updatedAt: new Date() } });
    });
    return row ? serializeToken(row) : null;
  }

  async revokeAny(id: string): Promise<GatewayTokenView | null> {
    const row = await this.transactions.runAsOperator(async (transaction) => {
      const existing = await transaction.apiKey.findUnique({ where: { id } });
      if (!existing) return null;
      return transaction.apiKey.update({ where: { id }, data: { revoked: true, updatedAt: new Date() } });
    });
    return row ? serializeToken(row) : null;
  }

  async revokeAll(accountId: string): Promise<number> {
    const result = await this.transactions.runForAccount(accountId, (transaction) => transaction.apiKey.updateMany({ where: { accountId, revoked: false }, data: { revoked: true, updatedAt: new Date() } }));
    return result.count;
  }

  async revokeAllAny(accountId: string): Promise<number> {
    const result = await this.transactions.runAsOperator((transaction) => transaction.apiKey.updateMany({ where: { accountId, revoked: false }, data: { revoked: true, updatedAt: new Date() } }));
    return result.count;
  }
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!scopes?.length) return ["*"];
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (!normalized.length || normalized.some((scope) => scope.length > 128)) throw new Error("Gateway token scopes must be non-empty strings up to 128 characters");
  return normalized;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function serializeToken(row: {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  inactivityTimeoutSeconds: number | null;
  revoked: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}): GatewayTokenView {
  const now = Date.now();
  const expires = row.expiresAt?.getTime() ?? null;
  const lastUsed = row.lastUsedAt?.getTime() ?? row.createdAt.getTime();
  const inactive = row.inactivityTimeoutSeconds !== null && lastUsed + row.inactivityTimeoutSeconds * 1000 <= now;
  const status = row.revoked ? "revoked" : expires !== null && expires <= now ? "expired" : inactive ? "inactive" : "active";
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    key_prefix: row.keyPrefix,
    scopes: row.scopes,
    expires_at: row.expiresAt?.toISOString() ?? null,
    inactivity_timeout_seconds: row.inactivityTimeoutSeconds,
    status,
    revoked: row.revoked,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
  };
}
