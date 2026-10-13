import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve(process.cwd(), "prisma/migrations/20261011150000_user_accounts/migration.sql"),
  "utf8",
);
// Comments may mention the words below; only the statements are inspected.
const statements = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("user accounts migration", () => {
  it("is purely additive: it never drops, deletes, rewrites, or tightens existing data", () => {
    expect(statements).not.toMatch(/\bDROP\b/i);
    // Statements only: `ON DELETE CASCADE` on the new tables' foreign keys is expected.
    expect(statements).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/^\s*UPDATE\s+\w+\s+SET/im);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/ALTER COLUMN/i);
    expect(statements).not.toMatch(/SET NOT NULL/i);
  });

  it("creates the four account tables with plain CREATE TABLE so a stale table fails loudly", () => {
    for (const table of ["users", "user_identities", "user_sessions", "user_cloud_keys"]) {
      expect(statements).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
    }
    expect(statements).not.toMatch(/CREATE TABLE IF NOT EXISTS/i);
  });

  it("adds only nullable ownership columns to the existing tables", () => {
    expect(statements).toContain("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT;");
    expect(statements).toContain("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id TEXT;");
    // No foreign key to the new table from these rows: deleting a user never cascades into them.
    expect(statements).not.toMatch(/api_keys[^;]*REFERENCES/i);
    expect(statements).not.toMatch(/audit_logs[^;]*REFERENCES/i);
  });

  it("does not index the large audit_logs table in this deploy", () => {
    expect(statements).not.toMatch(/CREATE INDEX[^;]*ON audit_logs/i);
  });

  it("enforces one account per email and one identity per provider account", () => {
    expect(statements).toContain("CREATE UNIQUE INDEX users_email_key ON users (email);");
    expect(statements).toContain("ON user_identities (provider, provider_user_id)");
    expect(statements).toContain("CREATE UNIQUE INDEX user_sessions_token_hash_key");
  });

  it("removes a user's identities, sessions and Cloud keys with the user", () => {
    const cascades = statements.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades).toHaveLength(3);
  });

  it("is mirrored by the Prisma models", () => {
    for (const model of ["User", "UserIdentity", "UserSession", "UserCloudKey"]) {
      expect(schema).toMatch(new RegExp(`model ${model} \\{`));
    }
    expect(schema).toContain('@@map("users")');
    expect(schema).toContain('@@map("user_cloud_keys")');
    expect(schema).toMatch(/userId\s+String\?\s+@map\("user_id"\)/);
  });
});
