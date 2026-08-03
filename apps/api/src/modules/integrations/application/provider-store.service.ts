import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { decryptProviderCredential, encryptProviderCredential, maskCredential } from "../../credentials/domain/credential-crypto";

export type ProviderSecretStatus = "pending" | "valid" | "invalid" | "revoked";
export interface ProviderSecretMetadata { id: string; owner_type: "account" | "operator"; account_id: string | null; purpose: string; key_version: number; masked_prefix: string; masked_suffix: string; status: ProviderSecretStatus; provider_metadata: Record<string, unknown>; last_validated_at: string | null; last_used_at: string | null; superseded_at: string | null; created_at: string; updated_at: string; }
const select = Prisma.validator<Prisma.ProviderCredentialSelect>()({ id: true, ownerType: true, accountId: true, purpose: true, encryptedValue: true, keyVersion: true, maskedPrefix: true, maskedSuffix: true, status: true, providerMetadata: true, lastValidatedAt: true, lastUsedAt: true, supersededAt: true, createdAt: true, updatedAt: true });
type Row = Prisma.ProviderCredentialGetPayload<{ select: typeof select }>;

@Injectable()
export class ProviderStoreService {
  constructor(private readonly transactions: TransactionService, private readonly config: AppConfigService) {}
  async list(accountId: string): Promise<ProviderSecretMetadata[]> { const rows = await this.transactions.runForAccount(accountId, (tx) => tx.providerCredential.findMany({ where: { accountId, ownerType: "account" }, orderBy: { createdAt: "desc" }, select })); return rows.map(toMetadata); }
  async create(accountId: string, value: string): Promise<ProviderSecretMetadata> { const id = crypto.randomUUID(); const encryptedValue = encryptProviderCredential(value, this.config.providerCredentialsEncryptionKey, { purpose: "firecrawl_cloud", ownerId: accountId, sourceId: sourceId(accountId, id), keyVersion: 1 }); const masked = maskCredential(value); const row = await this.transactions.runForAccount(accountId, (tx) => tx.providerCredential.create({ data: { id, ownerType: "account", accountId, purpose: "firecrawl_cloud", encryptedValue, keyVersion: 1, maskedPrefix: masked.prefix, maskedSuffix: masked.suffix, providerMetadata: {} }, select })); return toMetadata(row); }
  async replace(accountId: string, id: string, value: string): Promise<ProviderSecretMetadata | null> { return this.transactions.runForAccount(accountId, async (tx) => { const old = await tx.providerCredential.updateMany({ where: { id, accountId, ownerType: "account", supersededAt: null }, data: { status: "revoked", supersededAt: new Date(), updatedAt: new Date() } }); if (!old.count) return null; const newId = crypto.randomUUID(); const encryptedValue = encryptProviderCredential(value, this.config.providerCredentialsEncryptionKey, { purpose: "firecrawl_cloud", ownerId: accountId, sourceId: sourceId(accountId, newId), keyVersion: 1 }); const masked = maskCredential(value); const row = await tx.providerCredential.create({ data: { id: newId, ownerType: "account", accountId, purpose: "firecrawl_cloud", encryptedValue, keyVersion: 1, maskedPrefix: masked.prefix, maskedSuffix: masked.suffix, providerMetadata: {} }, select }); return toMetadata(row); }); }
  async revoke(accountId: string, id: string): Promise<boolean> { const result = await this.transactions.runForAccount(accountId, (tx) => tx.providerCredential.updateMany({ where: { id, accountId, ownerType: "account", supersededAt: null, status: { not: "revoked" } }, data: { status: "revoked", supersededAt: new Date(), updatedAt: new Date() } })); return result.count === 1; }
  async listOperator(): Promise<ProviderSecretMetadata[]> {
    const rows = await this.transactions.runAsOperator((tx) => tx.providerCredential.findMany({ where: { ownerType: "operator" }, orderBy: { createdAt: "desc" }, select }));
    return rows.map(toMetadata);
  }

  async createOperator(input: { value: string; purpose: "firecrawl_cloud" | "self_hosted_upstream"; sourceId: string }): Promise<ProviderSecretMetadata> {
    const id = crypto.randomUUID();
    const encryptedValue = encryptProviderCredential(input.value, this.config.providerCredentialsEncryptionKey, { purpose: input.purpose, ownerId: "operator", sourceId: input.sourceId, keyVersion: 1 });
    const masked = maskCredential(input.value);
    const row = await this.transactions.runAsOperator((tx) => tx.providerCredential.create({ data: { id, ownerType: "operator", accountId: null, purpose: input.purpose, encryptedValue, keyVersion: 1, maskedPrefix: masked.prefix, maskedSuffix: masked.suffix, providerMetadata: {}, sources: { connect: { id: input.sourceId } } }, select }));
    return toMetadata(row);
  }

  async replaceOperator(id: string, input: { value: string; purpose: "firecrawl_cloud" | "self_hosted_upstream"; sourceId: string }): Promise<ProviderSecretMetadata | null> {
    return this.transactions.runAsOperator(async (tx) => {
      const old = await tx.providerCredential.findFirst({ where: { id, ownerType: "operator", supersededAt: null } });
      if (!old) return null;
      await tx.providerCredential.update({ where: { id }, data: { status: "revoked", supersededAt: new Date(), updatedAt: new Date() } });
      const newId = crypto.randomUUID();
      const encryptedValue = encryptProviderCredential(input.value, this.config.providerCredentialsEncryptionKey, { purpose: input.purpose, ownerId: "operator", sourceId: input.sourceId, keyVersion: 1 });
      const masked = maskCredential(input.value);
      const row = await tx.providerCredential.create({ data: { id: newId, ownerType: "operator", accountId: null, purpose: input.purpose, encryptedValue, keyVersion: 1, maskedPrefix: masked.prefix, maskedSuffix: masked.suffix, providerMetadata: {}, sources: { connect: { id: input.sourceId } } }, select });
      return toMetadata(row);
    });
  }

  async revokeOperator(id: string): Promise<boolean> {
    const result = await this.transactions.runAsOperator((tx) => tx.providerCredential.updateMany({ where: { id, ownerType: "operator", supersededAt: null, status: { not: "revoked" } }, data: { status: "revoked", supersededAt: new Date(), updatedAt: new Date() } }));
    return result.count === 1;
  }

  async validate(accountId: string, id: string): Promise<ProviderSecretMetadata | null> { const row = await this.transactions.runForAccount(accountId, (tx) => tx.providerCredential.findFirst({ where: { id, accountId, ownerType: "account", status: { not: "revoked" }, supersededAt: null }, select })); if (!row) return null; let valid = false; try { const value = decryptProviderCredential(row.encryptedValue, this.config.providerCredentialsEncryptionKey, { purpose: "firecrawl_cloud", ownerId: accountId, sourceId: sourceId(accountId, row.id), keyVersion: row.keyVersion }); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000); try { valid = (await fetch(`${this.config.cloudBaseUrl}/v2/team/credit-usage`, { headers: { authorization: `Bearer ${value}` }, signal: controller.signal })).ok; } finally { clearTimeout(timeout); } } catch { valid = false; } const updated = await this.transactions.runForAccount(accountId, async (tx) => { await tx.providerCredential.updateMany({ where: { id, accountId }, data: { status: valid ? "valid" : "invalid", lastValidatedAt: new Date(), updatedAt: new Date() } }); return tx.providerCredential.findUnique({ where: { id }, select }); }); return updated ? toMetadata(updated) : null; }
}
function sourceId(accountId: string, id: string): string { return `account:${accountId}:${id}`; }
function toMetadata(row: Row): ProviderSecretMetadata { return { id: row.id, owner_type: row.ownerType as "account" | "operator", account_id: row.accountId, purpose: row.purpose, key_version: row.keyVersion, masked_prefix: row.maskedPrefix, masked_suffix: row.maskedSuffix, status: row.status as ProviderSecretStatus, provider_metadata: row.providerMetadata as Record<string, unknown>, last_validated_at: row.lastValidatedAt?.toISOString() ?? null, last_used_at: row.lastUsedAt?.toISOString() ?? null, superseded_at: row.supersededAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() }; }
