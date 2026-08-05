import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { rootLogger } from "./logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  rootLogger.fatal({ err: error }, "Worker failed to start");
  process.exit(1);
});
