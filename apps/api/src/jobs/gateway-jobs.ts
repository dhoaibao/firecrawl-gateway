import crypto from "node:crypto";
import { withAccountTransaction } from "../db";
import type { FundingType } from "../sources/repository";

export interface GatewayJobRecord {
  id: string;
  account_id: string;
  public_job_id: string;
  upstream_job_id: string;
  route_family: string;
  source_id: string | null;
  credential_id: string | null;
  funding_type: FundingType;
  creation_request: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateGatewayJobInput {
  publicJobId: string;
  upstreamJobId: string;
  routeFamily: string;
  sourceId?: string;
  credentialId?: string;
  fundingType: FundingType;
  /** Persist only the bounded request fields required for lifecycle diagnostics. */
  creationRequest: Record<string, unknown>;
}

export async function createGatewayJob(accountId: string, input: CreateGatewayJobInput): Promise<GatewayJobRecord> {
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<GatewayJobRecord>(
      `INSERT INTO gateway_jobs (
        id, account_id, public_job_id, upstream_job_id, route_family, source_id,
        credential_id, funding_type, creation_request
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        crypto.randomUUID(), accountId, input.publicJobId, input.upstreamJobId,
        input.routeFamily, input.sourceId ?? null, input.credentialId ?? null,
        input.fundingType, input.creationRequest,
      ],
    );
    return result.rows[0];
  });
}

/** RLS and the account predicate make cross-account poll/cancel lookups impossible. */
export async function getGatewayJob(accountId: string, publicJobId: string): Promise<GatewayJobRecord | null> {
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<GatewayJobRecord>(
      "SELECT * FROM gateway_jobs WHERE account_id = $1 AND public_job_id = $2",
      [accountId, publicJobId],
    );
    return result.rows[0] ?? null;
  });
}

export async function completeGatewayJob(accountId: string, publicJobId: string): Promise<void> {
  await withAccountTransaction(accountId, async (client) => {
    await client.query(
      `UPDATE gateway_jobs SET completed_at = NOW(), updated_at = NOW()
       WHERE account_id = $1 AND public_job_id = $2`,
      [accountId, publicJobId],
    );
  });
}
