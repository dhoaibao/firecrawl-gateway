import { deleteAuditEntriesBefore } from "../audit-repository";
import { recordSecurityEvent } from "../auth/security";
import { rootLogger } from "../logger";
import type { GatewayConfig } from "../types";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 10;
const logger = rootLogger.child({ module: "audit-retention" });

/**
 * Deletes only request-audit rows older than the configured horizon. Quota
 * usage/reconciliation ledgers are separate tables and are never part of this
 * query; the security event provides evidence of each completed run.
 */
export async function runAuditRetention(config: GatewayConfig): Promise<number> {
  const retentionDays = config.auditRetentionDays ?? 90;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  let batches = 0;
  await recordSecurityEvent({
    type: "audit_retention_started",
    metadata: {
      cutoff: cutoff.toISOString(),
      batch_size: RETENTION_BATCH_SIZE,
      max_batches: MAX_BATCHES_PER_RUN,
      protected_ledgers: "usage_events,quota_events",
    },
  });

  while (batches < MAX_BATCHES_PER_RUN) {
    const count = await deleteAuditEntriesBefore(cutoff, RETENTION_BATCH_SIZE);
    if (count === 0) break;
    deleted += count;
    batches += 1;
  }

  {
    await recordSecurityEvent({
      type: "audit_retention_completed",
      metadata: {
        cutoff: cutoff.toISOString(),
        deleted,
        batches,
        batch_size: RETENTION_BATCH_SIZE,
        max_batches: MAX_BATCHES_PER_RUN,
        protected_ledgers: "usage_events,quota_events",
      },
    });
  }
  if (deleted > 0) logger.info({ deleted, batches, cutoff }, "Completed bounded audit retention run");
  return deleted;
}

export function startAuditRetentionJob(config: GatewayConfig): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runAuditRetention(config);
    } catch (error) {
      logger.error({ err: error }, "Audit retention job failed");
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), RETENTION_INTERVAL_MS);
  return () => clearInterval(timer);
}
