import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AppConfigService } from "../../../core/config/config.service";
import { EmailService } from "./email.service";

const WORK_INTERVAL_MS = 5_000;

@Injectable()
export class EmailWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly config: AppConfigService, private readonly email: EmailService) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.brevoApiKey) return;
    await this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, WORK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.email.claimOne();
    } catch (error) {
      this.logger.error(`Email outbox worker failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
