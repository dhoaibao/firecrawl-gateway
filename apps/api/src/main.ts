import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { AppModule } from "./app.module";
import { configureFastifyHttp } from "./common/http/fastify-http";
import { AppConfigService } from "./core/config/config.service";
import { validateEnvironment } from "./core/config/environment.schema";
import { PrismaSessionStore } from "./modules/auth/infrastructure/prisma-session.store";

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: environment.TRUST_PROXY }),
  );
  const config = app.get(AppConfigService);
  configureFastifyHttp(app, config.corsOrigins);

  if (config.authEnabled) {
    await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);
    await app.register(fastifySession as unknown as Parameters<typeof app.register>[0], {
      secret: config.sessionSecret,
      cookieName: config.sessionCookieName,
      cookiePrefix: "s:",
      store: app.get(PrismaSessionStore),
      saveUninitialized: false,
      rolling: false,
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: config.sessionSecure,
        sameSite: "lax",
        path: "/",
      },
    });
  }

  app.enableShutdownHooks();
  await app.listen({ host: config.host, port: config.port });
}

void bootstrap();
