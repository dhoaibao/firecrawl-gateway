const { PrismaClient } = require("@prisma/client");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  console.error("MIGRATION_DATABASE_URL is required for migration preflight.");
  process.exit(2);
}
if (process.env.MIGRATION_BACKUP_CONFIRMED !== "true") {
  console.error("Set MIGRATION_BACKUP_CONFIRMED=true after verifying a restorable database backup.");
  process.exit(2);
}

const schema = path.resolve(__dirname, "../prisma/schema.prisma");
const prismaBin = path.resolve(__dirname, "../../../node_modules/.bin/prisma");
const checks = [
  ["users", "SELECT COUNT(*)::bigint AS count FROM users"],
  ["api_keys", "SELECT COUNT(*)::bigint AS count FROM api_keys"],
  ["audit_logs", "SELECT COUNT(*)::bigint AS count FROM audit_logs"],
  [
    "orphan_api_keys",
    "SELECT COUNT(*)::bigint AS count FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id WHERE u.id IS NULL",
  ],
  [
    "orphan_audit_users",
    "SELECT COUNT(*)::bigint AS count FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.user_id IS NOT NULL AND u.id IS NULL",
  ],
  [
    "duplicate_normalized_emails",
    "SELECT COUNT(*)::bigint AS count FROM (SELECT lower(btrim(email)) FROM users GROUP BY lower(btrim(email)) HAVING COUNT(*) > 1) duplicates",
  ],
  [
    "invalid_user_statuses",
    "SELECT COUNT(*)::bigint AS count FROM users WHERE status NOT IN ('active', 'suspended', 'blocked', 'deleted')",
  ],
];

function countFrom(row) {
  const value = row?.count;
  const count = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error("A preflight count exceeds the JavaScript safe integer range");
  }
  return count;
}

async function run() {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let exitCode = 1;

  try {
    await client.$connect();

    const version = await client.$queryRawUnsafe(
      "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1",
    ).catch(() => []);
    console.log(`current_version\t${version[0]?.name ?? "none"}`);

    for (const [name, query] of checks) {
      const result = await client.$queryRawUnsafe(query);
      const count = countFrom(result[0]);
      console.log(`${name}\t${count}`);
      if (
        (name.startsWith("orphan_") || name === "duplicate_normalized_emails" || name === "invalid_user_statuses") &&
        count > 0
      ) {
        throw new Error(`${name} check failed; resolve invalid identity data before migrating`);
      }
    }

    const size = await client.$queryRawUnsafe(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size",
    );
    console.log(`database_size\t${size[0]?.size ?? "unknown"}`);
    console.log("disk_headroom\tverify independently with the database platform before applying");

    const result = spawnSync(
      prismaBin,
      ["migrate", "diff", "--exit-code", "--from-schema-datasource", schema, "--to-schema-datamodel", schema, "--script"],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw new Error(`Unable to run Prisma schema diff: ${result.error.message}`);
    }
    exitCode = result.status ?? 1;
    if (exitCode === 0) console.log("preflight\tok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }

  process.exitCode = exitCode;
}

void run();
