import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260815130000_single_admin_cutover/migration.sql"),
  "utf8",
);
const compatibilityMigration = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260815140000_audit_target_url_compatibility/migration.sql",
  ),
  "utf8",
);
const repairMigration = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20260815150000_audit_target_url_repair/migration.sql"),
  "utf8",
);

describe("single-admin cutover", () => {
  it("keeps global keys and audits valid without an owner", () => {
    // The cutover removed users; portal accounts came back later as separate tables
    // (see user-accounts-migration.test.ts), and ownership stays optional so every
    // global key and audit row written by the single-admin deployment remains valid.
    expect(schema).toContain("model ApiKey");
    expect(schema).toContain("model AuditLog");
    expect(schema).toMatch(/userId\s+String\?\s+@map\("user_id"\)/);
    expect(schema).toContain('targetUrl      String   @default("") @map("target_url")');
  });

  it("deletes legacy identities, keys, and audits before removing ownership", () => {
    expect(migration).toContain("DELETE FROM audit_logs");
    expect(migration).toContain("DELETE FROM api_keys");
    expect(migration).toContain("DROP TABLE IF EXISTS users");
    expect(migration).toContain("ALTER TABLE api_keys DROP COLUMN IF EXISTS user_id");
    expect(migration).toContain("ALTER TABLE audit_logs DROP COLUMN IF EXISTS user_id");
  });

  it("adds target_url for legacy audit tables before Prisma reads AuditLog", () => {
    expect(compatibilityMigration).toContain("ALTER TABLE audit_logs");
    expect(compatibilityMigration).toContain(
      "ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT ''",
    );
  });

  it("ships a pending repair migration after the recorded compatibility migration", () => {
    const migrations = readdirSync(resolve(process.cwd(), "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrations).toContain("20260815150000_audit_target_url_repair");
    expect(migrations.indexOf("20260815150000_audit_target_url_repair")).toBeGreaterThan(
      migrations.indexOf("20260815140000_audit_target_url_compatibility"),
    );
    expect(repairMigration).toContain(
      "ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT ''",
    );
  });
});
