import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { generateSecret, generateURI, verify } from "otplib";
import type { User } from "../../../types";
import { TransactionService } from "../../../core/database/transaction.service";
import { AppConfigService } from "../../../core/config/config.service";
import { decryptAuthValue, encryptAuthValue } from "../../../auth/crypto";
import { createOpaqueToken, generateRecoveryCode, hashOpaqueToken, hashRecoveryCode } from "../../../auth/tokens";
import { validatePassword } from "../../../auth/password";
import { asDatabaseClient } from "../../../db";
import {
  admitAccountWithClient,
  resumeAccountEntitlementsWithClient,
} from "../../../quota/service";

const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const DUMMY_PASSWORD_HASH = "$2b$12$LQv3c1yqBWxqk5f7VfYJ6eQZ2q9mT4r7e3W8mM5vG2cR9aK6nPq1S";

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
type Transaction = Prisma.TransactionClient;

type RequestMetadata = { ip?: string; userAgent?: string };
type EmailPayload = { subject: string; html: string };

function mapUser(row: UserRow): User {
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
    account_id: row.memberships[0]?.accountId ?? `personal:${row.id}`,
    status: row.status,
    suspended_until: row.suspendedUntil?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function privacyLabel(value: string | undefined): string | null {
  return value ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 96) : null;
}

function tokenExpiry(): Date {
  return new Date(Date.now() + TOKEN_TTL_MS);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly config: AppConfigService,
  ) {}

  passwordError(password: unknown): string | null {
    return validatePassword(password);
  }

  checkAccess(user: User): { allowed: true } | { allowed: false; reason: string } {
    if (user.status === "blocked") return { allowed: false, reason: "Account blocked" };
    if (user.status === "suspended") {
      const until = user.suspended_until ? new Date(user.suspended_until) : null;
      if (until && until.getTime() > Date.now()) {
        const remaining = until.getTime() - Date.now();
        const hours = Math.ceil(remaining / 3_600_000);
        const days = Math.ceil(remaining / 86_400_000);
        return { allowed: false, reason: `Account suspended. Try again in ${days > 1 ? `${days} days` : `${hours} hour${hours > 1 ? "s" : ""}`}.` };
      }
      return { allowed: false, reason: "Account suspended" };
    }
    return { allowed: true };
  }

  async authenticate(email: string, password: string): Promise<User | null> {
    const user = await this.getUserByEmail(email);
    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !valid || !user.email_verified_at || !this.checkAccess(user).allowed) return null;
    const rounds = bcrypt.getRounds(user.password_hash);
    if (rounds < this.config.bcryptRounds) {
      const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds);
      return this.updatePasswordHash(user.id, passwordHash);
    }
    return user;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.user.findUnique({ where: { id }, select: userSelect });
      return this.reactivateExpiredSuspension(transaction, row);
    });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.user.findUnique({
        where: { normalizedEmail: email.trim().toLowerCase() },
        select: userSelect,
      });
      return this.reactivateExpiredSuspension(transaction, row);
    });
  }

  async register(input: { email: string; name: string; password: string } & RequestMetadata): Promise<void> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(input.password, this.config.bcryptRounds);
    await this.transactions.runAsOperator(async (transaction) => {
      if (await transaction.user.findUnique({ where: { normalizedEmail }, select: { id: true } })) return;
      const userId = crypto.randomUUID();
      const accountId = `personal:${userId}`;
      const token = createOpaqueToken();
      await transaction.user.create({
        data: {
          id: userId,
          email: input.email.trim(),
          normalizedEmail,
          name: input.name.trim(),
          passwordHash,
          platformRole: "user",
          status: "active",
          authVersion: 1,
        },
      });
      await transaction.account.create({ data: { id: accountId, displayName: input.name.trim() || normalizedEmail } });
      await transaction.accountMembership.create({ data: { accountId, userId, role: "owner" } });
      await transaction.authToken.create({
        data: { id: crypto.randomUUID(), userId, purpose: "email_verification", tokenHash: token.hash, expiresAt: tokenExpiry() },
      });
      await this.createSecurityEvent(transaction, userId, "registration_requested", input);
      await this.queueEmail(transaction, {
        userId,
        recipient: normalizedEmail,
        kind: "email_verification",
        idempotencyKey: `email-verification:${userId}:${token.hash}`,
        payload: {
          subject: "Verify your Firecrawl Gateway email",
          html: `<p>Verify your email by visiting <a href="${this.config.publicAppUrl}/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
        },
      });
    });
  }

  async requestEmailVerification(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    await this.transactions.runAsOperator(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { normalizedEmail },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      if (!user || user.emailVerifiedAt) return;
      const token = createOpaqueToken();
      await transaction.authToken.updateMany({
        where: { userId: user.id, purpose: "email_verification", consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await transaction.authToken.create({
        data: { id: crypto.randomUUID(), userId: user.id, purpose: "email_verification", tokenHash: token.hash, expiresAt: tokenExpiry() },
      });
      await this.queueEmail(transaction, {
        userId: user.id,
        recipient: user.email,
        kind: "email_verification",
        idempotencyKey: `email-verification:${user.id}:${token.hash}`,
        payload: {
          subject: "Verify your Firecrawl Gateway email",
          html: `<p>Verify your email by visiting <a href="${this.config.publicAppUrl}/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
        },
      });
    });
  }

  async consumeEmailVerification(token: string): Promise<boolean> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.authToken.findFirst({
        where: {
          purpose: { in: ["email_verification", "email_change"] },
          tokenHash: hashOpaqueToken(token),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true, userId: true, purpose: true, metadata: true },
      });
      if (!row) return false;
      const claimed = await transaction.authToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      const metadata = row.metadata as { email?: string };
      if (row.purpose === "email_change" && metadata.email) {
        await transaction.user.update({
          where: { id: row.userId },
          data: { email: metadata.email, normalizedEmail: metadata.email, emailVerifiedAt: new Date(), authVersion: { increment: 1 }, updatedAt: new Date() },
        });
        await transaction.authSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      } else {
        await transaction.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
      }
      await this.createSecurityEvent(transaction, row.userId, row.purpose === "email_change" ? "email_changed" : "email_verified");
      if (row.purpose === "email_verification") {
        await admitAccountWithClient(asDatabaseClient(transaction), `personal:${row.userId}`);
      }
      return true;
    });
  }

  async requestPasswordReset(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    await this.transactions.runAsOperator(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { normalizedEmail }, select: { id: true, email: true } });
      if (!user) return;
      const token = createOpaqueToken();
      await transaction.authToken.updateMany({
        where: { userId: user.id, purpose: "password_reset", consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await transaction.authToken.create({
        data: { id: crypto.randomUUID(), userId: user.id, purpose: "password_reset", tokenHash: token.hash, expiresAt: tokenExpiry() },
      });
      await this.createSecurityEvent(transaction, user.id, "password_reset_requested");
      await this.queueEmail(transaction, {
        userId: user.id,
        recipient: user.email,
        kind: "password_reset",
        idempotencyKey: `password-reset:${user.id}:${token.hash}`,
        payload: {
          subject: "Reset your Firecrawl Gateway password",
          html: `<p>Reset your password by visiting <a href="${this.config.publicAppUrl}/reset-password?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
        },
      });
    });
  }

  async resetPassword(token: string, password: string): Promise<boolean> {
    const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds);
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.authToken.findFirst({
        where: { purpose: "password_reset", tokenHash: hashOpaqueToken(token), consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, userId: true, user: { select: { email: true } } },
      });
      if (!row) return false;
      const claimed = await transaction.authToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (claimed.count !== 1) return false;
      await transaction.user.update({
        where: { id: row.userId },
        data: { passwordHash, authVersion: { increment: 1 }, updatedAt: new Date() },
      });
      await transaction.authSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.createSecurityEvent(transaction, row.userId, "password_reset_completed");
      await this.queueEmail(transaction, {
        userId: row.userId,
        recipient: row.user.email,
        kind: "password_changed",
        idempotencyKey: `password-changed:${row.userId}:${Date.now()}`,
        payload: {
          subject: "Your Firecrawl Gateway password was changed",
          html: "<p>Your password was changed. If you did not make this change, contact an operator immediately.</p>",
        },
      });
      return true;
    });
  }

  async requestEmailChange(user: User, email: string, metadata: RequestMetadata): Promise<boolean> {
    const normalizedEmail = email.trim().toLowerCase();
    return this.transactions.runAsOperator(async (transaction) => {
      const duplicate = await transaction.user.findFirst({ where: { normalizedEmail, id: { not: user.id } }, select: { id: true } });
      if (duplicate) return false;
      const token = createOpaqueToken();
      const active = await transaction.authToken.findFirst({
        where: { userId: user.id, purpose: "email_change", consumedAt: null },
        select: { id: true },
      });
      const data = {
        tokenHash: token.hash,
        metadata: { email: normalizedEmail } as Prisma.InputJsonValue,
        expiresAt: tokenExpiry(),
        createdAt: new Date(),
      };
      if (active) await transaction.authToken.update({ where: { id: active.id }, data });
      else await transaction.authToken.create({ data: { id: crypto.randomUUID(), userId: user.id, purpose: "email_change", ...data } });
      await this.queueEmail(transaction, {
        userId: user.id,
        recipient: normalizedEmail,
        kind: "email_change",
        idempotencyKey: `email-change:${user.id}:${token.hash}`,
        payload: {
          subject: "Confirm your Firecrawl Gateway email change",
          html: `<p>Confirm this email address by visiting <a href="${this.config.publicAppUrl}/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
        },
      });
      await this.createSecurityEvent(transaction, user.id, "email_change_requested", metadata);
      return true;
    });
  }

  async changePassword(userId: string, password: string, metadata: RequestMetadata): Promise<void> {
    const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds);
    await this.transactions.runAsOperator(async (transaction) => {
      await transaction.user.update({
        where: { id: userId },
        data: { passwordHash, authVersion: { increment: 1 }, updatedAt: new Date() },
      });
      await transaction.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.createSecurityEvent(transaction, userId, "password_changed", metadata);
    });
  }

  verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async createSession(input: { sessionId: string; user: User; mfaVerified?: boolean } & RequestMetadata): Promise<void> {
    const now = Date.now();
    await this.transactions.runAsOperator((transaction) => transaction.authSession.create({
      data: {
        id: crypto.randomUUID(),
        sessionIdHash: hashOpaqueToken(input.sessionId),
        userId: input.user.id,
        authVersion: input.user.auth_version ?? 1,
        mfaVerifiedAt: input.mfaVerified ? new Date(now) : null,
        ipLabel: privacyLabel(input.ip),
        userAgentLabel: privacyLabel(input.userAgent),
        idleExpiresAt: new Date(now + SESSION_IDLE_MS),
        absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      },
    }).then(() => undefined));
  }

  async authorizeSession(sessionId: string, userId: string): Promise<User | null> {
    const user = await this.getUserById(userId);
    if (!user || !this.checkAccess(user).allowed) return null;
    const now = new Date();
    const valid = await this.transactions.runAsOperator((transaction) => transaction.authSession.updateMany({
      where: {
        sessionIdHash: hashOpaqueToken(sessionId),
        userId,
        authVersion: user.auth_version ?? 1,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      data: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS) },
    }));
    return valid.count === 1 ? user : null;
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.transactions.runAsOperator((transaction) => transaction.authSession.updateMany({
      where: { sessionIdHash: hashOpaqueToken(sessionId), revokedAt: null },
      data: { revokedAt: new Date() },
    }).then(() => undefined));
  }

  revokeSessionById(id: string, userId: string, metadata: RequestMetadata): Promise<void> {
    return this.transactions.runAsOperator(async (transaction) => {
      await transaction.authSession.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.createSecurityEvent(transaction, userId, "session_revoked", metadata);
    });
  }

  revokeAllSessions(userId: string, metadata?: RequestMetadata): Promise<void> {
    return this.transactions.runAsOperator(async (transaction) => {
      await transaction.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (metadata) await this.createSecurityEvent(transaction, userId, "sessions_revoked_all", metadata);
    });
  }

  async listSessions(userId: string) {
    const rows = await this.transactions.runAsOperator((transaction) => transaction.authSession.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, createdAt: true, lastSeenAt: true, ipLabel: true, userAgentLabel: true, revokedAt: true },
    }));
    return rows.map((row) => ({
      id: row.id,
      created_at: row.createdAt.toISOString(),
      last_seen_at: row.lastSeenAt.toISOString(),
      ip_label: row.ipLabel,
      user_agent_label: row.userAgentLabel,
      revoked_at: row.revokedAt?.toISOString() ?? null,
    }));
  }

  async getMfaState(userId: string): Promise<{ enabled: boolean; verified: boolean }> {
    const row = await this.transactions.runAsOperator((transaction) => transaction.mfaFactor.findUnique({
      where: { userId },
      select: { enabledAt: true, verifiedAt: true },
    }));
    return row ? { enabled: Boolean(row.enabledAt), verified: Boolean(row.verifiedAt) } : { enabled: false, verified: false };
  }

  async beginMfaSetup(user: User, metadata: RequestMetadata): Promise<{ secret: string; uri: string }> {
    const secret = generateSecret();
    await this.transactions.runAsOperator(async (transaction) => {
      const encrypted = encryptAuthValue(secret, this.config.authEncryptionKey);
      await transaction.mfaFactor.upsert({
        where: { userId: user.id },
        create: {
          id: crypto.randomUUID(),
          userId: user.id,
          secretEncrypted: encrypted,
          pendingSecretEncrypted: encrypted,
          keyVersion: 1,
        },
        update: { pendingSecretEncrypted: encrypted, updatedAt: new Date() },
      });
      await this.createSecurityEvent(transaction, user.id, "mfa_setup_started", metadata);
    });
    return { secret, uri: generateURI({ issuer: "Firecrawl Gateway", label: user.email, secret }) };
  }

  async verifyMfaCode(userId: string, code: string, allowPending = false): Promise<boolean> {
    const factor = await this.transactions.runAsOperator((transaction) => transaction.mfaFactor.findUnique({ where: { userId } }));
    if (!factor) return false;
    const encrypted = allowPending ? (factor.pendingSecretEncrypted ?? factor.secretEncrypted) : factor.secretEncrypted;
    const secret = decryptAuthValue(encrypted, this.config.authEncryptionKey);
    const result = await verify({ secret, token: code.replace(/\s/g, ""), epochTolerance: [30, 0] });
    if (!result.valid || !("timeStep" in result) || typeof result.timeStep !== "number") return false;
    return this.transactions.runAsOperator(async (transaction) => {
      const current = await transaction.mfaFactor.findUnique({ where: { userId } });
      if (!current) return false;
      const stepAllowed = current.lastUsedStep === null || current.lastUsedStep < BigInt(result.timeStep);
      const pendingMatches = current.pendingSecretEncrypted === encrypted;
      const initialMatches = current.enabledAt === null && current.secretEncrypted === encrypted;
      const pendingAllowed = allowPending && (pendingMatches || initialMatches);
      const normalAllowed = !allowPending && current.enabledAt !== null && current.secretEncrypted === encrypted;
      if ((!pendingAllowed && !normalAllowed) || !stepAllowed) return false;
      await transaction.mfaFactor.update({
        where: { userId },
        data: {
          secretEncrypted: pendingMatches ? current.pendingSecretEncrypted! : current.secretEncrypted,
          pendingSecretEncrypted: pendingAllowed ? null : current.pendingSecretEncrypted,
          verifiedAt: new Date(),
          enabledAt: new Date(),
          lastUsedStep: BigInt(result.timeStep),
          updatedAt: new Date(),
        },
      });
      return true;
    });
  }

  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    return this.transactions.runAsOperator(async (transaction) => {
      const row = await transaction.mfaRecoveryCode.findFirst({
        where: { userId, codeHash: hashRecoveryCode(code), consumedAt: null },
        select: { id: true },
      });
      if (!row) return false;
      const result = await transaction.mfaRecoveryCode.updateMany({
        where: { id: row.id, userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count === 1;
    });
  }

  async createRecoveryCodes(userId: string, eventType = "mfa_enabled", metadata?: RequestMetadata): Promise<string[]> {
    const codes = Array.from({ length: 10 }, generateRecoveryCode);
    await this.transactions.runAsOperator(async (transaction) => {
      await transaction.mfaRecoveryCode.deleteMany({ where: { userId } });
      await transaction.mfaRecoveryCode.createMany({
        data: codes.map((code) => ({ id: crypto.randomUUID(), userId, codeHash: hashRecoveryCode(code) })),
      });
      await this.createSecurityEvent(transaction, userId, eventType, metadata);
    });
    return codes;
  }

  async disableMfa(userId: string): Promise<void> {
    await this.transactions.runAsOperator(async (transaction) => {
      await transaction.mfaRecoveryCode.deleteMany({ where: { userId } });
      await transaction.mfaFactor.deleteMany({ where: { userId } });
      await transaction.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.createSecurityEvent(transaction, userId, "mfa_disabled");
    });
  }

  markSessionMfaVerified(sessionId: string, user: User): Promise<void> {
    return this.transactions.runAsOperator((transaction) => transaction.authSession.updateMany({
      where: { sessionIdHash: hashOpaqueToken(sessionId), userId: user.id, authVersion: user.auth_version ?? 1, revokedAt: null },
      data: { mfaVerifiedAt: new Date() },
    }).then(() => undefined));
  }

  private async updatePasswordHash(userId: string, passwordHash: string): Promise<User | null> {
    return this.transactions.runAsOperator(async (transaction) => mapUser(await transaction.user.update({
      where: { id: userId },
      data: { passwordHash, updatedAt: new Date() },
      select: userSelect,
    })));
  }

  private async reactivateExpiredSuspension(transaction: Transaction, row: UserRow | null): Promise<User | null> {
    if (!row) return null;
    if (row.status !== "suspended" || !row.suspendedUntil || row.suspendedUntil.getTime() > Date.now()) return mapUser(row);
    const reactivated = await transaction.user.update({
      where: { id: row.id },
      data: { status: "active", suspendedUntil: null, updatedAt: new Date() },
      select: userSelect,
    });
    const accountId = row.memberships[0]?.accountId ?? `personal:${row.id}`;
    await resumeAccountEntitlementsWithClient(asDatabaseClient(transaction), accountId);
    return mapUser(reactivated);
  }

  private createSecurityEvent(
    transaction: Transaction,
    userId: string | null,
    eventType: string,
    metadata: RequestMetadata = {},
  ): Promise<unknown> {
    return transaction.securityEvent.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        eventType,
        ipLabel: privacyLabel(metadata.ip),
        userAgentLabel: privacyLabel(metadata.userAgent),
      },
    });
  }

  private async queueEmail(transaction: Transaction, input: {
    userId?: string;
    recipient: string;
    kind: string;
    idempotencyKey: string;
    payload: EmailPayload;
  }): Promise<void> {
    await transaction.emailOutbox.createMany({
      data: {
        id: crypto.randomUUID(),
        idempotencyKey: input.idempotencyKey,
        userId: input.userId ?? null,
        kind: input.kind,
        recipient: input.recipient,
        payloadEncrypted: encryptAuthValue(JSON.stringify(input.payload), this.config.authEncryptionKey),
      },
      skipDuplicates: true,
    });
  }
}
