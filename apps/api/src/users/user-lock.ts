import type { Prisma } from "@prisma/client";

/**
 * Serialises everything that creates or changes a user's resources: portal key and
 * session creation, and the admin's suspend / delete / limit changes. All of them take
 * this one transaction-scoped lock, then read the user's state inside the same
 * transaction, so a lifecycle change can never interleave with a write it should have
 * prevented or covered.
 */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${userId}`}))`;
}

/** The user is suspended, deleted or unknown, so nothing new may be created for them. */
export class UserInactiveError extends Error {
  constructor() {
    super("user_inactive");
    this.name = "UserInactiveError";
  }
}
