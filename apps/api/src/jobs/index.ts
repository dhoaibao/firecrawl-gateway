import { startEmailWorker } from "../auth/email";
import { rootLogger } from "../logger";
import type { GatewayConfig } from "../types";

const logger = rootLogger.child({ module: "background-jobs" });

/** Durable workers only; account suspension and token revocation are explicit/user-configured actions. */
export function startBackgroundJobs(config?: GatewayConfig): () => void {
  logger.info("Background email outbox worker scheduled");
  return config ? startEmailWorker(config) : () => undefined;
}
