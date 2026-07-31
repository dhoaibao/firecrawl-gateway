import { startBackgroundJobs } from "./jobs";

/** Start durable job processing independently from HTTP app construction. */
export function startWorker(): () => void {
  return startBackgroundJobs();
}
