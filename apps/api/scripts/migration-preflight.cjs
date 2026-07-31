const { Client } = require("pg");

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  console.error("MIGRATION_DATABASE_URL is required for migration preflight.");
  process.exit(2);
}
if (process.env.MIGRATION_BACKUP_CONFIRMED !== "true") {
  console.error("Set MIGRATION_BACKUP_CONFIRMED=true after verifying a restorable database backup.");
  process.exit(2);
}

const client = new Client({ connectionString: databaseUrl });
const checks = [
  ["users", "SELECT COUNT(*)::bigint AS count FROM users"],
  ["api_keys", "SELECT COUNT(*)::bigint AS count FROM api_keys"],
  ["audit_logs", "SELECT COUNT(*)::bigint AS count FROM audit_logs"],
  ["orphan_api_keys", "SELECT COUNT(*)::bigint AS count FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id WHERE u.id IS NULL"],
  ["orphan_audit_users", "SELECT COUNT(*)::bigint AS count FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.user_id IS NOT NULL AND u.id IS NULL"],
  ["duplicate_normalized_emails", "SELECT COUNT(*)::bigint AS count FROM (SELECT lower(btrim(email)) FROM users GROUP BY lower(btrim(email)) HAVING COUNT(*) > 1) duplicates"],
  ["invalid_user_statuses", "SELECT COUNT(*)::bigint AS count FROM users WHERE status NOT IN ('active', 'suspended', 'blocked', 'deleted')"],
];

(async () => {
  try {
    await client.connect();
    const version = await client.query(
      "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1",
    ).catch(() => ({ rows: [] }));
    console.log(`current_version\t${version.rows[0]?.name ?? "none"}`);

    for (const [name, query] of checks) {
      const result = await client.query(query);
      const count = Number(result.rows[0].count);
      console.log(`${name}\t${count}`);
      if ((name.startsWith("orphan_") || name === "duplicate_normalized_emails" || name === "invalid_user_statuses") && count > 0) {
        throw new Error(`${name} check failed; resolve invalid identity data before migrating`);
      }
    }

    const size = await client.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size");
    console.log(`database_size\t${size.rows[0].size}`);
    console.log("disk_headroom\tverify independently with the database platform before applying");
    console.log("preflight\tok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
})();
