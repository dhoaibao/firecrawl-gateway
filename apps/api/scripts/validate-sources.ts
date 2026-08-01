import { parseConfig } from "../src/config";
import { initDatabase, withOperatorTransaction } from "../src/db";
import { validateOperatorCredential } from "../src/credentials/repository";

/** Explicit, bounded external validation for pending operator Cloud sources. */
async function main() {
  const config = parseConfig();
  await initDatabase(config.databaseUrl, config.operatorDatabaseUrl);
  const sources = await withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string; credential_id: string }>(
      `SELECT id, credential_id FROM infrastructure_sources
       WHERE kind = 'cloud' AND credential_id IS NOT NULL AND status = 'active'`,
    );
    return result.rows;
  });
  let valid = 0;
  let invalid = 0;
  for (const source of sources) {
    const credential = await validateOperatorCredential(
      source.credential_id,
      source.id,
      config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey,
      config.cloudBaseUrl,
    );
    if (credential?.status === "valid") valid += 1;
    else invalid += 1;
  }
  console.log(`validated\t${valid}\ninvalid\t${invalid}`);
}

main().catch((error: Error) => {
  console.error(`Source validation failed: ${error.message}`);
  process.exitCode = 1;
});
