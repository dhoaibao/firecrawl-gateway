import fs from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AppConfigService } from "../../core/config/config.service";

const INTERVAL_MS = 10_000;

@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer?: NodeJS.Timeout;
  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.write();
    this.timer = setInterval(() => { void this.write().catch((error: unknown) => this.logger.error("Worker heartbeat failed", error instanceof Error ? error.stack : String(error))); }, INTERVAL_MS);
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private async write(): Promise<void> { const file = this.config.workerHeartbeatFile; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${new Date().toISOString()}\n`, "utf8"); }
}
