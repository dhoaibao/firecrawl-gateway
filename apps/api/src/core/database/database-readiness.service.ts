import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { TransactionService } from "./transaction.service";

const RLS_TABLES = [
  "accounts",
  "account_memberships",
  "api_keys",
  "audit_logs",
  "provider_credentials",
  "gateway_jobs",
  "free_tier_enrollments",
  "account_entitlements",
  "usage_reservations",
  "usage_events",
  "quota_events",
  "free_tier_policy",
  "quota_periods",
  "operator_notifications",
] as const;

const REQUIRED_POLICIES = [
  ["accounts", "accounts_tenant_isolation"],
  ["account_memberships", "account_memberships_tenant_isolation"],
  ["api_keys", "api_keys_tenant_isolation"],
  ["audit_logs", "audit_logs_tenant_isolation"],
  ["provider_credentials", "provider_credentials_tenant_isolation"],
  ["gateway_jobs", "gateway_jobs_tenant_isolation"],
  ["free_tier_enrollments", "free_tier_enrollments_tenant_isolation"],
  ["account_entitlements", "account_entitlements_tenant_isolation"],
  ["usage_reservations", "usage_reservations_tenant_isolation"],
  ["usage_events", "usage_events_tenant_isolation"],
  ["quota_events", "quota_events_tenant_isolation"],
  ["free_tier_policy", "free_tier_policy_runtime_read"],
  ["free_tier_policy", "free_tier_policy_operator_access"],
  ["quota_periods", "quota_periods_runtime_read"],
  ["quota_periods", "quota_periods_operator_access"],
  ["operator_notifications", "operator_notifications_operator_access"],
] as const;

const RUNTIME_PRIVILEGES = [
  ...["users", "settings", "sessions", "accounts", "account_memberships", "api_keys", "audit_logs", "provider_credentials", "gateway_jobs", "rate_limit_buckets"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
  ...["free_tier_policy", "free_tier_enrollments", "quota_periods", "account_entitlements", "usage_reservations", "usage_events", "quota_events"]
    .map((table) => [table, "SELECT"] as const),
] as const;

const OPERATOR_PRIVILEGES = [
  ...["users", "settings", "sessions", "accounts", "account_memberships", "api_keys", "audit_logs", "provider_credentials", "infrastructure_sources", "gateway_jobs"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
  ...["free_tier_policy", "free_tier_enrollments", "quota_periods", "account_entitlements", "usage_reservations", "quota_events", "operator_notifications"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE"].map((privilege) => [table, privilege] as const)),
  ["usage_events", "SELECT"],
  ["usage_events", "INSERT"],
  ...["auth_tokens", "mfa_factors", "mfa_recovery_codes", "auth_sessions", "security_events", "email_outbox", "email_delivery_events"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
] as const;

type Privilege = readonly [table: string, privilege: string];

function values(rows: readonly Privilege[]): Prisma.Sql {
  return Prisma.join(rows.map(([table, privilege]) => Prisma.sql`(${table}, ${privilege})`));
}

@Injectable()
export class DatabaseReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  async assertReady(): Promise<void> {
    await this.assertRuntimeLoginAndRolePosture();
    await this.assertOperatorLoginAndRolePosture();
    await this.assertSecurityObjects();
    await this.transactions.run((transaction) => this.assertRolePrivileges(
      transaction,
      "firecrawl_gateway_runtime",
      RUNTIME_PRIVILEGES,
    ));
    await this.transactions.runAsOperator((transaction) => this.assertRolePrivileges(
      transaction,
      "firecrawl_gateway_operator",
      OPERATOR_PRIVILEGES,
    ));
  }

  private async assertRuntimeLoginAndRolePosture(): Promise<void> {
    const rows = await this.prisma.runtime.$queryRaw<Array<{
      login_superuser: boolean;
      login_bypass_rls: boolean;
      login_inherits: boolean;
      login_create_role: boolean;
      login_create_database: boolean;
      login_replication: boolean;
      has_runtime: boolean;
      has_operator: boolean;
      runtime_superuser: boolean;
      runtime_bypass_rls: boolean;
      runtime_login: boolean;
      operator_superuser: boolean;
      operator_bypass_rls: boolean;
      operator_login: boolean;
    }>>(Prisma.sql`
      SELECT login.rolsuper AS login_superuser,
             login.rolbypassrls AS login_bypass_rls,
             login.rolinherit AS login_inherits,
             login.rolcreaterole AS login_create_role,
             login.rolcreatedb AS login_create_database,
             login.rolreplication AS login_replication,
             pg_has_role(login.rolname, 'firecrawl_gateway_runtime', 'member') AS has_runtime,
             pg_has_role(login.rolname, 'firecrawl_gateway_operator', 'member') AS has_operator,
             runtime.rolsuper AS runtime_superuser,
             runtime.rolbypassrls AS runtime_bypass_rls,
             runtime.rolcanlogin AS runtime_login,
             operator.rolsuper AS operator_superuser,
             operator.rolbypassrls AS operator_bypass_rls,
             operator.rolcanlogin AS operator_login
      FROM pg_roles login
      INNER JOIN pg_roles runtime ON runtime.rolname = 'firecrawl_gateway_runtime'
      INNER JOIN pg_roles operator ON operator.rolname = 'firecrawl_gateway_operator'
      WHERE login.rolname = session_user
    `);
    const role = rows[0];
    if (
      !role ||
      role.login_superuser ||
      role.login_bypass_rls ||
      role.login_inherits ||
      role.login_create_role ||
      role.login_create_database ||
      role.login_replication ||
      !role.has_runtime ||
      role.has_operator ||
      role.runtime_superuser ||
      role.runtime_bypass_rls ||
      role.runtime_login ||
      role.operator_superuser ||
      role.operator_bypass_rls ||
      role.operator_login
    ) {
      throw new Error("Database runtime login and bounded role do not satisfy the separate-credential security requirements");
    }
  }

  private async assertOperatorLoginAndRolePosture(): Promise<void> {
    const rows = await this.prisma.operator.$queryRaw<Array<{
      login_superuser: boolean;
      login_bypass_rls: boolean;
      login_inherits: boolean;
      login_create_role: boolean;
      login_create_database: boolean;
      login_replication: boolean;
      has_operator: boolean;
      operator_superuser: boolean;
      operator_bypassrls: boolean;
      operator_login: boolean;
    }>>(Prisma.sql`
      SELECT login.rolsuper AS login_superuser,
             login.rolbypassrls AS login_bypass_rls,
             login.rolinherit AS login_inherits,
             login.rolcreaterole AS login_create_role,
             login.rolcreatedb AS login_create_database,
             login.rolreplication AS login_replication,
             pg_has_role(login.rolname, 'firecrawl_gateway_operator', 'member') AS has_operator,
             operator.rolsuper AS operator_superuser,
             operator.rolbypassrls AS operator_bypassrls,
             operator.rolcanlogin AS operator_login
      FROM pg_roles login
      INNER JOIN pg_roles operator ON operator.rolname = 'firecrawl_gateway_operator'
      WHERE login.rolname = session_user
    `);
    const role = rows[0];
    if (!role || role.login_superuser || role.login_bypass_rls || role.login_inherits || role.login_create_role || role.login_create_database || role.login_replication || !role.has_operator || role.operator_superuser || role.operator_bypassrls || role.operator_login) {
      throw new Error("Database operator login and bounded role do not satisfy the separate-credential security requirements");
    }
  }

  private async assertSecurityObjects(): Promise<void> {
    const rlsTables = Prisma.join(RLS_TABLES.map((table) => Prisma.sql`${table}`));
    const policies = Prisma.join(REQUIRED_POLICIES.map(([table, policy]) => Prisma.sql`(${table}, ${policy})`));
    const rows = await this.prisma.operator.$queryRaw<Array<{ rls_ready: boolean; policies_ready: boolean }>>(Prisma.sql`
      SELECT (
        SELECT COUNT(*) = ${RLS_TABLES.length}
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN (${rlsTables})
          AND c.relrowsecurity
          AND c.relforcerowsecurity
      ) AS rls_ready,
      (
        SELECT COUNT(*) = ${REQUIRED_POLICIES.length}
        FROM (VALUES ${policies}) AS required(table_name, policy_name)
        INNER JOIN pg_policies p
          ON p.schemaname = 'public'
         AND p.tablename = required.table_name
         AND p.policyname = required.policy_name
      ) AS policies_ready
    `);
    if (!rows[0]?.rls_ready || !rows[0]?.policies_ready) {
      throw new Error("Database RLS policies are incomplete");
    }
  }

  private async assertRolePrivileges(
    transaction: Prisma.TransactionClient,
    expectedRole: string,
    requirements: readonly Privilege[],
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{
      current_role: string;
      table_name: string;
      privilege: string;
      allowed: boolean;
    }>>(Prisma.sql`
      SELECT current_user AS current_role,
             required.table_name,
             required.privilege,
             has_table_privilege(current_user, 'public.' || required.table_name, required.privilege) AS allowed
      FROM (VALUES ${values(requirements)}) AS required(table_name, privilege)
    `);
    if (
      rows.length !== requirements.length ||
      rows.some((row) => row.current_role !== expectedRole || !row.allowed)
    ) {
      throw new Error(`Database ${expectedRole} grants are incomplete`);
    }
  }
}
