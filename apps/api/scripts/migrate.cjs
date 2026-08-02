const { spawnSync } = require("node:child_process");
const path = require("node:path");

const schema = path.resolve(__dirname, "../prisma/schema.prisma");
const prismaBin = path.resolve(__dirname, "../../../node_modules/.bin/prisma");
const direction = process.argv[2];

if (direction && direction !== "up" && direction !== "deploy") {
  console.error("Only forward Prisma deployment is supported. Review the database migration procedure before making schema changes.");
  process.exit(2);
}

const result = spawnSync(prismaBin, ["migrate", "deploy", "--schema", schema], {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`Unable to run Prisma migration deploy: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
