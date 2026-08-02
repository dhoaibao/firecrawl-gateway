import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { asDatabaseClient } from "../db";
import { withOperatorTransaction } from "../infrastructure/database";
import { hashPassword } from "./password";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";
import { queueEmail } from "./email";
import { admitAccountWithClient } from "../quota/service";
import type { User } from "../types";

export const GENERIC_AUTH_MESSAGE = "If the account can be processed, you will receive an email shortly.";
const TOKEN_TTL_MS = 30 * 60 * 1000;

const userSelect = {
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
} satisfies Prisma.UserSelect;

function toUser(row: Prisma.UserGetPayload<{ select: typeof userSelect }>, accountId: string): User {
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

function label(value: string | undefined): string | null {
  return value ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 96) : null;
}

function tokenExpiry(): Date {
  return new Date(Date.now() + TOKEN_TTL_MS);
}

export async function registerUser(input: {
  email: string;
  name: string;
  password: string;
  encryptionKey: string;
  baseUrl: string;
  ip?: string;
  userAgent?: string;
  isAdmin?: boolean;
}): Promise<User | null> {
  const normalized = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return withOperatorTransaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { normalizedEmail: normalized }, select: { id: true } });
    if (existing) return null;

    const userId = crypto.randomUUID();
    const token = createOpaqueToken();
    const user = await tx.user.create({
      data: {
        id: userId,
        email: input.email.trim(),
        normalizedEmail: normalized,
        name: input.name.trim(),
        passwordHash,
        isAdmin: input.isAdmin === true,
        platformRole: input.isAdmin ? "admin" : "user",
        status: "active",
        authVersion: 1,
      },
      select: userSelect,
    });
    const accountId = `personal:${userId}`;
    await tx.account.create({ data: { id: accountId, displayName: input.name.trim() || normalized } });
    await tx.accountMembership.create({ data: { accountId, userId, role: "owner" } });
    await tx.authToken.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        purpose: "email_verification",
        tokenHash: token.hash,
        expiresAt: tokenExpiry(),
      },
    });
    await tx.securityEvent.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        eventType: "registration_requested",
        ipLabel: label(input.ip),
        userAgentLabel: label(input.userAgent),
      },
    });
    await queueEmail({
      client: tx,
      userId,
      recipient: normalized,
      kind: "email_verification",
      idempotencyKey: `email-verification:${userId}:${token.hash}`,
      payload: {
        subject: "Verify your Firecrawl Gateway email",
        html: `<p>Verify your email by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
      },
      encryptionKey: input.encryptionKey,
    });
    return toUser(user, accountId);
  });
}

export async function requestEmailVerification(input: { email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { normalizedEmail: normalized },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt) return;
    const token = createOpaqueToken();
    await tx.authToken.updateMany({
      where: { userId: user.id, purpose: "email_verification", consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.authToken.create({
      data: { id: crypto.randomUUID(), userId: user.id, purpose: "email_verification", tokenHash: token.hash, expiresAt: tokenExpiry() },
    });
    await queueEmail({
      client: tx,
      userId: user.id,
      recipient: user.email,
      kind: "email_verification",
      idempotencyKey: `email-verification:${user.id}:${token.hash}`,
      payload: {
        subject: "Verify your Firecrawl Gateway email",
        html: `<p>Verify your email by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
      },
      encryptionKey: input.encryptionKey,
    });
  });
}

export async function requestEmailChange(input: { userId: string; email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (tx) => {
    const duplicate = await tx.user.findFirst({ where: { normalizedEmail: normalized, id: { not: input.userId } }, select: { id: true } });
    if (duplicate) throw new Error("Email is already in use");
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { email: true } });
    if (!user) return;

    const token = createOpaqueToken();
    const active = await tx.authToken.findFirst({ where: { userId: input.userId, purpose: "email_change", consumedAt: null }, select: { id: true } });
    const data = {
      tokenHash: token.hash,
      metadata: { email: normalized } as Prisma.InputJsonValue,
      expiresAt: tokenExpiry(),
      createdAt: new Date(),
    };
    if (active) await tx.authToken.update({ where: { id: active.id }, data });
    else await tx.authToken.create({ data: { id: crypto.randomUUID(), userId: input.userId, purpose: "email_change", ...data } });

    await queueEmail({
      client: tx,
      userId: input.userId,
      recipient: normalized,
      kind: "email_change",
      idempotencyKey: `email-change:${input.userId}:${token.hash}`,
      payload: {
        subject: "Confirm your Firecrawl Gateway email change",
        html: `<p>Confirm this email address by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
      },
      encryptionKey: input.encryptionKey,
    });
  });
}

export async function consumeEmailVerification(token: string): Promise<boolean> {
  const tokenHash = hashOpaqueToken(token);
  return withOperatorTransaction(async (tx) => {
    const row = await tx.authToken.findFirst({
      where: { purpose: { in: ["email_verification", "email_change"] }, tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true, purpose: true, metadata: true },
    });
    if (!row) return false;
    const claimed = await tx.authToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) return false;

    const metadata = row.metadata as { email?: string };
    if (row.purpose === "email_change" && metadata.email) {
      await tx.user.update({
        where: { id: row.userId },
        data: { email: metadata.email, normalizedEmail: metadata.email, emailVerifiedAt: new Date(), authVersion: { increment: 1 }, updatedAt: new Date() },
      });
      await tx.authSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    } else {
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
    }
    await tx.securityEvent.create({
      data: { id: crypto.randomUUID(), userId: row.userId, eventType: row.purpose === "email_change" ? "email_changed" : "email_verified" },
    });
    if (row.purpose === "email_verification") {
      await admitAccountWithClient(asDatabaseClient(tx), `personal:${row.userId}`);
    }
    return true;
  });
}

export async function requestPasswordReset(input: { email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { normalizedEmail: normalized }, select: { id: true, email: true } });
    if (!user) return;
    const token = createOpaqueToken();
    await tx.authToken.updateMany({ where: { userId: user.id, purpose: "password_reset", consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.authToken.create({ data: { id: crypto.randomUUID(), userId: user.id, purpose: "password_reset", tokenHash: token.hash, expiresAt: tokenExpiry() } });
    await tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId: user.id, eventType: "password_reset_requested" } });
    await queueEmail({
      client: tx,
      userId: user.id,
      recipient: user.email,
      kind: "password_reset",
      idempotencyKey: `password-reset:${user.id}:${token.hash}`,
      payload: {
        subject: "Reset your Firecrawl Gateway password",
        html: `<p>Reset your password by visiting <a href="${input.baseUrl}/admin/reset-password?token=${encodeURIComponent(token.token)}">this link</a>.</p>`,
      },
      encryptionKey: input.encryptionKey,
    });
  });
}

export async function resetPassword(token: string, password: string, encryptionKey?: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const tokenHash = hashOpaqueToken(token);
  return withOperatorTransaction(async (tx) => {
    const row = await tx.authToken.findFirst({
      where: { purpose: "password_reset", tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true, user: { select: { email: true } } },
    });
    if (!row) return false;
    const claimed = await tx.authToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) return false;
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, authVersion: { increment: 1 }, updatedAt: new Date() } });
    await tx.authSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId: row.userId, eventType: "password_reset_completed" } });
    if (encryptionKey) {
      await queueEmail({
        client: tx,
        userId: row.userId,
        recipient: row.user.email,
        kind: "password_changed",
        idempotencyKey: `password-changed:${row.userId}:${Date.now()}`,
        payload: { subject: "Your Firecrawl Gateway password was changed", html: "<p>Your password was changed. If you did not make this change, contact an operator immediately.</p>" },
        encryptionKey,
      });
    }
    return true;
  });
}
