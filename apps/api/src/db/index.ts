import { Pool, type PoolClient } from "pg";
import { rootLogger } from "../logger";

let pool: Pool | null = null;
let operatorPool: Pool | null = null;

export const EXPECTED_SCHEMA_VERSION = "004_operator_role_rls";
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const STATEMENT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 2000;

export interface TransactionOptions {
  accountId?: string;
  operator?: boolean;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initDatabase first.");
  }
  return pool;
}

export function getOperatorPool(): Pool {
  if (!operatorPool) {
    throw new Error("Operator database pool not initialized. Call initDatabase first.");
  }
  return operatorPool;
}

function createPool(databaseUrl: string): Pool {
  const createdPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  createdPool.on("error", (err) => {
    rootLogger.error({ err }, "Unexpected database pool error");
  });
  return createdPool;
}

export async function initDatabase(databaseUrl: string, operatorDatabaseUrl: string): Promise<Pool> {
  if (databaseUrl === operatorDatabaseUrl) {
    throw new Error("DATABASE_URL and OPERATOR_DATABASE_URL must use separate database credentials");
  }

  pool = createPool(databaseUrl);
  operatorPool = createPool(operatorDatabaseUrl);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await withClient((client) => client.query("SELECT 1"));
      break;
    } catch (err) {
      rootLogger.warn({ err, attempt, maxRetries: MAX_RETRIES }, "Database connection failed, retrying...");
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  await assertSchemaReady();
  await assertOperatorReady();
  rootLogger.info({ schemaVersion: EXPECTED_SCHEMA_VERSION }, "Database connections initialized");
  return pool;
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await assertSchemaReady();
    await assertOperatorReady();
    return true;
  } catch (err) {
    rootLogger.warn({ err }, "Database readiness check failed");
    return false;
  }
}

/** Run a callback with a checked-out client without opening a transaction. */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  if (options?.accountId || options?.operator) {
    return withTransaction(fn, options);
  }

  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Execute all statements on one client with transaction-local safety settings. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await (options.operator ? getOperatorPool() : getPool()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${LOCK_TIMEOUT_MS}ms`]);
    if (options.operator) {
      await client.query("SET LOCAL ROLE firecrawl_gateway_operator");
    }
    await client.query("SELECT set_config('app.account_id', $1, true)", [options.accountId ?? ""]);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      rootLogger.error({ err: rollbackError }, "Database transaction rollback failed");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withAccountTransaction<T>(
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!accountId.trim()) throw new Error("Account context is required");
  return withTransaction(fn, { accountId });
}

/** Operator access is intentionally explicit and must only be used by operator repositories. */
export async function withOperatorTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(fn, { operator: true });
}

export async function assertSchemaReady(): Promise<void> {
  await withClient(async (client) => {
    const result = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.pgmigrations') IS NOT NULL AS exists",
    );
    if (!result.rows[0]?.exists) {
      throw new Error(
        `Database schema is not ready: migration history is missing. Apply migrations with MIGRATION_DATABASE_URL (expected ${EXPECTED_SCHEMA_VERSION}).`,
      );
    }

    const applied = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pgmigrations WHERE name = $1) AS exists",
      [EXPECTED_SCHEMA_VERSION],
    );
    if (!applied.rows[0]?.exists) {
      throw new Error(
        `Database schema mismatch: expected migration ${EXPECTED_SCHEMA_VERSION}. Apply migrations with MIGRATION_DATABASE_URL before starting the API.`,
      );
    }

    const operatorRole = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') AS exists",
    );
    if (!operatorRole.rows[0]?.exists) {
      throw new Error(
        "Database role firecrawl_gateway_operator is missing. Apply the latest migrations with MIGRATION_DATABASE_URL.",
      );
    }

    const runtimeRole = await client.query<{
      is_runtime: boolean;
      is_operator: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT pg_has_role(current_user, 'firecrawl_gateway_runtime', 'member') AS is_runtime,
              pg_has_role(current_user, 'firecrawl_gateway_operator', 'member') AS is_operator,
              r.rolsuper, r.rolbypassrls
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );
    const runtime = runtimeRole.rows[0];
    if (!runtime?.is_runtime || runtime.is_operator || runtime.rolsuper || runtime.rolbypassrls) {
      throw new Error(
        "Database runtime role must be a non-superuser member of firecrawl_gateway_runtime and not firecrawl_gateway_operator without BYPASSRLS.",
      );
    }
  });
}

export async function assertOperatorReady(): Promise<void> {
  const client = await getOperatorPool().connect();
  try {
    const operatorRole = await client.query<{
      is_operator: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT pg_has_role(current_user, 'firecrawl_gateway_operator', 'member') AS is_operator,
              r.rolsuper, r.rolbypassrls
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );
    const operator = operatorRole.rows[0];
    if (!operator?.is_operator || operator.rolsuper || operator.rolbypassrls) {
      throw new Error(
        "Database operator role must be a non-superuser member of firecrawl_gateway_operator without BYPASSRLS.",
      );
    }
  } finally {
    client.release();
  }
}

export async function withUserAccountTransaction<T>(
  userId: string,
  fn: (accountId: string, client: PoolClient) => Promise<T>,
): Promise<T> {
  const account = await withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT a.id
       FROM accounts a
       INNER JOIN account_memberships m ON m.account_id = a.id
       WHERE m.user_id = $1 AND m.role = 'owner'
       ORDER BY a.created_at ASC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0]?.id;
  });
  if (!account) throw new Error(`No personal account exists for user ${userId}`);
  return withAccountTransaction(account, (client) => fn(account, client));
}
