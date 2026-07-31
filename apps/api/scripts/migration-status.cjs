const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  console.error("MIGRATION_DATABASE_URL is required for migration status.");
  process.exit(2);
}

const migrationsDir = path.join(__dirname, "..", "migrations");
const migrations = fs.readdirSync(migrationsDir)
  .filter((file) => /^\d+_.+\.(cjs|js|ts|sql)$/.test(file))
  .sort()
  .map((file) => ({ file, name: file.replace(/\.(cjs|js|ts|sql)$/, "") }));

const client = new Client({ connectionString: databaseUrl });

(async () => {
  try {
    await client.connect();
    const result = await client.query(
      "SELECT name, run_on FROM pgmigrations ORDER BY id",
    );
    const applied = new Map(result.rows.map((row) => [row.name, row.run_on]));
    const formatRunOn = (value) => value instanceof Date ? value.toISOString() : String(value);
    for (const migration of migrations) {
      const runOn = applied.get(migration.name);
      console.log(`${runOn ? "applied" : "pending"}\t${migration.file}${runOn ? `\t${formatRunOn(runOn)}` : ""}`);
    }
    const knownNames = new Set(migrations.map((migration) => migration.name));
    for (const row of result.rows) {
      if (!knownNames.has(row.name)) {
        console.log(`unknown\t${row.name}\t${formatRunOn(row.run_on)}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
})();
