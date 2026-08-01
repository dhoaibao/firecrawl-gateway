import crypto from "node:crypto";
import { withAccountTransaction, withOperatorTransaction } from "../db";
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

function metadata(record: ProviderCredentialRecord): CredentialMetadata {
  const { encrypted_value: _encryptedValue, ...safe } = record;
  return safe;
}

export function accountCredentialSourceId(accountId: string, credentialId: string): string {
  return `account:${accountId}:${credentialId}`;
}

function contextFor(record: ProviderCredentialRecord, sourceId: string): CredentialContext {
  return {
    purpose: record.purpose,
    ownerId: record.owner_type === "account" ? record.account_id! : "operator",
    sourceId,
    keyVersion: record.key_version,
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
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `INSERT INTO provider_credentials (
        id, owner_type, account_id, purpose, encrypted_value, key_version,
        masked_prefix, masked_suffix, provider_metadata
      ) VALUES ($1, 'account', $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [id, accountId, input.purpose, encryptedValue, input.keyVersion, masked.prefix, masked.suffix, input.providerMetadata ?? {}],
    );
    return metadata(result.rows[0]);
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
  return withOperatorTransaction(async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `INSERT INTO provider_credentials (
        id, owner_type, purpose, encrypted_value, key_version,
        masked_prefix, masked_suffix, provider_metadata
      ) VALUES ($1, 'operator', $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [id, input.purpose, encryptedValue, input.keyVersion, masked.prefix, masked.suffix, input.providerMetadata ?? {}],
    );
    return metadata(result.rows[0]);
  });
}

export async function replaceAccountCredential(
  accountId: string,
  previousId: string,
  input: CreateCredentialInput,
  encryptionKey: string,
): Promise<CredentialMetadata | null> {
  return withAccountTransaction(accountId, async (client) => {
    const previous = await client.query<Pick<ProviderCredentialRecord, "id">>(
      `UPDATE provider_credentials
       SET superseded_at = NOW(), status = 'revoked', updated_at = NOW()
       WHERE id = $1 AND account_id = $2 AND owner_type = 'account' AND superseded_at IS NULL
       RETURNING id`,
      [previousId, accountId],
    );
    if (!previous.rows[0]) return null;

    const id = crypto.randomUUID();
    const masked = maskCredential(input.value);
    const encryptedValue = encryptProviderCredential(input.value, encryptionKey, {
      purpose: input.purpose,
      ownerId: accountId,
      sourceId: accountCredentialSourceId(accountId, id),
      keyVersion: input.keyVersion,
    });
    const result = await client.query<ProviderCredentialRecord>(
      `INSERT INTO provider_credentials (
        id, owner_type, account_id, purpose, encrypted_value, key_version,
        masked_prefix, masked_suffix, provider_metadata
      ) VALUES ($1, 'account', $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [id, accountId, input.purpose, encryptedValue, input.keyVersion, masked.prefix, masked.suffix, input.providerMetadata ?? {}],
    );
    return metadata(result.rows[0]);
  });
}

export async function listAccountCredentialMetadata(accountId: string): Promise<CredentialMetadata[]> {
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `SELECT * FROM provider_credentials
       WHERE account_id = $1 AND owner_type = 'account'
       ORDER BY created_at DESC`,
      [accountId],
    );
    return result.rows.map(metadata);
  });
}

export async function validateAccountCredential(
  accountId: string,
  credentialId: string,
  encryptionKey: string,
  cloudBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialMetadata | null> {
  const credential = await withAccountTransaction(accountId, async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `SELECT * FROM provider_credentials
       WHERE id = $1 AND account_id = $2 AND owner_type = 'account' AND status != 'revoked' AND superseded_at IS NULL`,
      [credentialId, accountId],
    );
    return result.rows[0] ?? null;
  });
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

  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `UPDATE provider_credentials
       SET status = $3, last_validated_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND account_id = $2
       RETURNING *`,
      [credentialId, accountId, valid ? "valid" : "invalid"],
    );
    return result.rows[0] ? metadata(result.rows[0]) : null;
  });
}

export async function decryptOperatorCredential(
  credentialId: string,
  sourceId: string,
  encryptionKey: string,
): Promise<{ value: string; credential: CredentialMetadata } | null> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<ProviderCredentialRecord>(
      `SELECT * FROM provider_credentials
       WHERE id = $1 AND owner_type = 'operator' AND status != 'revoked' AND superseded_at IS NULL`,
      [credentialId],
    );
    const credential = result.rows[0];
    if (!credential) return null;
    return {
      value: decryptProviderCredential(credential.encrypted_value, encryptionKey, contextFor(credential, sourceId)),
      credential: metadata(credential),
    };
  });
}

/**
 * Explicit operator action for pending credentials. Callers decide when an
 * external health check is approved; this repository never validates on read.
 */
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
  await withOperatorTransaction(async (client) => {
    await client.query(
      `UPDATE provider_credentials
       SET status = $2, last_validated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [credentialId, status],
    );
  });
}

export async function touchCredential(credentialId: string): Promise<void> {
  await withOperatorTransaction(async (client) => {
    await client.query("UPDATE provider_credentials SET last_used_at = NOW(), updated_at = NOW() WHERE id = $1", [credentialId]);
  });
}

/**
 * Operational re-encryption primitive. Operators provide the old and new keys
 * out of band; this function returns only a count and never serializes secrets.
 */
export async function rotateProviderCredentials(
  oldKey: string,
  newKey: string,
  newKeyVersion: number,
): Promise<number> {
  if (!Number.isInteger(newKeyVersion) || newKeyVersion < 1) {
    throw new Error("New provider credential key version must be a positive integer");
  }
  return withOperatorTransaction(async (client) => {
    const result = await client.query<ProviderCredentialRecord & { source_id: string | null }>(
      `SELECT c.*, s.id AS source_id
       FROM provider_credentials c
       LEFT JOIN infrastructure_sources s ON s.credential_id = c.id
       WHERE c.status != 'revoked'`,
    );
    for (const credential of result.rows) {
      const sourceId = credential.owner_type === "account"
        ? `account:${credential.account_id}:${credential.id}`
        : credential.source_id;
      if (!sourceId) throw new Error("Operator credential is not bound to an infrastructure source");
      const oldContext = contextFor(credential, sourceId);
      const plaintext = decryptProviderCredential(credential.encrypted_value, oldKey, oldContext);
      const encryptedValue = encryptProviderCredential(plaintext, newKey, {
        ...oldContext,
        keyVersion: newKeyVersion,
      });
      await client.query(
        `UPDATE provider_credentials
         SET encrypted_value = $2, key_version = $3, updated_at = NOW()
         WHERE id = $1`,
        [credential.id, encryptedValue, newKeyVersion],
      );
    }
    return result.rows.length;
  });
}
