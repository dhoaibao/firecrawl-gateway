import { PrismaClient, type Prisma } from "@prisma/client";
import {
  assertOperatorRoleReady,
  assertPrismaReady,
  assertRuntimeRoleReady,
  disconnectPrisma,
  getPrisma,
  initializePrisma,
  pingPrisma,
  withAccountTransaction as withPrismaAccountTransaction,
  withOperatorTransaction as withPrismaOperatorTransaction,
  withRuntimeTransaction,
  withUserAccountTransaction as withPrismaUserAccountTransaction,
} from "../infrastructure/database";
import { rootLogger } from "../logger";

/**
 * Narrow PostgreSQL raw-SQL adapter retained only for quota ledger operations
 * that require locks/CTEs. CRUD repositories use Prisma models directly.
 */
export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface DatabaseClient {
  query<T = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** Convert PostgreSQL BIGINT values returned by Prisma raw queries to the
 * number-based quota/domain records used by the application. Refuse values
 * outside the safe integer range instead of silently losing precision. */
export function normalizePrismaRawResult<T>(value: T): T {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error("Prisma raw BIGINT value exceeds the JavaScript safe integer range");
    }
    return Number(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePrismaRawResult(item)) as T;
  }
  if (value instanceof Date || value instanceof Uint8Array || value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizePrismaRawResult(item)]),
  ) as T;
}

class PrismaDatabaseClient implements DatabaseClient {
  constructor(private readonly client: PrismaClient | Prisma.TransactionClient) {}

  async query<T = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    const normalized = text.trim().replace(/^\/\*.*?\*\//s, "").trim().toUpperCase();
    const isRead = normalized.startsWith("SELECT") ||
      (normalized.startsWith("WITH") && !/\b(INSERT|UPDATE|DELETE)\b/.test(normalized));
    const returnsRows = isRead || /\bRETURNING\b/.test(normalized);

    if (returnsRows) {
      const rows = normalizePrismaRawResult(await this.client.$queryRawUnsafe<T[]>(text, ...values));
      return { rows, rowCount: rows.length };
    }

    const rowCount = await this.client.$executeRawUnsafe(text, ...values);
    return { rows: [], rowCount };
  }
}

export const EXPECTED_SCHEMA_VERSION = "prisma";

export interface TransactionOptions {
  accountId?: string;
  operator?: boolean;
}

function runtimeClient(): DatabaseClient {
  return new PrismaDatabaseClient(getPrisma().runtime);
}

function operatorClient(): DatabaseClient {
  return new PrismaDatabaseClient(getPrisma().operator);
}

function transactionClient(tx: Prisma.TransactionClient): DatabaseClient {
  return new PrismaDatabaseClient(tx);
}

export function asDatabaseClient(tx: Prisma.TransactionClient): DatabaseClient {
  return transactionClient(tx);
}

export function getPool(): DatabaseClient {
  return runtimeClient();
}

export function getOperatorPool(): DatabaseClient {
  return operatorClient();
}

export async function initDatabase(databaseUrl: string, operatorDatabaseUrl: string): Promise<void> {
  initializePrisma(databaseUrl, operatorDatabaseUrl);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pingPrisma();
      await assertSchemaReady();
      await assertOperatorReady();
      rootLogger.info({ schemaVersion: EXPECTED_SCHEMA_VERSION }, "Prisma database connections initialized");
      return;
    } catch (error) {
      rootLogger.warn({ err: error, attempt, maxRetries: 5 }, "Database connection failed, retrying...");
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

export async function closeDatabase(): Promise<void> {
  await disconnectPrisma();
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await assertSchemaReady();
    await assertOperatorReady();
    return true;
  } catch (error) {
    rootLogger.warn({ err: error }, "Database readiness check failed");
    return false;
  }
}

export async function withClient<T>(
  fn: (client: DatabaseClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  if (options?.accountId) return withAccountTransaction(options.accountId, fn);
  if (options?.operator) return withOperatorTransaction(fn);
  return fn(runtimeClient());
}

export async function withTransaction<T>(
  fn: (client: DatabaseClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  if (options.accountId) return withAccountTransaction(options.accountId, fn);
  if (options.operator) return withOperatorTransaction(fn);
  return withRuntimeTransaction((tx) => fn(transactionClient(tx)));
}

export async function withAccountTransaction<T>(
  accountId: string,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  return withPrismaAccountTransaction(accountId, (tx) => fn(transactionClient(tx)));
}

export async function withOperatorTransaction<T>(
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  return withPrismaOperatorTransaction((tx) => fn(transactionClient(tx)));
}

export async function assertSchemaReady(): Promise<void> {
  await assertPrismaReady();
}

export async function assertOperatorReady(): Promise<void> {
  await assertRuntimeRoleReady();
  await assertOperatorRoleReady();
}

export async function withUserAccountTransaction<T>(
  userId: string,
  fn: (accountId: string, client: DatabaseClient) => Promise<T>,
): Promise<T> {
  return withPrismaUserAccountTransaction(userId, (accountId, tx) => fn(accountId, transactionClient(tx)));
}
