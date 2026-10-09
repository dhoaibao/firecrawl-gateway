import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { randomUUID } from "node:crypto";

export async function createApp(): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const adapter = new FastifyAdapter({
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy === true || config.trustProxy === "true",
    logger: { level: config.logLevel },
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
  const allowedOrigins = [config.adminOrigin, config.apiOrigin].filter(Boolean);
  await fastify.register(cors as unknown as FastifyRegisterPlugin, {
    origin: allowedOrigins.length ? allowedOrigins : false,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await fastify.register(helmet as unknown as FastifyRegisterPlugin);
  await app.init();
  const handled = config.authEnabled
    ? "/v1/*, /v2/*, /health, /ready, and /admin"
    : "/v1/*, /v2/*, /health, and /ready";
  fastify.route({
    method: ["GET", "HEAD", "TRACE", "DELETE", "PATCH", "PUT", "POST", "QUERY"],
    url: "/*",
    handler: (_request, reply) =>
      reply.code(404).send({ success: false, error: `Only ${handled} are handled.` }),
  });
  await fastify.ready();
  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  await app.listen(config.port, "0.0.0.0");
}

if (require.main === module) void bootstrap();
