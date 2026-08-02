import type { Prisma } from "@prisma/client";
import { withAccountTransaction, withOperatorTransaction } from "../infrastructure/database";

export interface AccountRecord {
  id: string;
  public_id: string;
  display_name: string;
  status: string;
  funding_preference: "byok" | "included" | "auto";
  created_at: string;
  updated_at: string;
}

export interface AccountMembershipRecord {
  account_id: string;
  user_id: string;
  role: "owner" | "member";
  created_at: string;
  updated_at: string;
}

function accountRecord(account: {
  id: string;
  publicId: string;
  displayName: string;
  status: string;
  fundingPreference: string;
  createdAt: Date;
  updatedAt: Date;
}): AccountRecord {
  return {
    id: account.id,
    public_id: account.publicId,
    display_name: account.displayName,
    status: account.status,
    funding_preference: account.fundingPreference as AccountRecord["funding_preference"],
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

function membershipRecord(membership: {
  accountId: string;
  userId: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): AccountMembershipRecord {
  return {
    account_id: membership.accountId,
    user_id: membership.userId,
    role: membership.role as AccountMembershipRecord["role"],
    created_at: membership.createdAt.toISOString(),
    updated_at: membership.updatedAt.toISOString(),
  };
}

const accountSelect = {
  id: true,
  publicId: true,
  displayName: true,
  status: true,
  fundingPreference: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountSelect;

export async function getAccountById(accountId: string): Promise<AccountRecord | null> {
  return withOperatorTransaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: accountSelect });
    return account ? accountRecord(account) : null;
  });
}

export async function getAccountByPublicId(publicId: string): Promise<AccountRecord | null> {
  return withOperatorTransaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { publicId }, select: accountSelect });
    return account ? accountRecord(account) : null;
  });
}

export async function getPersonalAccountForUser(userId: string): Promise<AccountRecord | null> {
  return withOperatorTransaction(async (tx) => {
    const membership = await tx.accountMembership.findFirst({
      where: { userId, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { account: { select: accountSelect } },
    });
    return membership?.account ? accountRecord(membership.account) : null;
  });
}

export async function listAccountMemberships(accountId: string): Promise<AccountMembershipRecord[]> {
  return withAccountTransaction(accountId, async (tx) => {
    const memberships = await tx.accountMembership.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    });
    return memberships.map(membershipRecord);
  });
}

export async function withAccountRepository<T>(
  accountId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withAccountTransaction(accountId, fn);
}
