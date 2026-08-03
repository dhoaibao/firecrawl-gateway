import fs from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "./config";
import { closeDatabase, initDatabase } from "./db";
import { rootLogger } from "./logger";
import { startBackgroundJobs } from "./jobs";
import type { GatewayConfig } from "./types";

/** Start durable job processing independently from HTTP app construction. */
export function startWorker(config?: GatewayConfig): () => void {
  return startBackgroundJobs(config);
}

const HEARTBEAT_INTERVAL_MS = 10_000;

async function writeHeartbeat(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${new Date().toISOString()}\n`, "utf8");
}

/** Dedicated worker entrypoint used by the production container topology. */
export async function runWorkerProcess(): Promise<void> {
  const config = parseConfig();
  await initDatabase(config.databaseUrl, config.operatorDatabaseUrl);

  const heartbeatFile = config.workerHeartbeatFile ?? "/tmp/firecrawl-worker-heartbeat";
  await writeHeartbeat(heartbeatFile);
  const heartbeatTimer = setInterval(() => {
    void writeHeartbeat(heartbeatFile).catch((error) => {
      rootLogger.error({ err: error }, "Worker heartbeat failed");
    });
  }, HEARTBEAT_INTERVAL_MS);
  const stopJobs = startWorker(config);
  let stopping = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    rootLogger.info({ signal }, "Worker shutting down gracefully");
    stopJobs();
    await closeDatabase();
    rootLogger.info("Worker database clients closed");
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0)).catch((error) => {
      rootLogger.error({ err: error }, "Worker shutdown failed");
      process.exit(1);
    });
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0)).catch((error) => {
      rootLogger.error({ err: error }, "Worker shutdown failed");
      process.exit(1);
    });
  });

  rootLogger.info({ heartbeatFile }, "Background worker ready");
}

if (require.main === module) {
  void runWorkerProcess().catch((error) => {
    rootLogger.error({ err: error }, "Worker failed to start");
    process.exitCode = 1;
  });
}
