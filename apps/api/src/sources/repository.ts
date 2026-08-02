import { Prisma } from "@prisma/client";
import { withOperatorTransaction } from "../infrastructure/database";
import { decryptProviderCredential } from "../credentials/crypto";
import { accountCredentialSourceId } from "../credentials/repository";
import { hasPrivateTargetUrl } from "../utils";

export type SourceKind = "cloud" | "self_hosted";
export type FundingType = "byok" | "included";

export interface InfrastructureSourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  status: "active" | "draining" | "paused" | "unhealthy";
  priority: number;
  base_url: string;
  credential_id: string | null;
  capabilities: string[];
  monthly_budget_cents: string | null;
  hard_concurrency: number;
  request_timeout_ms: number;
  response_buffer_max_bytes: number;
  health_status: "unknown" | "healthy" | "unhealthy";
  last_health_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolvedSource {
  id: string;
  kind: SourceKind;
  baseUrl: string;
  credential?: string;
  credentialId?: string;
  fundingType: FundingType;
  hardConcurrency: number;
  requestTimeoutMs: number;
  responseBufferMaxBytes: number;
}

export interface CreateInfrastructureSourceInput {
  id: string;
  name: string;
  kind: SourceKind;
  baseUrl?: string;
  credentialId?: string;
  priority?: number;
  hardConcurrency?: number;
  requestTimeoutMs?: number;
  responseBufferMaxBytes?: number;
  capabilities?: string[];
  /** Required for operator-approved private deployment networks. */
  allowPrivateNetwork?: boolean;
}

const sourceSelect = Prisma.validator<Prisma.InfrastructureSourceSelect>()({
  id: true,
  name: true,
  kind: true,
  status: true,
  priority: true,
  baseUrl: true,
  credentialId: true,
  capabilities: true,
  monthlyBudgetCents: true,
  hardConcurrency: true,
  requestTimeoutMs: true,
  responseBufferMaxBytes: true,
  healthStatus: true,
  lastHealthCheckAt: true,
  createdAt: true,
  updatedAt: true,
});

const credentialSelect = {
  id: true,
  ownerType: true,
  accountId: true,
  purpose: true,
  encryptedValue: true,
  keyVersion: true,
  status: true,
  supersededAt: true,
} satisfies Prisma.ProviderCredentialSelect;

function mapSource(row: Prisma.InfrastructureSourceGetPayload<{ select: typeof sourceSelect }>): InfrastructureSourceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SourceKind,
    status: row.status as InfrastructureSourceRecord["status"],
    priority: row.priority,
    base_url: row.baseUrl,
    credential_id: row.credentialId,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((item): item is string => typeof item === "string") : [],
    monthly_budget_cents: row.monthlyBudgetCents === null ? null : row.monthlyBudgetCents.toString(),
    hard_concurrency: row.hardConcurrency,
    request_timeout_ms: row.requestTimeoutMs,
    response_buffer_max_bytes: row.responseBufferMaxBytes,
    health_status: row.healthStatus as InfrastructureSourceRecord["health_status"],
    last_health_check_at: row.lastHealthCheckAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function createInfrastructureSource(input: CreateInfrastructureSourceInput): Promise<InfrastructureSourceRecord> {
  const baseUrl = normalizeSourceUrl(input.kind, input.baseUrl ?? "", input.allowPrivateNetwork ?? false);
  return withOperatorTransaction(async (tx) => {
    const row = await tx.infrastructureSource.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        name: input.name,
        kind: input.kind,
        baseUrl,
        credentialId: input.credentialId ?? null,
        priority: input.priority ?? 100,
        hardConcurrency: input.hardConcurrency ?? 1,
        requestTimeoutMs: input.requestTimeoutMs ?? 120_000,
        responseBufferMaxBytes: input.responseBufferMaxBytes ?? 5_242_880,
        capabilities: (input.capabilities ?? []) as Prisma.InputJsonValue,
      },
      update: {
        name: input.name,
        baseUrl,
        credentialId: input.credentialId ?? null,
        priority: input.priority ?? 100,
        hardConcurrency: input.hardConcurrency ?? 1,
        requestTimeoutMs: input.requestTimeoutMs ?? 120_000,
        responseBufferMaxBytes: input.responseBufferMaxBytes ?? 5_242_880,
        capabilities: (input.capabilities ?? []) as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
      select: sourceSelect,
    });
    return mapSource(row);
  });
}

export function normalizeSourceUrl(kind: SourceKind, value: string, allowPrivateNetwork: boolean): string {
  if (kind === "cloud") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Self-hosted source URL must be an absolute HTTP(S) URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Self-hosted source URL must use HTTP(S)");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Self-hosted source URL must use HTTPS in production");
  }
  if (!allowPrivateNetwork && hasPrivateTargetUrl([url.toString()])) {
    throw new Error("Self-hosted source URL targets a private control-plane network");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function resolveInfrastructureSources(
  accountId: string,
  fundingPreference: "byok" | "included" | "auto",
  encryptionKey: string,
  cloudBaseUrl: string,
): Promise<ResolvedSource[]> {
  return withOperatorTransaction(async (tx) => {
    const sources: ResolvedSource[] = [];
    if (fundingPreference !== "included") {
      const byok = await tx.providerCredential.findMany({
        where: { ownerType: "account", accountId, purpose: "firecrawl_cloud", status: "valid", supersededAt: null },
        orderBy: { createdAt: "desc" },
        select: { ...credentialSelect, createdAt: true },
      });
      for (const credential of byok) {
        const sourceId = accountCredentialSourceId(accountId, credential.id);
        sources.push({
          id: sourceId,
          kind: "cloud",
          baseUrl: cloudBaseUrl,
          credential: decryptProviderCredential(credential.encryptedValue, encryptionKey, {
            purpose: credential.purpose as "firecrawl_cloud",
            ownerId: accountId,
            sourceId,
            keyVersion: credential.keyVersion,
          }),
          credentialId: credential.id,
          fundingType: "byok",
          hardConcurrency: 1,
          requestTimeoutMs: 120_000,
          responseBufferMaxBytes: 5_242_880,
        });
      }
      if (fundingPreference === "byok") return sources;
    }

    const operatorSources = await tx.infrastructureSource.findMany({
      where: { status: "active", healthStatus: { not: "unhealthy" } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: { ...sourceSelect, credential: { select: credentialSelect } },
    });
    for (const source of operatorSources) {
      let credential: string | undefined;
      const stored = source.credential;
      if (stored && stored.status === "valid" && !stored.supersededAt) {
        credential = decryptProviderCredential(stored.encryptedValue, encryptionKey, {
          purpose: stored.purpose as "firecrawl_cloud" | "self_hosted_upstream",
          ownerId: "operator",
          sourceId: source.id,
          keyVersion: stored.keyVersion,
        });
      }
      if (source.kind === "cloud" && !credential) continue;
      sources.push({
        id: source.id,
        kind: source.kind as SourceKind,
        baseUrl: source.kind === "cloud" ? cloudBaseUrl : source.baseUrl,
        credential,
        credentialId: source.credentialId ?? undefined,
        fundingType: "included",
        hardConcurrency: source.hardConcurrency,
        requestTimeoutMs: source.requestTimeoutMs,
        responseBufferMaxBytes: source.responseBufferMaxBytes,
      });
    }
    return sources;
  });
}

const inFlightBySource = new Map<string, number>();

export function tryAcquireSource(source: Pick<ResolvedSource, "id" | "hardConcurrency">): (() => void) | null {
  const current = inFlightBySource.get(source.id) ?? 0;
  if (current >= source.hardConcurrency) return null;
  inFlightBySource.set(source.id, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inFlightBySource.get(source.id) ?? 1) - 1;
    if (remaining <= 0) inFlightBySource.delete(source.id);
    else inFlightBySource.set(source.id, remaining);
  };
}

export function clearSourceConcurrency(): void {
  inFlightBySource.clear();
}
