import net from "node:net";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TransactionService } from "../../../core/database/transaction.service";
import { AppConfigService } from "../../../core/config/config.service";
import { decryptProviderCredential } from "../../credentials/domain/credential-crypto";

export const SOURCE_STATUSES = ["active", "draining", "paused", "unhealthy"] as const;
type SourceStatus = typeof SOURCE_STATUSES[number];
type SourceKind = "cloud" | "self_hosted";

const sourceSelect = Prisma.validator<Prisma.InfrastructureSourceSelect>()({ id: true, name: true, kind: true, status: true, priority: true, baseUrl: true, credentialId: true, capabilities: true, monthlyBudgetCents: true, hardConcurrency: true, requestTimeoutMs: true, responseBufferMaxBytes: true, healthStatus: true, lastHealthCheckAt: true, createdAt: true, updatedAt: true });
type SourceRow = Prisma.InfrastructureSourceGetPayload<{ select: typeof sourceSelect }>;

export interface ResolvedInfrastructureSource {
  id: string;
  kind: SourceKind;
  baseUrl: string;
  credential?: string;
  credentialId?: string;
  fundingType: "byok" | "included";
  hardConcurrency: number;
  requestTimeoutMs: number;
  responseBufferMaxBytes: number;
}

const credentialSelect = { id: true, purpose: true, encryptedValue: true, keyVersion: true, status: true, supersededAt: true } satisfies Prisma.ProviderCredentialSelect;

@Injectable()
export class InfrastructureService {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly transactions: TransactionService, private readonly config: AppConfigService) {}

  tryAcquire(source: Pick<ResolvedInfrastructureSource, "id" | "hardConcurrency">): (() => void) | null {
    const current = this.inFlight.get(source.id) ?? 0;
    if (current >= source.hardConcurrency) return null;
    this.inFlight.set(source.id, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.inFlight.get(source.id) ?? 1) - 1;
      if (remaining <= 0) this.inFlight.delete(source.id);
      else this.inFlight.set(source.id, remaining);
    };
  }

  async resolve(accountId: string, fundingPreference: "byok" | "included" | "auto" = "auto"): Promise<ResolvedInfrastructureSource[]> {
    return this.transactions.runAsOperator(async (tx) => {
      const sources: ResolvedInfrastructureSource[] = [];
      if (fundingPreference !== "included") {
        const credentials = await tx.providerCredential.findMany({ where: { ownerType: "account", accountId, purpose: "firecrawl_cloud", status: "valid", supersededAt: null }, orderBy: { createdAt: "desc" }, select: { ...credentialSelect, createdAt: true } });
        for (const credential of credentials) {
          const id = `account:${accountId}:${credential.id}`;
          try {
            sources.push({ id, kind: "cloud", baseUrl: this.config.cloudBaseUrl, credential: decryptProviderCredential(credential.encryptedValue, this.config.providerCredentialsEncryptionKey, { purpose: "firecrawl_cloud", ownerId: accountId, sourceId: id, keyVersion: credential.keyVersion }), credentialId: credential.id, fundingType: "byok", hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880 });
          } catch {
            // Invalid ciphertext must not become a dispatch credential.
          }
        }
        if (fundingPreference === "byok") return sources;
      }
      const operatorSources = await tx.infrastructureSource.findMany({ where: { status: "active", healthStatus: { not: "unhealthy" } }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }], select: { ...sourceSelect, credential: { select: credentialSelect } } });
      for (const source of operatorSources) {
        let credential: string | undefined;
        const stored = source.credential;
        if (stored && stored.status === "valid" && !stored.supersededAt) {
          try { credential = decryptProviderCredential(stored.encryptedValue, this.config.providerCredentialsEncryptionKey, { purpose: stored.purpose as "firecrawl_cloud" | "self_hosted_upstream", ownerId: "operator", sourceId: source.id, keyVersion: stored.keyVersion }); } catch { credential = undefined; }
        }
        if (source.kind === "cloud" && !credential) continue;
        sources.push({ id: source.id, kind: source.kind as SourceKind, baseUrl: source.kind === "cloud" ? this.config.cloudBaseUrl : source.baseUrl, credential, credentialId: source.credentialId ?? undefined, fundingType: "included", hardConcurrency: source.hardConcurrency, requestTimeoutMs: source.requestTimeoutMs, responseBufferMaxBytes: source.responseBufferMaxBytes });
      }
      return sources;
    });
  }

  async list() { const rows = await this.transactions.runAsOperator((tx) => tx.infrastructureSource.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }], select: sourceSelect })); return rows.map(toView); }

  async create(input: { id: string; name: string; kind: SourceKind; baseUrl?: string; credentialId?: string; priority?: number; hardConcurrency?: number; requestTimeoutMs?: number; responseBufferMaxBytes?: number; capabilities?: string[]; allowPrivateNetwork?: boolean }) {
    const baseUrl = normalizeUrl(input.kind, input.baseUrl ?? "", input.allowPrivateNetwork === true);
    const row = await this.transactions.runAsOperator((tx) => tx.infrastructureSource.upsert({ where: { id: input.id }, create: { id: input.id, name: input.name, kind: input.kind, baseUrl, credentialId: input.credentialId ?? null, priority: input.priority ?? 100, hardConcurrency: input.hardConcurrency ?? 1, requestTimeoutMs: input.requestTimeoutMs ?? 120_000, responseBufferMaxBytes: input.responseBufferMaxBytes ?? 5_242_880, capabilities: (input.capabilities ?? []) as Prisma.InputJsonValue }, update: { name: input.name, baseUrl, credentialId: input.credentialId ?? null, priority: input.priority ?? 100, hardConcurrency: input.hardConcurrency ?? 1, requestTimeoutMs: input.requestTimeoutMs ?? 120_000, responseBufferMaxBytes: input.responseBufferMaxBytes ?? 5_242_880, capabilities: (input.capabilities ?? []) as Prisma.InputJsonValue, updatedAt: new Date() }, select: sourceSelect }));
    return toView(row);
  }

  async update(id: string, input: { name?: string; priority?: number; hardConcurrency?: number; requestTimeoutMs?: number; responseBufferMaxBytes?: number; capabilities?: string[]; baseUrl?: string; allowPrivateNetwork?: boolean; status?: SourceStatus; credentialId?: string | null }) {
    const row = await this.transactions.runAsOperator(async (tx) => {
      const existing = await tx.infrastructureSource.findUnique({ where: { id }, select: { kind: true } });
      if (!existing) return null;
      if (input.status && !SOURCE_STATUSES.includes(input.status)) throw new Error("Unsupported infrastructure source status");
      const data: Prisma.InfrastructureSourceUpdateInput = { updatedAt: new Date() };
      if (input.name !== undefined) data.name = input.name;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.hardConcurrency !== undefined) data.hardConcurrency = input.hardConcurrency;
      if (input.requestTimeoutMs !== undefined) data.requestTimeoutMs = input.requestTimeoutMs;
      if (input.responseBufferMaxBytes !== undefined) data.responseBufferMaxBytes = input.responseBufferMaxBytes;
      if (input.capabilities !== undefined) data.capabilities = input.capabilities as Prisma.InputJsonValue;
      if (input.status !== undefined) data.status = input.status;
      if (input.credentialId !== undefined) data.credential = input.credentialId ? { connect: { id: input.credentialId } } : { disconnect: true };
      if (input.baseUrl !== undefined) data.baseUrl = normalizeUrl(existing.kind as SourceKind, input.baseUrl, input.allowPrivateNetwork === true);
      return tx.infrastructureSource.update({ where: { id }, data, select: sourceSelect });
    });
    return row ? toView(row) : null;
  }

  async test(id: string) {
    const source = (await this.list()).find((candidate) => candidate.id === id);
    if (!source) return null;
    if (!source.base_url) return { status: "advisory", message: "Cloud source health is reported by the provider" };
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5_000);
    try { const response = await fetch(`${source.base_url}/health`, { signal: controller.signal }); return { status: response.ok ? "healthy" : "unhealthy", http_status: response.status }; }
    finally { clearTimeout(timeout); }
  }
}

function normalizeUrl(kind: SourceKind, value: string, allowPrivate: boolean): string {
  if (kind === "cloud") return "";
  let url: URL; try { url = new URL(value); } catch { throw new Error("Self-hosted source URL must be an absolute HTTP(S) URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Self-hosted source URL must use HTTP(S)");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Self-hosted source URL must use HTTPS in production");
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new Error("Self-hosted source URL targets a private control-plane network");
  return url.toString().replace(/\/+$/, "");
}
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase(); if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const ip = net.isIP(host); if (ip === 4) { const [a, b] = host.split(".").map(Number); return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169 && b === 254; }
  return ip === 6 && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"));
}
function toView(row: SourceRow) { return { id: row.id, name: row.name, kind: row.kind as SourceKind, status: row.status as SourceStatus, priority: row.priority, base_url: row.baseUrl, credential_id: row.credentialId, capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((value): value is string => typeof value === "string") : [], monthly_budget_cents: row.monthlyBudgetCents?.toString() ?? null, hard_concurrency: row.hardConcurrency, request_timeout_ms: row.requestTimeoutMs, response_buffer_max_bytes: row.responseBufferMaxBytes, health_status: row.healthStatus, last_health_check_at: row.lastHealthCheckAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() }; }
