import { startEmailWorker } from "../auth/email";
import { startQuotaJobs } from "./quota-jobs";
import { startAuditRetentionJob } from "./audit-retention";
import { rootLogger } from "../logger";
import type { GatewayConfig } from "../types";

const logger = rootLogger.child({ module: "background-jobs" });

/** Durable workers only; account suspension and token revocation are explicit/user-configured actions. */
export function startBackgroundJobs(config?: GatewayConfig): () => void {
  logger.info("Background email outbox worker scheduled");
  const stops: Array<() => void> = [];
  if (config) {
    stops.push(startEmailWorker(config));
    stops.push(startAuditRetentionJob(config));
  }
  // Quota workers are schedule-only and need no configuration beyond the DB.
  stops.push(startQuotaJobs());
  return () => {
    for (const stop of stops) stop();
  };
}
