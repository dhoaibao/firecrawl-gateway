import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this;
    }

    async connect() {
      return {
        query: state.query,
        release: state.release,
      };
    }
  },
}));

import {
  initDatabase,
  withAccountTransaction,
  withTransaction,
} from "./index";

describe("database transaction primitives", () => {
  beforeEach(() => {
    state.query.mockReset();
    state.release.mockReset();
    state.query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (sql.includes("FROM pgmigrations")) return { rows: [{ exists: true }] };
      if (sql.includes("pg_has_role")) {
        return {
          rows: [{
            is_runtime: sql.includes("firecrawl_gateway_runtime"),
            is_operator: !sql.includes("firecrawl_gateway_runtime"),
            rolsuper: false,
            rolbypassrls: false,
          }],
        };
      }
      if (sql.includes("firecrawl_gateway_operator")) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
  });

  it("checks schema readiness without applying DDL", async () => {
    await initDatabase("postgresql://example.test/gateway", "postgresql://example.test/operator");

    expect(state.query).toHaveBeenCalledWith("SELECT 1");
    expect(state.query).toHaveBeenCalledWith(
      "SELECT EXISTS (SELECT 1 FROM pgmigrations WHERE name = $1) AS exists",
      ["007_quota_capacity"],
    );
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE"))).toBe(false);
  });

  it("sets tenant context transaction-locally and releases the client on commit", async () => {
    await initDatabase("postgresql://example.test/gateway", "postgresql://example.test/operator");
    await withAccountTransaction("account-a", async (client) => {
      await client.query("SELECT 1");
    });

    expect(state.query).toHaveBeenCalledWith("BEGIN");
    expect(state.query).toHaveBeenCalledWith(
      "SELECT set_config('app.account_id', $1, true)",
      ["account-a"],
    );
    expect(state.query).toHaveBeenCalledWith("COMMIT");
    expect(state.release).toHaveBeenCalled();
  });

  it("switches to the database operator role only for operator transactions", async () => {
    await initDatabase("postgresql://example.test/gateway", "postgresql://example.test/operator");
    await withTransaction(async (client) => {
      await client.query("SELECT 1");
    }, { operator: true });

    expect(state.query).toHaveBeenCalledWith("SET LOCAL ROLE firecrawl_gateway_operator");
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes("operator_context"))).toBe(false);
  });

  it("rolls back and releases the client when a transaction fails", async () => {
    await initDatabase("postgresql://example.test/gateway", "postgresql://example.test/operator");
    await expect(withTransaction(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(state.query).toHaveBeenCalledWith("ROLLBACK");
    expect(state.release).toHaveBeenCalled();
  });
});
