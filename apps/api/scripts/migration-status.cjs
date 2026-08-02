const { spawnSync } = require("node:child_process");
const path = require("node:path");

const schema = path.resolve(__dirname, "../prisma/schema.prisma");
const prismaBin = path.resolve(__dirname, "../../../node_modules/.bin/prisma");
const result = spawnSync(prismaBin, ["migrate", "status", "--schema", schema], {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`Unable to inspect Prisma migration status: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
