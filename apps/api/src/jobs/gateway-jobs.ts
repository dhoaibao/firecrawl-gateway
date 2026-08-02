import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { withAccountTransaction } from "../infrastructure/database";
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

const jobSelect = {
  id: true,
  accountId: true,
  publicJobId: true,
  upstreamJobId: true,
  routeFamily: true,
  sourceId: true,
  credentialId: true,
  fundingType: true,
  creationRequest: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
} satisfies Prisma.GatewayJobSelect;

type JobRow = Prisma.GatewayJobGetPayload<{ select: typeof jobSelect }>;

function mapJob(row: JobRow): GatewayJobRecord {
  return {
    id: row.id,
    account_id: row.accountId,
    public_job_id: row.publicJobId,
    upstream_job_id: row.upstreamJobId,
    route_family: row.routeFamily,
    source_id: row.sourceId,
    credential_id: row.credentialId,
    funding_type: row.fundingType as FundingType,
    creation_request: row.creationRequest as Record<string, unknown>,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

export async function createGatewayJob(accountId: string, input: CreateGatewayJobInput): Promise<GatewayJobRecord> {
  return withAccountTransaction(accountId, async (tx) => {
    const row = await tx.gatewayJob.create({
      data: {
        id: crypto.randomUUID(),
        accountId,
        publicJobId: input.publicJobId,
        upstreamJobId: input.upstreamJobId,
        routeFamily: input.routeFamily,
        sourceId: input.sourceId ?? null,
        credentialId: input.credentialId ?? null,
        fundingType: input.fundingType,
        creationRequest: input.creationRequest as Prisma.InputJsonValue,
      },
      select: jobSelect,
    });
    return mapJob(row);
  });
}

/** RLS and the account predicate make cross-account poll/cancel lookups impossible. */
export async function getGatewayJob(accountId: string, publicJobId: string): Promise<GatewayJobRecord | null> {
  return withAccountTransaction(accountId, async (tx) => {
    const row = await tx.gatewayJob.findFirst({ where: { accountId, publicJobId }, select: jobSelect });
    return row ? mapJob(row) : null;
  });
}

export async function completeGatewayJob(accountId: string, publicJobId: string): Promise<void> {
  await withAccountTransaction(accountId, async (tx) => {
    await tx.gatewayJob.updateMany({
      where: { accountId, publicJobId },
      data: { completedAt: new Date(), updatedAt: new Date() },
    });
  });
}
