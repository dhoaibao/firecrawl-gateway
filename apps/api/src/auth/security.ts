import crypto from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { withOperatorTransaction } from "../infrastructure/database";
import { encryptAuthValue, decryptAuthValue } from "./crypto";
import { generateRecoveryCode, hashOpaqueToken, hashRecoveryCode } from "./tokens";

const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export function privacyLabel(value: string | undefined, max = 96): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, max);
}

export async function recordSecurityEvent(input: {
  userId?: string | null;
  type: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withOperatorTransaction((tx) => tx.securityEvent.create({
    data: {
      id: crypto.randomUUID(),
      userId: input.userId ?? null,
      eventType: input.type,
      ipLabel: privacyLabel(input.ip),
      userAgentLabel: privacyLabel(input.userAgent),
      metadata: (input.metadata ?? {}) as object,
    },
  }).then(() => undefined));
}

export async function createSessionRecord(input: {
  sessionId: string;
  userId: string;
  authVersion: number;
  mfaVerified?: boolean;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const now = Date.now();
  await withOperatorTransaction((tx) => tx.authSession.create({
    data: {
      id: crypto.randomUUID(),
      sessionIdHash: hashOpaqueToken(input.sessionId),
      userId: input.userId,
      authVersion: input.authVersion,
      mfaVerifiedAt: input.mfaVerified ? new Date(now) : null,
      ipLabel: privacyLabel(input.ip),
      userAgentLabel: privacyLabel(input.userAgent),
      idleExpiresAt: new Date(now + SESSION_IDLE_MS),
      absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_MS),
    },
  }).then(() => undefined));
}

export async function validateAndTouchSession(sessionId: string, userId: string, authVersion: number): Promise<boolean> {
  const now = new Date();
  const result = await withOperatorTransaction((tx) => tx.authSession.updateMany({
    where: {
      sessionIdHash: hashOpaqueToken(sessionId),
      userId,
      authVersion,
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    data: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS) },
  }));
  return result.count === 1;
}

export async function sessionHasMfaVerification(sessionId: string, userId: string, authVersion: number): Promise<boolean> {
  const now = new Date();
  const row = await withOperatorTransaction((tx) => tx.authSession.findFirst({
    where: {
      sessionIdHash: hashOpaqueToken(sessionId),
      userId,
      authVersion,
      mfaVerifiedAt: { not: null },
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    select: { id: true },
  }));
  return Boolean(row);
}

export async function markSessionMfaVerified(sessionId: string, userId: string, authVersion: number): Promise<void> {
  await withOperatorTransaction((tx) => tx.authSession.updateMany({
    where: { sessionIdHash: hashOpaqueToken(sessionId), userId, authVersion, revokedAt: null },
    data: { mfaVerifiedAt: new Date() },
  }).then(() => undefined));
}

export async function revokeSession(sessionId: string): Promise<void> {
  await withOperatorTransaction((tx) => tx.authSession.updateMany({
    where: { sessionIdHash: hashOpaqueToken(sessionId), revokedAt: null },
    data: { revokedAt: new Date() },
  }).then(() => undefined));
}

export async function revokeSessionById(id: string, userId: string): Promise<void> {
  await withOperatorTransaction((tx) => tx.authSession.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  }).then(() => undefined));
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await withOperatorTransaction((tx) => tx.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  }).then(() => undefined));
}

export async function listSessions(userId: string) {
  const rows = await withOperatorTransaction((tx) => tx.authSession.findMany({
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

export async function getMfaState(userId: string): Promise<{ enabled: boolean; verified: boolean }> {
  const row = await withOperatorTransaction((tx) => tx.mfaFactor.findUnique({
    where: { userId },
    select: { enabledAt: true, verifiedAt: true },
  }));
  return row ? { enabled: Boolean(row.enabledAt), verified: Boolean(row.verifiedAt) } : { enabled: false, verified: false };
}

export async function beginMfaSetup(userId: string, email: string, encryptionKey: string) {
  const secret = generateSecret();
  await withOperatorTransaction((tx) => tx.mfaFactor.upsert({
    where: { userId },
    create: {
      id: crypto.randomUUID(),
      userId,
      secretEncrypted: encryptAuthValue(secret, encryptionKey),
      pendingSecretEncrypted: encryptAuthValue(secret, encryptionKey),
      keyVersion: 1,
    },
    update: { pendingSecretEncrypted: encryptAuthValue(secret, encryptionKey), updatedAt: new Date() },
  }).then(() => undefined));
  return { secret, uri: generateURI({ issuer: "Firecrawl Gateway", label: email, secret }) };
}

async function getSecret(userId: string, encryptionKey: string, pending = false): Promise<string | null> {
  const row = await withOperatorTransaction((tx) => tx.mfaFactor.findUnique({
    where: { userId },
    select: { secretEncrypted: true, pendingSecretEncrypted: true },
  }));
  if (!row) return null;
  const encrypted = pending ? (row.pendingSecretEncrypted ?? row.secretEncrypted) : row.secretEncrypted;
  return decryptAuthValue(encrypted, encryptionKey);
}

export async function verifyMfaCode(userId: string, code: string, encryptionKey: string, allowPending = false): Promise<boolean> {
  const secret = await getSecret(userId, encryptionKey, allowPending);
  if (!secret) return false;
  const result = await verify({ secret, token: code.replace(/\s/g, ""), epochTolerance: [30, 0] });
  if (!result.valid || !("timeStep" in result) || typeof result.timeStep !== "number") return false;

  return withOperatorTransaction(async (tx) => {
    const factor = await tx.mfaFactor.findUnique({ where: { userId } });
    if (!factor) return false;
    const stepAllowed = factor.lastUsedStep === null || factor.lastUsedStep < BigInt(result.timeStep);
    const pendingAllowed = allowPending && factor.pendingSecretEncrypted !== null;
    const normalAllowed = !allowPending && factor.enabledAt !== null;
    if ((!pendingAllowed && !normalAllowed) || !stepAllowed) return false;
    await tx.mfaFactor.update({
      where: { userId },
      data: {
        secretEncrypted: pendingAllowed ? factor.pendingSecretEncrypted! : factor.secretEncrypted,
        pendingSecretEncrypted: pendingAllowed ? null : factor.pendingSecretEncrypted,
        verifiedAt: new Date(),
        enabledAt: new Date(),
        lastUsedStep: BigInt(result.timeStep),
        updatedAt: new Date(),
      },
    });
    return true;
  });
}

export async function disableMfa(userId: string): Promise<void> {
  await withOperatorTransaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaFactor.deleteMany({ where: { userId } });
    await tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId, eventType: "mfa_disabled" } });
  });
}

export async function createRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  await withOperatorTransaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ id: crypto.randomUUID(), userId, codeHash: hashRecoveryCode(code) })),
    });
  });
  return codes;
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const row = await withOperatorTransaction((tx) => tx.mfaRecoveryCode.findFirst({
    where: { userId, codeHash: hashRecoveryCode(code), consumedAt: null },
    select: { id: true },
  }));
  if (!row) return false;
  const result = await withOperatorTransaction((tx) => tx.mfaRecoveryCode.updateMany({
    where: { id: row.id, userId, consumedAt: null },
    data: { consumedAt: new Date() },
  }));
  return result.count === 1;
}
