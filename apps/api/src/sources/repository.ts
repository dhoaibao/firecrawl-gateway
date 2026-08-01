import { withOperatorTransaction } from "../db";
import { decryptProviderCredential } from "../credentials/crypto";
import { accountCredentialSourceId, type ProviderCredentialRecord } from "../credentials/repository";
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

export async function createInfrastructureSource(input: CreateInfrastructureSourceInput): Promise<InfrastructureSourceRecord> {
  const baseUrl = normalizeSourceUrl(input.kind, input.baseUrl ?? "", input.allowPrivateNetwork ?? false);
  return withOperatorTransaction(async (client) => {
    const result = await client.query<InfrastructureSourceRecord>(
      `INSERT INTO infrastructure_sources (
        id, name, kind, base_url, credential_id, priority, hard_concurrency,
        request_timeout_ms, response_buffer_max_bytes, capabilities
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, base_url = EXCLUDED.base_url, credential_id = EXCLUDED.credential_id,
        priority = EXCLUDED.priority, hard_concurrency = EXCLUDED.hard_concurrency,
        request_timeout_ms = EXCLUDED.request_timeout_ms,
        response_buffer_max_bytes = EXCLUDED.response_buffer_max_bytes,
        capabilities = EXCLUDED.capabilities, updated_at = NOW()
      RETURNING *`,
      [
        input.id, input.name, input.kind, baseUrl, input.credentialId ?? null,
        input.priority ?? 100, input.hardConcurrency ?? 1, input.requestTimeoutMs ?? 120_000,
        input.responseBufferMaxBytes ?? 5_242_880, input.capabilities ?? [],
      ],
    );
    return result.rows[0];
  });
}

function normalizeSourceUrl(kind: SourceKind, value: string, allowPrivateNetwork: boolean): string {
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
  return withOperatorTransaction(async (client) => {
    const sources: ResolvedSource[] = [];
    if (fundingPreference !== "included") {
      const byok = await client.query<ProviderCredentialRecord>(
        `SELECT * FROM provider_credentials
         WHERE owner_type = 'account' AND account_id = $1 AND purpose = 'firecrawl_cloud'
           AND status = 'valid' AND superseded_at IS NULL
         ORDER BY created_at DESC`,
        [accountId],
      );
      for (const credential of byok.rows) {
        const sourceId = accountCredentialSourceId(accountId, credential.id);
        sources.push({
          id: sourceId,
          kind: "cloud",
          baseUrl: cloudBaseUrl,
          credential: decryptProviderCredential(credential.encrypted_value, encryptionKey, {
            purpose: credential.purpose,
            ownerId: accountId,
            sourceId,
            keyVersion: credential.key_version,
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

    const operatorSources = await client.query<InfrastructureSourceRecord & {
      encrypted_value: string | null;
      key_version: number | null;
      purpose: "firecrawl_cloud" | "self_hosted_upstream" | null;
    }>(
      `SELECT s.*, c.encrypted_value, c.key_version, c.purpose
       FROM infrastructure_sources s
       LEFT JOIN provider_credentials c ON c.id = s.credential_id
         AND c.status = 'valid' AND c.superseded_at IS NULL
       WHERE s.status = 'active' AND (s.health_status != 'unhealthy' OR s.health_status = 'unknown')
       ORDER BY s.priority ASC, s.created_at ASC`,
    );
    for (const source of operatorSources.rows) {
      let credential: string | undefined;
      if (source.credential_id && source.encrypted_value && source.key_version && source.purpose) {
        credential = decryptProviderCredential(source.encrypted_value, encryptionKey, {
          purpose: source.purpose,
          ownerId: "operator",
          sourceId: source.id,
          keyVersion: source.key_version,
        });
      }
      // A Cloud source without a current valid credential is not dispatchable.
      if (source.kind === "cloud" && !credential) continue;
      sources.push({
        id: source.id,
        kind: source.kind,
        baseUrl: source.kind === "cloud" ? cloudBaseUrl : source.base_url,
        credential,
        credentialId: source.credential_id ?? undefined,
        fundingType: "included",
        hardConcurrency: source.hard_concurrency,
        requestTimeoutMs: source.request_timeout_ms,
        responseBufferMaxBytes: source.response_buffer_max_bytes,
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
