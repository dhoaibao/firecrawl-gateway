import { withClient } from "../db";
import * as settingsService from "../settings/service";
import { rootLogger } from "../logger";

const logger = rootLogger.child({ module: "background-jobs" });

/** How often to run background jobs (ms) */
const JOB_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startBackgroundJobs() {
  logger.info("Background jobs scheduled every 1 hour");

  // Run immediately on startup, then periodically
  void runJobs();
  const interval = setInterval(() => {
    void runJobs();
  }, JOB_INTERVAL_MS);

  return () => clearInterval(interval);
}

async function runJobs() {
  try {
    await autoRevokeInactiveApiKeys();
  } catch (err) {
    logger.error({ err }, "Auto-revoke job failed");
  }

  try {
    await autoSuspendInactiveUsers();
  } catch (err) {
    logger.error({ err }, "Auto-suspend job failed");
  }
}

async function autoRevokeInactiveApiKeys() {
  const record = await settingsService.getSetting("api_key_inactivity_revoke_days");
  if (!record) return;

  const days = Number(record.value);
  if (!Number.isFinite(days) || days <= 0) return;

  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const revoked = await withClient(async (client) => {
    const result = await client.query(
      `UPDATE api_keys
       SET revoked = true, updated_at = NOW()
       WHERE revoked = false
         AND (last_used_at IS NULL OR last_used_at < $1)
         AND created_at < $1
       RETURNING id`,
      [threshold.toISOString()],
    );
    return result.rowCount || 0;
  }, { operator: true });

  if (revoked > 0) {
    logger.info({ revoked, threshold: threshold.toISOString() }, "Auto-revoked inactive API keys");
  }
}

async function autoSuspendInactiveUsers() {
  const record = await settingsService.getSetting("user_inactivity_suspend_days");
  if (!record) return;

  const days = Number(record.value);
  if (!Number.isFinite(days) || days <= 0) return;

  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Suspend users whose account is old enough and who have no recently-used API keys.
  // A key that has never been used (last_used_at IS NULL) does NOT count as recent activity.
  const suspended = await withClient(async (client) => {
    const result = await client.query(
      `UPDATE users
       SET status = 'suspended',
           suspended_until = NULL,
           updated_at = NOW()
       WHERE status = 'active'
         AND is_admin = false
         AND COALESCE(platform_role, 'user') <> 'admin'
         AND created_at < $1
         AND NOT EXISTS (
           SELECT 1 FROM api_keys
           WHERE api_keys.user_id = users.id
             AND api_keys.revoked = false
             AND api_keys.last_used_at > $1
         )
       RETURNING id`,
      [threshold.toISOString()],
    );
    return result.rowCount || 0;
  }, { operator: true });

  if (suspended > 0) {
    logger.info({ suspended, threshold: threshold.toISOString() }, "Auto-suspended inactive users");
  }
}
