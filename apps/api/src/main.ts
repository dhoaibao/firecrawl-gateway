import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { corsOriginsFor } from "./common/cors";
import { serializeRequestForLog } from "./common/log-redaction";
import { enabledProviders } from "./portal-auth/oauth-providers";
import { randomUUID } from "node:crypto";

export async function createApp(): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const adapter = new FastifyAdapter({
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy === true || config.trustProxy === "true",
    logger: { level: config.logLevel, serializers: { req: serializeRequestForLog } },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const fastify = app.getHttpAdapter().getInstance();
  type FastifyRegisterPlugin = Parameters<typeof fastify.register>[0];
  fastify.addHook("onRequest", (request, reply, done) => {
    const requestId = String(request.headers["x-request-id"] || randomUUID());
    (request as typeof request & { requestId: string }).requestId = requestId;
    reply.header("x-request-id", requestId);
    done();
  });
  await fastify.register(cookie as unknown as FastifyRegisterPlugin);
  await fastify.register(rawBody as unknown as FastifyRegisterPlugin, {
    field: "rawBody",
    global: true,
    encoding: "utf8",
    runFirst: true,
  });
  await fastify.register(cors as unknown as FastifyRegisterPlugin, {
    // Per-route: the portal origin is allowed on /portal/api only (see corsOriginsFor).
    delegator: (
      request: { url: string },
      callback: (error: Error | null, options: object) => void,
    ) => {
      const origins = corsOriginsFor(config, request.url);
      callback(null, {
        origin: origins.length ? origins : false,
        credentials: true,
        methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      });
    },
  });
  await fastify.register(helmet as unknown as FastifyRegisterPlugin);
  await app.init();
  const portalEnabled = enabledProviders(config).length > 0;
  const handled = config.authEnabled
    ? `/v1/*, /v2/*, /health, /ready, ${portalEnabled ? "/portal, " : ""}and /admin`
    : `/v1/*, /v2/*, /health, ${portalEnabled ? "/portal, " : ""}and /ready`;
  fastify.route({
    method: ["GET", "HEAD", "TRACE", "DELETE", "PATCH", "PUT", "POST", "QUERY"],
    url: "/*",
    handler: (_request, reply) =>
      reply.code(404).send({ success: false, error: `Only ${handled} are handled.` }),
  });
  await fastify.ready();
  return app;
}

// Nest's close() destroys modules (Prisma, Redis) before it closes the HTTP server, so
// drain in-flight proxied requests first and only then tear the modules down.
export async function drainAndClose(app: NestFastifyApplication): Promise<void> {
  await app.getHttpAdapter().close();
  await app.close();
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  await app.listen(config.port, "0.0.0.0");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Exit before the container runtime's SIGKILL (stop_grace_period in deploy/gateway).
    setTimeout(() => process.exit(1), config.requestTimeoutMs + 5_000).unref();
    drainAndClose(app).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (require.main === module) void bootstrap();
