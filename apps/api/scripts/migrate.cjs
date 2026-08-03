const { spawnSync } = require("node:child_process");
const path = require("node:path");

const schema = path.resolve(__dirname, "../prisma/schema.prisma");
const security = path.resolve(__dirname, "../prisma/security.sql");
const prismaBin = path.resolve(__dirname, "../../../node_modules/.bin/prisma");
const direction = process.argv[2];

if (direction && direction !== "up" && direction !== "deploy") {
  console.error("Only forward Prisma deployment is supported. Review the database migration procedure before making schema changes.");
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set to the deployment-only migration credential.");
  process.exit(2);
}

function run(args) {
  const result = spawnSync(prismaBin, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Unable to run Prisma command: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run(["migrate", "deploy", "--schema", schema]);
run(["db", "execute", "--schema", schema, "--file", security]);
