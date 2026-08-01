import { parseConfig } from "../src/config";
import { initDatabase } from "../src/db";
import { reconcile } from "../src/quota/service";

/**
 * Read-only operational reconciliation for the quota ledger. Reports
 * mismatches between immutable usage events and denormalized counters;
 * never repairs automatically. Repairs require an operator-reviewed
 * ledger adjustment or migration.
 *
 * Usage: npm run --workspace @firecrawl/api quota:reconcile -- [periodId]
 */
async function main() {
  const config = parseConfig();
  await initDatabase(config.databaseUrl, config.operatorDatabaseUrl);
  const periodId = process.argv[2];
  const report = await reconcile(periodId);

  console.log(`generated_at\t${report.generatedAt}`);
  console.log(`period\t${report.periodId}`);
  for (const check of report.checks) {
    console.log(`${check.status}\t${check.name}\t${check.details}`);
  }
  console.log(`mismatches\t${report.mismatches}`);
  if (report.mismatches > 0) {
    console.error(
      "Quota ledger mismatches detected. Do not repair automatically; review and apply an operator ledger adjustment.",
    );
    process.exitCode = 2;
  }
}

main().catch((error: Error) => {
  console.error(`Quota reconciliation failed: ${error.message}`);
  process.exitCode = 1;
});
