import { Pool, type PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { rootLogger } from "../logger";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initDatabase first.");
  }
  return pool;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

export async function initDatabase(databaseUrl: string): Promise<Pool> {
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    rootLogger.error({ err }, "Unexpected database pool error");
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await runMigrations();
      rootLogger.info("Database initialized");
      return pool;
    } catch (err) {
      rootLogger.warn({ err, attempt, maxRetries: MAX_RETRIES }, "Database initialization failed, retrying...");
      if (attempt === MAX_RETRIES) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  return pool;
}

export async function pingDatabase(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    rootLogger.warn({ err }, "Database ping failed");
    return false;
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");
  await withClient(async (client) => {
    await client.query(schema);
  });
}
