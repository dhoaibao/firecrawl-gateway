import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AppConfigService } from "../../../core/config/config.service";
import { deleteAuditEntriesBefore } from "../../../audit-repository";
import { recordSecurityEvent } from "../../../auth/security";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 10;

@Injectable()
export class AuditRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, RETENTION_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const retentionDays = this.config.auditRetentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      let deleted = 0;
      let batches = 0;
      await recordSecurityEvent({
        type: "audit_retention_started",
        metadata: { cutoff: cutoff.toISOString(), batch_size: RETENTION_BATCH_SIZE, max_batches: MAX_BATCHES_PER_RUN, protected_ledgers: "usage_events,quota_events" },
      });
      while (batches < MAX_BATCHES_PER_RUN) {
        const count = await deleteAuditEntriesBefore(cutoff, RETENTION_BATCH_SIZE);
        if (count === 0) break;
        deleted += count;
        batches += 1;
      }
      await recordSecurityEvent({
        type: "audit_retention_completed",
        metadata: { cutoff: cutoff.toISOString(), deleted, batches, batch_size: RETENTION_BATCH_SIZE, max_batches: MAX_BATCHES_PER_RUN, protected_ledgers: "usage_events,quota_events" },
      });
      if (deleted > 0) this.logger.log(`Completed bounded audit retention run: ${deleted} rows in ${batches} batches`);
      return deleted;
    } catch (error) {
      this.logger.error(`Audit retention job failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
