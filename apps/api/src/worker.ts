import { startBackgroundJobs } from "./jobs";
import type { GatewayConfig } from "./types";

/** Start durable job processing independently from HTTP app construction. */
export function startWorker(config?: GatewayConfig): () => void {
  return startBackgroundJobs(config);
}
