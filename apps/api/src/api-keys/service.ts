import crypto from "node:crypto";
import { withAccountTransaction, withOperatorTransaction, withUserAccountTransaction } from "../infrastructure/database";
import { asDatabaseClient } from "../db";
import { resumeAccountEntitlementsWithClient } from "../quota/service";
import * as repository from "./repository";
import type { GatewayToken, User } from "../types";

/** Compatibility name for the legacy module; product-facing callers should say gateway token. */
export interface AuthenticatedApiKey {
  key: GatewayToken;
  user: User;
}

export interface CreatedApiKey {
  id: string;
  user_id: string;
  account_id?: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  inactivity_timeout_seconds: number | null;
  status: "active";
  revoked: boolean;
  created_at: string;
  updated_at: string;
  /** Returned exactly once by the create operation; never persisted in decryptable form. */
  key: string;
}

export interface CreateGatewayTokenOptions {
  scopes?: string[];
  expiresAt?: string | null;
  inactivityTimeoutSeconds?: number | null;
}

export async function createApiKey(
  userId: string,
  name: string,
  options: CreateGatewayTokenOptions = {},
): Promise<CreatedApiKey> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const keyPrefix = key.slice(0, 8);
  const scopes = normalizeScopes(options.scopes);
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : null;
  const inactivityTimeoutSeconds = options.inactivityTimeoutSeconds ?? null;

  return withUserAccountTransaction(userId, async (accountId, tx) => {
    const row = await repository.create(tx, {
      id: crypto.randomUUID(),
      userId,
      accountId,
      name,
      keyHash,
      keyPrefix,
      scopes,
      expiresAt,
      inactivityTimeoutSeconds,
    });
    const token = repository.toGatewayToken(row);
    const { key_hash: _keyHash, key_value: _keyValue, ...keyData } = token;
    return {
      ...keyData,
      scopes: token.scopes ?? ["*"],
      expires_at: token.expires_at ?? null,
      inactivity_timeout_seconds: token.inactivity_timeout_seconds ?? null,
      status: "active",
      key,
    };
  });
}

export async function listApiKeys(userId?: string): Promise<GatewayToken[]> {
  if (userId) {
    return withUserAccountTransaction(userId, async (accountId, tx) => {
      const rows = await repository.listForUser(tx, accountId, userId);
      return rows.map(repository.toGatewayToken);
    });
  }

  return withOperatorTransaction(async (tx) => {
    const rows = await repository.listAll(tx);
    return rows.map(repository.toGatewayToken);
  });
}

export async function getApiKeyById(id: string, accountId?: string): Promise<GatewayToken | null> {
  if (accountId) {
    return withAccountTransaction(accountId, async (tx) => {
      const row = await repository.findById(tx, id, accountId);
      return row ? repository.toGatewayToken(row) : null;
    });
  }
  return withOperatorTransaction(async (tx) => {
    const row = await repository.findById(tx, id);
    return row ? repository.toGatewayToken(row) : null;
  });
}

export async function revokeApiKey(id: string, accountId?: string): Promise<GatewayToken | null> {
  const execute = accountId
    ? withAccountTransaction(accountId, (tx) => repository.revoke(tx, id, accountId))
    : withOperatorTransaction((tx) => repository.revoke(tx, id));
  const row = await execute;
  return row ? repository.toGatewayToken(row) : null;
}

export async function validateApiKey(key: string): Promise<GatewayToken | null> {
  const keyHash = hashApiKey(key);
  return withOperatorTransaction(async (tx) => {
    const row = await repository.findValidByHash(tx, keyHash);
    return row ? repository.toGatewayToken(row) : null;
  });
}

export async function validateApiKeyWithUser(key: string): Promise<AuthenticatedApiKey | null> {
  const keyHash = hashApiKey(key);
  return withOperatorTransaction(async (tx) => {
    const authenticated = await repository.findValidWithUser(tx, keyHash);
    if (!authenticated) return null;

    let user = authenticated.user;
    if (user.status === "suspended" && user.suspended_until && new Date(user.suspended_until).getTime() <= Date.now()) {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { status: "active", suspendedUntil: null, updatedAt: new Date() },
        select: {
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
        },
      });
      user = repository.toUser(updated, authenticated.key.accountId);
      await resumeAccountEntitlementsWithClient(asDatabaseClient(tx), authenticated.key.accountId);
    }

    return { key: repository.toGatewayToken(authenticated.key), user };
  });
}

const TOUCH_DEBOUNCE_MS = 60_000;
const TOUCH_TRACKER_MAX_SIZE = 10_000;
const lastTouchById = new Map<string, number>();

export function clearTouchDebouncer(): void {
  lastTouchById.clear();
}

function recordTouch(id: string, timestamp: number): void {
  if (lastTouchById.has(id)) lastTouchById.delete(id);
  else if (lastTouchById.size >= TOUCH_TRACKER_MAX_SIZE) {
    const oldest = lastTouchById.keys().next().value;
    if (oldest !== undefined) lastTouchById.delete(oldest);
  }
  lastTouchById.set(id, timestamp);
}

export async function touchApiKey(id: string): Promise<void> {
  const now = Date.now();
  const lastTouch = lastTouchById.get(id);
  if (lastTouch && now - lastTouch < TOUCH_DEBOUNCE_MS) {
    recordTouch(id, lastTouch);
    return;
  }
  await withOperatorTransaction(async (tx) => {
    await tx.apiKey.updateMany({ where: { id }, data: { lastUsedAt: new Date(now) } });
  });
  recordTouch(id, now);
}

export function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return ["*"];
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0 || normalized.some((scope) => scope.length > 128)) {
    throw new Error("Gateway token scopes must be non-empty strings up to 128 characters");
  }
  return normalized;
}

export function generateApiKey(): string {
  return `fc_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
