import bcrypt from "bcrypt";
import type { Socket } from "node:net";
import { parseConfig } from "./config";
import { closeDatabase, initDatabase } from "./db";
import { bootstrapAdminUser } from "./db/bootstrap";
import { createAuditStore } from "./audit-store";
import { consumeRateLimit } from "./rate-limit-store";
import { createProxyHandler } from "./proxy";
import { createApp } from "./app";
import { createSessionMiddleware } from "./auth/session";
import { startWorker } from "./worker";
import { rootLogger } from "./logger";

export async function startServer() {
  let config;
  try {
    config = parseConfig();
  } catch (error) {
    rootLogger.error({ err: error }, "Configuration error");
    process.exitCode = 1;
    return;
  }

  await initDatabase(config.databaseUrl, config.operatorDatabaseUrl);

  if (config.authEnabled && config.adminEmail && config.adminPassword) {
    const roundsRaw = process.env.BCRYPT_ROUNDS;
    const rounds = roundsRaw ? Number(roundsRaw) : 12;
    if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
      rootLogger.error("BCRYPT_ROUNDS must be an integer between 4 and 31");
      process.exit(1);
    }
    const adminHash = await bcrypt.hash(config.adminPassword, rounds);
    await bootstrapAdminUser(config.adminEmail, "Admin", adminHash);
  }

  // PostgreSQL is the canonical audit store in production. JSONL remains an
  // explicit compatibility option for local diagnostics, never a secret-bearing
  // production volume.
  const auditStore = createAuditStore(config.logFile, { persistToDatabase: true, persistToFile: false });
  const handleProxy = createProxyHandler({ config, auditStore });
  const sessionMiddleware = config.authEnabled
    ? createSessionMiddleware(config.sessionSecret)
    : undefined;
  const app = createApp({
    config,
    auditStore,
    handleProxy,
    sessionMiddleware,
    rateLimitStore: { consume: consumeRateLimit },
  });
  const stopWorker = config.workerEnabled === false ? () => undefined : startWorker(config);
  const server = app.listen(config.port, "0.0.0.0", () => {
    // Keep the edge and Node ceilings finite so stalled clients do not pin
    // sockets indefinitely. Upstream aborts use the configured request timeout.
    server.requestTimeout = config.requestTimeoutMs + 10_000;
    server.headersTimeout = config.requestTimeoutMs + 15_000;
    server.keepAliveTimeout = 5_000;
    rootLogger.info(
      {
        port: config.port,
        cloud: config.cloudBaseUrl,
        mode: config.defaultRouteMode,
        auth: config.authEnabled,
      },
      "Hybrid Firecrawl Gateway started",
    );
  });

  const connections = new Set<Socket>();
  server.on("connection", (connection: Socket) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });

  async function gracefulShutdown(signal: string): Promise<void> {
    rootLogger.info({ signal }, "Shutting down gracefully");
    stopWorker();

    server.close(async () => {
      rootLogger.info("HTTP server closed");
      try {
        await auditStore.flush?.(5_000);
        await closeDatabase();
        rootLogger.info("Prisma database clients closed");
        process.exit(0);
      } catch (poolErr) {
        rootLogger.error({ err: poolErr }, "Error closing database pool");
        process.exit(1);
      }
    });

    setTimeout(() => {
      rootLogger.warn("Forcing remaining connections closed");
      for (const connection of connections) connection.destroy();
    }, 10_000);

    setTimeout(() => {
      rootLogger.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
  }

  process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.once("uncaughtException", (err) => {
    rootLogger.error({ err }, "Uncaught Exception");
    process.exitCode = 1;
    void gracefulShutdown("uncaughtException");
  });
  process.once("unhandledRejection", (reason) => {
    rootLogger.error({ reason }, "Unhandled Rejection");
    process.exitCode = 1;
    void gracefulShutdown("unhandledRejection");
  });

  return { app, server, gracefulShutdown };
}

void startServer();
