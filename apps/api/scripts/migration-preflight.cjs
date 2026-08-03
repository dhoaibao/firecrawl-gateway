const { PrismaClient } = require("@prisma/client");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
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
const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
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

    const localMigrations = fs.readdirSync(migrationsDir)
      .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
      .sort();
    const migrationTable = await client.$queryRawUnsafe(
      "SELECT to_regclass('public._prisma_migrations') AS relation",
    );
    if (!migrationTable[0]?.relation) {
      console.log("prisma_migrations\tnone; treating database as a legacy baseline candidate");
      const diff = spawnSync(
        prismaBin,
        ["migrate", "diff", "--exit-code", "--from-schema-datasource", schema, "--to-schema-datamodel", schema, "--script"],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdio: "inherit",
        },
      );
      if (diff.error) {
        throw new Error(`Unable to run Prisma schema diff: ${diff.error.message}`);
      }
      if ((diff.status ?? 1) !== 0) {
        console.error("Prisma schema diff found differences; review the existing database before baselining");
        exitCode = 2;
        return;
      }
      console.log("schema_diff\tok; database is eligible for reviewed Prisma baselining");
      exitCode = 0;
      return;
    }

    const appliedMigrations = await client.$queryRawUnsafe(
      "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at",
    );
    const appliedNames = new Set();
    for (const migration of appliedMigrations) {
      appliedNames.add(migration.migration_name);
      if (!migration.finished_at || migration.rolled_back_at) {
        throw new Error(`migration ${migration.migration_name} is incomplete or rolled back`);
      }
      if (!localMigrations.includes(migration.migration_name)) {
        throw new Error(`database migration ${migration.migration_name} is not present in the release image`);
      }
    }
    const pendingMigrations = localMigrations.filter((name) => !appliedNames.has(name));
    console.log(`pending_migrations\t${pendingMigrations.length ? pendingMigrations.join(",") : "none"}`);

    const status = spawnSync(
      prismaBin,
      ["migrate", "status", "--schema", schema],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
      },
    );
    if (status.error) {
      throw new Error(`Unable to run Prisma migration status: ${status.error.message}`);
    }
    const statusOutput = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
    process.stdout.write(statusOutput);
    if (/drift detected|schema drift|diverg/i.test(statusOutput)) {
      throw new Error("Prisma reported schema drift; review the database before applying pending migrations");
    }
    const expectedPendingStatus = /not yet been applied|not in sync|not up to date|pending migration|following migration/i.test(statusOutput);
    if ((status.status ?? 1) !== 0 && !(pendingMigrations.length > 0 && expectedPendingStatus)) {
      throw new Error("Prisma migration status could not be verified safely");
    }
    console.log("preflight\tok; pending migrations are expected to be applied by the following migrate step");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }

  process.exitCode = exitCode;
}

void run();
