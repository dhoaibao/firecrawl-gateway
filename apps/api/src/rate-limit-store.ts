import { Prisma } from "@prisma/client";
import { withRuntimeTransaction } from "./infrastructure/database";

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Atomically consumes one window for every identity key in PostgreSQL. The
 * table is intentionally not tenant-scoped: it contains bounded hashes and
 * route buckets only, never credentials or customer payloads.
 */
export async function consumeRateLimit(
  keys: string[],
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) throw new Error("At least one rate-limit key is required");
  const values = Prisma.join(uniqueKeys.map((key) => Prisma.sql`(${key})`));
  const window = `${Math.max(1, windowMs)} milliseconds`;

  return withRuntimeTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ key: string; count: number; reset_at: Date }>>(Prisma.sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at, updated_at)
      SELECT incoming.key, 1, NOW() + ${window}::interval, NOW()
      FROM (VALUES ${values}) AS incoming(key)
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
            ELSE rate_limit_buckets.count + 1
          END,
          reset_at = CASE
            WHEN rate_limit_buckets.reset_at <= NOW() THEN NOW() + ${window}::interval
            ELSE rate_limit_buckets.reset_at
          END,
          updated_at = NOW()
      RETURNING key, count, reset_at
    `);

    const highest = rows.reduce<{ count: number; reset_at: Date }>(
      (current, row) => row.count > current.count ? row : current,
      { count: 0, reset_at: new Date() },
    );
    return {
      allowed: highest.count <= limit,
      remaining: Math.max(0, limit - highest.count),
      resetAt: highest.reset_at,
    };
  });
}

/** Delete at most one bounded batch of expired distributed buckets. */
export async function purgeExpiredRateLimitBuckets(batchSize = 1_000): Promise<number> {
  return withRuntimeTransaction(async (tx) => tx.$executeRaw(Prisma.sql`
    DELETE FROM rate_limit_buckets
    WHERE ctid IN (
      SELECT ctid FROM rate_limit_buckets
      WHERE reset_at < NOW() - INTERVAL '1 day'
      ORDER BY reset_at
      LIMIT ${Math.max(1, Math.min(batchSize, 10_000))}
    )
  `));
}
