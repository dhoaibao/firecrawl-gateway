const { spawnSync } = require("node:child_process");
const path = require("node:path");

const [command, ...commandArgs] = process.argv.slice(2);
const allowedCommands = new Set(["up", "down", "create"]);

if (!allowedCommands.has(command)) {
  console.error("Usage: npm run migrate:<up|down|create> [name]");
  process.exit(2);
}

if ((command === "up" || command === "down") && !process.env.MIGRATION_DATABASE_URL) {
  console.error("MIGRATION_DATABASE_URL is required for migration changes.");
  process.exit(2);
}

if (command === "down" && process.env.NODE_ENV === "production") {
  console.error("Down migrations are development-only. Use a forward fix in production.");
  process.exit(2);
}

const migrationCli = path.join(
  path.dirname(require.resolve("node-pg-migrate/package.json")),
  "bin",
  "node-pg-migrate.js",
);
const args = [
  command,
  ...commandArgs,
  "--migrations-dir",
  path.join(__dirname, "..", "migrations"),
  "--database-url-var",
  "MIGRATION_DATABASE_URL",
  "--check-order",
  "--single-transaction",
];

const result = spawnSync(process.execPath, [migrationCli, ...args], { stdio: "inherit", shell: false });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
