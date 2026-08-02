import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { withAccountTransaction, withOperatorTransaction } from "../infrastructure/database";
import { decryptProviderCredential, encryptProviderCredential, maskCredential, type CredentialContext } from "./crypto";

export type CredentialPurpose = CredentialContext["purpose"];
export type CredentialStatus = "pending" | "valid" | "invalid" | "revoked";

export interface ProviderCredentialRecord {
  id: string;
  owner_type: "account" | "operator";
  account_id: string | null;
  purpose: CredentialPurpose;
  encrypted_value: string;
  key_version: number;
  masked_prefix: string;
  masked_suffix: string;
  status: CredentialStatus;
  provider_metadata: Record<string, unknown>;
  last_validated_at: string | null;
  last_used_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CredentialMetadata extends Omit<ProviderCredentialRecord, "encrypted_value"> {}

export interface CreateCredentialInput {
  value: string;
  purpose: CredentialPurpose;
  /** Required only for an operator credential bound to an infrastructure source. */
  sourceId?: string;
  keyVersion: number;
  providerMetadata?: Record<string, unknown>;
}

const credentialSelect = Prisma.validator<Prisma.ProviderCredentialSelect>()({
  id: true,
  ownerType: true,
  accountId: true,
  purpose: true,
  encryptedValue: true,
  keyVersion: true,
  maskedPrefix: true,
  maskedSuffix: true,
  status: true,
  providerMetadata: true,
  lastValidatedAt: true,
  lastUsedAt: true,
  supersededAt: true,
  createdAt: true,
  updatedAt: true,
});

type CredentialRow = Prisma.ProviderCredentialGetPayload<{ select: typeof credentialSelect }>;

function jsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(row: CredentialRow): ProviderCredentialRecord {
  return {
    id: row.id,
    owner_type: row.ownerType as ProviderCredentialRecord["owner_type"],
    account_id: row.accountId,
    purpose: row.purpose as CredentialPurpose,
    encrypted_value: row.encryptedValue,
    key_version: row.keyVersion,
    masked_prefix: row.maskedPrefix,
    masked_suffix: row.maskedSuffix,
    status: row.status as CredentialStatus,
    provider_metadata: row.providerMetadata as Record<string, unknown>,
    last_validated_at: row.lastValidatedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    superseded_at: row.supersededAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function metadata(value: ProviderCredentialRecord): CredentialMetadata {
  const { encrypted_value: _encryptedValue, ...safe } = value;
  return safe;
}

export function accountCredentialSourceId(accountId: string, credentialId: string): string {
  return `account:${accountId}:${credentialId}`;
}

function contextFor(recordValue: ProviderCredentialRecord, sourceId: string): CredentialContext {
  return {
    purpose: recordValue.purpose,
    ownerId: recordValue.owner_type === "account" ? recordValue.account_id! : "operator",
    sourceId,
    keyVersion: recordValue.key_version,
  };
}

export async function createAccountCredential(
  accountId: string,
  input: CreateCredentialInput,
  encryptionKey: string,
): Promise<CredentialMetadata> {
  const id = crypto.randomUUID();
  const masked = maskCredential(input.value);
  const encryptedValue = encryptProviderCredential(input.value, encryptionKey, {
    purpose: input.purpose,
    ownerId: accountId,
    sourceId: accountCredentialSourceId(accountId, id),
    keyVersion: input.keyVersion,
  });
  return withAccountTransaction(accountId, async (tx) => {
    const created = await tx.providerCredential.create({
      data: {
        id,
        ownerType: "account",
        accountId,
        purpose: input.purpose,
        encryptedValue,
        keyVersion: input.keyVersion,
        maskedPrefix: masked.prefix,
        maskedSuffix: masked.suffix,
        providerMetadata: jsonValue(input.providerMetadata ?? {}),
      },
      select: credentialSelect,
    });
    return metadata(record(created));
  });
}

export async function createOperatorCredential(
  input: CreateCredentialInput,
  encryptionKey: string,
): Promise<CredentialMetadata> {
  const id = crypto.randomUUID();
  if (!input.sourceId?.trim()) throw new Error("Operator credentials require an infrastructure source ID");
  const masked = maskCredential(input.value);
  const encryptedValue = encryptProviderCredential(input.value, encryptionKey, {
    purpose: input.purpose,
    ownerId: "operator",
    sourceId: input.sourceId,
    keyVersion: input.keyVersion,
  });
  return withOperatorTransaction(async (tx) => {
    const created = await tx.providerCredential.create({
      data: {
        id,
        ownerType: "operator",
        purpose: input.purpose,
        encryptedValue,
        keyVersion: input.keyVersion,
        maskedPrefix: masked.prefix,
        maskedSuffix: masked.suffix,
        providerMetadata: jsonValue(input.providerMetadata ?? {}),
      },
      select: credentialSelect,
    });
    return metadata(record(created));
  });
}

export async function replaceAccountCredential(
  accountId: string,
  previousId: string,
  input: CreateCredentialInput,
  encryptionKey: string,
): Promise<CredentialMetadata | null> {
  return withAccountTransaction(accountId, async (tx) => {
    const previous = await tx.providerCredential.updateMany({
      where: { id: previousId, accountId, ownerType: "account", supersededAt: null },
      data: { supersededAt: new Date(), status: "revoked", updatedAt: new Date() },
    });
    if (previous.count === 0) return null;

    const id = crypto.randomUUID();
    const masked = maskCredential(input.value);
    const encryptedValue = encryptProviderCredential(input.value, encryptionKey, {
      purpose: input.purpose,
      ownerId: accountId,
      sourceId: accountCredentialSourceId(accountId, id),
      keyVersion: input.keyVersion,
    });
    const created = await tx.providerCredential.create({
      data: {
        id,
        ownerType: "account",
        accountId,
        purpose: input.purpose,
        encryptedValue,
        keyVersion: input.keyVersion,
        maskedPrefix: masked.prefix,
        maskedSuffix: masked.suffix,
        providerMetadata: jsonValue(input.providerMetadata ?? {}),
      },
      select: credentialSelect,
    });
    return metadata(record(created));
  });
}

export async function deleteAccountCredential(accountId: string, credentialId: string): Promise<boolean> {
  return withAccountTransaction(accountId, async (tx) => {
    const result = await tx.providerCredential.updateMany({
      where: { id: credentialId, accountId, ownerType: "account", supersededAt: null, status: { not: "revoked" } },
      data: { status: "revoked", supersededAt: new Date(), updatedAt: new Date() },
    });
    return result.count === 1;
  });
}

export async function listAccountCredentialMetadata(accountId: string): Promise<CredentialMetadata[]> {
  return withAccountTransaction(accountId, async (tx) => {
    const rows = await tx.providerCredential.findMany({
      where: { accountId, ownerType: "account" },
      orderBy: { createdAt: "desc" },
      select: credentialSelect,
    });
    return rows.map((row) => metadata(record(row)));
  });
}

export async function validateAccountCredential(
  accountId: string,
  credentialId: string,
  encryptionKey: string,
  cloudBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialMetadata | null> {
  const credential = await withAccountTransaction(accountId, (tx) =>
    tx.providerCredential.findFirst({
      where: { id: credentialId, accountId, ownerType: "account", status: { not: "revoked" }, supersededAt: null },
      select: credentialSelect,
    }).then((row) => row ? record(row) : null));
  if (!credential) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let valid = false;
  try {
    const value = decryptProviderCredential(
      credential.encrypted_value,
      encryptionKey,
      contextFor(credential, accountCredentialSourceId(accountId, credential.id)),
    );
    const response = await fetchImpl(`${cloudBaseUrl.replace(/\/+$/, "")}/v2/team/credit-usage`, {
      headers: { authorization: `Bearer ${value}` },
      signal: controller.signal,
    });
    valid = response.ok;
  } catch {
    valid = false;
  } finally {
    clearTimeout(timeout);
  }

  return withAccountTransaction(accountId, async (tx) => {
    const updated = await tx.providerCredential.updateMany({
      where: { id: credentialId, accountId },
      data: { status: valid ? "valid" : "invalid", lastValidatedAt: new Date(), updatedAt: new Date() },
    });
    if (updated.count === 0) return null;
    const row = await tx.providerCredential.findUnique({ where: { id: credentialId }, select: credentialSelect });
    return row ? metadata(record(row)) : null;
  });
}

export async function decryptOperatorCredential(
  credentialId: string,
  sourceId: string,
  encryptionKey: string,
): Promise<{ value: string; credential: CredentialMetadata } | null> {
  return withOperatorTransaction(async (tx) => {
    const row = await tx.providerCredential.findFirst({
      where: { id: credentialId, ownerType: "operator", status: { not: "revoked" }, supersededAt: null },
      select: credentialSelect,
    });
    if (!row) return null;
    const credential = record(row);
    return {
      value: decryptProviderCredential(credential.encrypted_value, encryptionKey, contextFor(credential, sourceId)),
      credential: metadata(credential),
    };
  });
}

/** Explicit operator action for pending credentials. */
export async function validateOperatorCredential(
  credentialId: string,
  sourceId: string,
  encryptionKey: string,
  cloudBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialMetadata | null> {
  const decrypted = await decryptOperatorCredential(credentialId, sourceId, encryptionKey);
  if (!decrypted) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let status: Extract<CredentialStatus, "valid" | "invalid"> = "invalid";
  try {
    const response = await fetchImpl(`${cloudBaseUrl.replace(/\/+$/, "")}/v2/team/credit-usage`, {
      headers: { authorization: `Bearer ${decrypted.value}` },
      signal: controller.signal,
    });
    status = response.ok ? "valid" : "invalid";
  } catch {
    status = "invalid";
  } finally {
    clearTimeout(timeout);
  }
  await markCredentialValidated(credentialId, status);
  return { ...decrypted.credential, status, last_validated_at: new Date().toISOString() };
}

export async function markCredentialValidated(
  credentialId: string,
  status: Extract<CredentialStatus, "valid" | "invalid">,
): Promise<void> {
  await withOperatorTransaction((tx) => tx.providerCredential.updateMany({
    where: { id: credentialId },
    data: { status, lastValidatedAt: new Date(), updatedAt: new Date() },
  }).then(() => undefined));
}

export async function touchCredential(credentialId: string): Promise<void> {
  await withOperatorTransaction((tx) => tx.providerCredential.updateMany({
    where: { id: credentialId },
    data: { lastUsedAt: new Date(), updatedAt: new Date() },
  }).then(() => undefined));
}

/** Operational re-encryption primitive. Returns only a count. */
export async function rotateProviderCredentials(
  oldKey: string,
  newKey: string,
  newKeyVersion: number,
): Promise<number> {
  if (!Number.isInteger(newKeyVersion) || newKeyVersion < 1) {
    throw new Error("New provider credential key version must be a positive integer");
  }
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.providerCredential.findMany({
      where: { status: { not: "revoked" } },
      select: { ...credentialSelect, sources: { select: { id: true }, take: 1 } },
    });
    for (const row of rows) {
      const credential = record(row);
      const sourceId = credential.owner_type === "account"
        ? accountCredentialSourceId(credential.account_id!, credential.id)
        : row.sources[0]?.id;
      if (!sourceId) throw new Error("Operator credential is not bound to an infrastructure source");
      const oldContext = contextFor(credential, sourceId);
      const plaintext = decryptProviderCredential(credential.encrypted_value, oldKey, oldContext);
      const encryptedValue = encryptProviderCredential(plaintext, newKey, {
        ...oldContext,
        keyVersion: newKeyVersion,
      });
      await tx.providerCredential.update({
        where: { id: credential.id },
        data: { encryptedValue, keyVersion: newKeyVersion, updatedAt: new Date() },
      });
    }
    return rows.length;
  });
}
