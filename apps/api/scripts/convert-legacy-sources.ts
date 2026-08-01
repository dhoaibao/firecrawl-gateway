import { parseConfig } from "../src/config";
import { initDatabase, withOperatorTransaction } from "../src/db";
import { decryptSettingValue } from "../src/settings/crypto";
import * as settings from "../src/settings/service";
import { createOperatorCredential } from "../src/credentials/repository";
import { createInfrastructureSource } from "../src/sources/repository";

/**
 * One-time, idempotent application migration for legacy encrypted settings.
 * SQL cannot safely decrypt these values. This command deliberately reports
 * counts only; it never writes a raw credential or source URL to stdout.
 */
async function sourceCredentialId(id: string): Promise<string | null | undefined> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ credential_id: string | null }>(
      "SELECT credential_id FROM infrastructure_sources WHERE id = $1",
      [id],
    );
    return result.rows[0]?.credential_id;
  });
}

async function sourceExists(id: string): Promise<boolean> {
  return (await sourceCredentialId(id)) !== undefined;
}

async function migratedCredentialId(sourceId: string): Promise<string | undefined> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM provider_credentials
       WHERE owner_type = 'operator' AND purpose = 'firecrawl_cloud'
         AND provider_metadata->>'migrated_source_id' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sourceId],
    );
    return result.rows[0]?.id;
  });
}

async function main() {
  const config = parseConfig();
  await initDatabase(config.databaseUrl, config.operatorDatabaseUrl);
  let cloudSourcesCreated = 0;
  let selfHostedSourcesCreated = 0;

  const cloudSetting = await settings.getSetting("firecrawl_api_keys");
  if (cloudSetting?.value) {
    const decrypted = decryptSettingValue(cloudSetting.value, config.firecrawlKeysEncryptionKey);
    const keys = JSON.parse(decrypted.value) as unknown;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key)) {
      throw new Error("Legacy Firecrawl Cloud credential setting has an invalid format");
    }
    for (const [index, value] of keys.entries()) {
      const sourceId = `legacy-cloud-${index + 1}`;
      const existingCredentialId = await sourceCredentialId(sourceId);
      if (existingCredentialId) continue;
      if (existingCredentialId === undefined) {
        await createInfrastructureSource({
          id: sourceId,
          name: `Migrated Cloud credential ${index + 1}`,
          kind: "cloud",
          priority: index + 1,
        });
        cloudSourcesCreated += 1;
      }
      // A prior run may have created the source before credential creation or
      // attachment failed. Resume from that incomplete state rather than
      // treating source existence alone as successful conversion.
      let credentialId = await migratedCredentialId(sourceId);
      if (!credentialId) {
        const credential = await createOperatorCredential({
          value,
          purpose: "firecrawl_cloud",
          sourceId,
          keyVersion: 1,
          providerMetadata: { migrated_from: "firecrawl_api_keys", migrated_source_id: sourceId },
        }, config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey);
        credentialId = credential.id;
      }
      await createInfrastructureSource({
        id: sourceId,
        name: `Migrated Cloud credential ${index + 1}`,
        kind: "cloud",
        credentialId,
        priority: index + 1,
      });
    }
  }

  const selfHostedSetting = await settings.getSetting("self_hosted_firecrawl_url");
  if (selfHostedSetting?.value && !await sourceExists("legacy-self-hosted")) {
    await createInfrastructureSource({
      id: "legacy-self-hosted",
      name: "Migrated self-hosted Firecrawl",
      kind: "self_hosted",
      baseUrl: selfHostedSetting.value,
      // This is the explicit compatibility exception for an operator-approved
      // legacy setting; newly created sources default to rejecting private URLs.
      allowPrivateNetwork: true,
    });
    selfHostedSourcesCreated += 1;
  }

  console.log(`cloud_sources_created\t${cloudSourcesCreated}`);
  console.log(`self_hosted_sources_created\t${selfHostedSourcesCreated}`);
}

main().catch((error: Error) => {
  console.error(`Legacy source conversion failed: ${error.message}`);
  process.exitCode = 1;
});
