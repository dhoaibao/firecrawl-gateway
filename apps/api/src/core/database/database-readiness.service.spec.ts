import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "./prisma.service";
import type { TransactionService } from "./transaction.service";
import { DatabaseReadinessService } from "./database-readiness.service";

const validPosture = {
  login_superuser: false,
  login_bypass_rls: false,
  login_inherits: false,
  login_create_role: false,
  login_create_database: false,
  login_replication: false,
  has_runtime: true,
  has_operator: false,
  runtime_superuser: false,
  runtime_bypass_rls: false,
  runtime_login: false,
  operator_superuser: false,
  operator_bypassrls: false,
  operator_login: false,
};

const validOperatorPosture = {
  login_superuser: false,
  login_bypass_rls: false,
  login_inherits: false,
  login_create_role: false,
  login_create_database: false,
  login_replication: false,
  has_operator: true,
  operator_superuser: false,
  operator_bypassrls: false,
  operator_login: false,
};

function privilegeRows(sql: Prisma.Sql, role: string, allow = true) {
  const parameters = sql.values;
  const rows = [];
  for (let index = 0; index < parameters.length; index += 2) {
    rows.push({ current_role: role, table_name: String(parameters[index]), privilege: String(parameters[index + 1]), allowed: allow });
  }
  return rows;
}

function createService(options: { posture?: typeof validPosture; operatorPosture?: typeof validOperatorPosture; securityReady?: boolean; operatorPrivileges?: boolean } = {}) {
  const runtimePrisma = {
    $queryRaw: vi.fn().mockResolvedValue(options.posture ? [{ ...validPosture, ...options.posture }] : [{ ...validPosture }]),
  };
  const operatorPrisma = {
    $queryRaw: vi.fn(),
  };
  const prisma = { runtime: runtimePrisma, operator: operatorPrisma } as unknown as PrismaService;
  const runtime = { $queryRaw: vi.fn((sql: Prisma.Sql) => Promise.resolve(privilegeRows(sql, "firecrawl_gateway_runtime"))) } as unknown as Prisma.TransactionClient;
  const operator = { $queryRaw: vi.fn((sql: Prisma.Sql) => Promise.resolve(privilegeRows(sql, "firecrawl_gateway_operator", options.operatorPrivileges ?? true))) } as unknown as Prisma.TransactionClient;
  const transactions = {
    run: vi.fn((operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(runtime)),
    runAsOperator: vi.fn((operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(operator)),
  } as unknown as TransactionService;
  operatorPrisma.$queryRaw
    .mockResolvedValueOnce(options.operatorPosture ? [{ ...validOperatorPosture, ...options.operatorPosture }] : [{ ...validOperatorPosture }])
    .mockResolvedValueOnce([{
      rls_ready: options.securityReady ?? true,
      policies_ready: options.securityReady ?? true,
    }]);
  return { service: new DatabaseReadinessService(prisma, transactions), transactions };
}

describe("DatabaseReadinessService", () => {
  it("accepts separate NOINHERIT runtime and operator credentials", async () => {
    const { service, transactions } = createService();
    await expect(service.assertReady()).resolves.toBeUndefined();
    expect(transactions.run).toHaveBeenCalledOnce();
    expect(transactions.runAsOperator).toHaveBeenCalledOnce();
  });

  it("rejects a privileged or inheriting runtime login", async () => {
    const { service, transactions } = createService({ posture: { ...validPosture, login_superuser: true, login_inherits: true } });
    await expect(service.assertReady()).rejects.toThrow("runtime login");
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it("rejects missing RLS security objects or bounded-role grants", async () => {
    await expect(createService({ securityReady: false }).service.assertReady()).rejects.toThrow("RLS policies are incomplete");
    await expect(createService({ operatorPrivileges: false }).service.assertReady()).rejects.toThrow("firecrawl_gateway_operator grants are incomplete");
  });
});
