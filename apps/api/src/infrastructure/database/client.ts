import { Prisma, PrismaClient } from "@prisma/client";
import { rootLogger } from "../../logger";

const TRANSACTION_TIMEOUT_MS = 10_000;
const TRANSACTION_MAX_WAIT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 2_000;

export type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

export interface PrismaClients {
  runtime: PrismaClient;
  operator: PrismaClient;
}

let clients: PrismaClients | null = null;

const REQUIRED_TABLES = [
  "users",
  "accounts",
  "account_memberships",
  "api_keys",
  "audit_logs",
  "settings",
  "sessions",
  "auth_tokens",
  "mfa_factors",
  "mfa_recovery_codes",
  "auth_sessions",
  "security_events",
  "email_outbox",
  "email_delivery_events",
  "provider_credentials",
  "infrastructure_sources",
  "gateway_jobs",
  "free_tier_policy",
  "free_tier_enrollments",
  "quota_periods",
  "account_entitlements",
  "usage_reservations",
  "usage_events",
  "quota_events",
  "operator_notifications",
  "rate_limit_buckets",
] as const;

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

const REQUIRED_PARTIAL_INDEXES = [
  "account_personal_owner_unique",
  "idx_api_keys_active_lookup",
  "auth_tokens_one_active_per_purpose_idx",
  "provider_credentials_account_active_idx",
  "idx_free_tier_enrollments_waitlist",
  "idx_usage_reservations_pending",
] as const;

const RUNTIME_PRIVILEGES = [
  ...["users", "settings", "sessions", "accounts", "account_memberships", "api_keys", "audit_logs", "provider_credentials", "gateway_jobs"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
  ...["free_tier_policy", "free_tier_enrollments", "quota_periods", "account_entitlements", "usage_reservations", "usage_events", "quota_events"]
    .map((table) => [table, "SELECT"] as const),
  ...["rate_limit_buckets"].flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
] as const;

const OPERATOR_PRIVILEGES = [
  ...["users", "settings", "sessions", "accounts", "account_memberships", "api_keys", "audit_logs", "provider_credentials", "infrastructure_sources", "gateway_jobs"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
  ...["free_tier_policy", "free_tier_enrollments", "quota_periods", "account_entitlements", "usage_reservations", "quota_events"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE"].map((privilege) => [table, privilege] as const)),
  ["usage_events", "SELECT"],
  ["usage_events", "INSERT"],
  ...["auth_tokens", "mfa_factors", "mfa_recovery_codes", "auth_sessions", "security_events", "email_outbox", "email_delivery_events"]
    .flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => [table, privilege] as const)),
  ...["operator_notifications"].flatMap((table) => ["SELECT", "INSERT", "UPDATE"].map((privilege) => [table, privilege] as const)),
] as const;

function createClient(databaseUrl: string, name: string): PrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: process.env.NODE_ENV === "development"
      ? [{ emit: "event", level: "error" }]
      : [{ emit: "event", level: "error" }],
  });

  client.$on("error", (event) => {
    rootLogger.error({ database: name, message: event.message, target: event.target }, "Prisma client error");
  });

  return client;
}

export function initializePrisma(databaseUrl: string, operatorDatabaseUrl: string): PrismaClients {
  if (databaseUrl === operatorDatabaseUrl) {
    throw new Error("DATABASE_URL and OPERATOR_DATABASE_URL must use separate database credentials");
  }

  if (clients) return clients;

  clients = {
    runtime: createClient(databaseUrl, "runtime"),
    operator: createClient(operatorDatabaseUrl, "operator"),
  };
  return clients;
}

export function getPrisma(): PrismaClients {
  if (!clients) {
    throw new Error("Prisma clients are not initialized. Call initializePrisma first.");
  }
  return clients;
}

export async function disconnectPrisma(): Promise<void> {
  if (!clients) return;
  const current = clients;
  clients = null;
  await Promise.all([current.runtime.$disconnect(), current.operator.$disconnect()]);
}

export async function pingPrisma(): Promise<boolean> {
  try {
    const current = getPrisma();
    await Promise.all([
      current.runtime.$queryRaw`SELECT 1`,
      current.operator.$queryRaw`SELECT 1`,
    ]);
    return true;
  } catch (error) {
    rootLogger.warn({ err: error }, "Prisma database readiness check failed");
    return false;
  }
}

async function configureTransaction(
  tx: Prisma.TransactionClient,
  options: { accountId?: string; operator?: boolean },
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true)`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`;
  await tx.$executeRawUnsafe(
    options.operator
      ? "SET LOCAL ROLE firecrawl_gateway_operator"
      : "SET LOCAL ROLE firecrawl_gateway_runtime",
  );
  await tx.$executeRaw`SELECT set_config('app.account_id', ${options.accountId ?? ""}, true)`;
}

export async function withRuntimeTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return getPrisma().runtime.$transaction(async (tx) => {
    await configureTransaction(tx, {});
    return fn(tx);
  }, {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
}

export async function withAccountTransaction<T>(
  accountId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!accountId.trim()) throw new Error("Account context is required");
  return getPrisma().runtime.$transaction(async (tx) => {
    await configureTransaction(tx, { accountId });
    return fn(tx);
  }, {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
}

export async function withOperatorTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return getPrisma().operator.$transaction(async (tx) => {
    await configureTransaction(tx, { operator: true });
    return fn(tx);
  }, {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
}

export async function withUserAccountTransaction<T>(
  userId: string,
  fn: (accountId: string, tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const account = await withOperatorTransaction(async (tx) => {
    const membership = await tx.accountMembership.findFirst({
      where: { userId, role: "owner" },
      orderBy: { account: { createdAt: "asc" } },
      select: { accountId: true },
    });
    return membership?.accountId;
  });

  if (!account) throw new Error(`No personal account exists for user ${userId}`);
  return withAccountTransaction(account, (tx) => fn(account, tx));
}

function sqlTextValues(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`${value}`));
}

function sqlPairValues(values: readonly (readonly [string, string])[]): Prisma.Sql {
  return Prisma.join(values.map(([first, second]) => Prisma.sql`(${first}, ${second})`));
}

function sqlValueRows(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map((value) => Prisma.sql`(${value})`));
}

async function assertRequiredTables(client: PrismaExecutor, label: string): Promise<void> {
  const rows = await client.$queryRaw<Array<{ table_name: string; relation_name: string | null }>>(Prisma.sql`
    SELECT required.table_name,
           to_regclass('public.' || required.table_name)::text AS relation_name
    FROM unnest(ARRAY[${sqlTextValues(REQUIRED_TABLES)}]::text[]) AS required(table_name)
  `);
  const missing = rows.filter((row) => !row.relation_name).map((row) => row.table_name);
  if (missing.length > 0 || rows.length !== REQUIRED_TABLES.length) {
    const present = new Set(rows.map((row) => row.table_name));
    for (const table of REQUIRED_TABLES) {
      if (!present.has(table)) missing.push(table);
    }
    throw new Error(`Database ${label} schema is incomplete; missing tables: ${[...new Set(missing)].join(", ")}`);
  }
}

async function assertSecurityObjects(client: PrismaExecutor): Promise<void> {
  const rlsRows = await client.$queryRaw<Array<{
    table_name: string;
    row_security: boolean;
    force_row_security: boolean;
  }>>(Prisma.sql`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS row_security,
           c.relforcerowsecurity AS force_row_security
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (${sqlTextValues(RLS_TABLES)})
  `);
  const rlsByName = new Map(rlsRows.map((row) => [row.table_name, row]));
  const missingRls = RLS_TABLES.filter((table) => {
    const row = rlsByName.get(table);
    return !row?.row_security || !row.force_row_security;
  });
  if (missingRls.length > 0) {
    throw new Error(`Database security setup is incomplete; forced RLS is missing on: ${missingRls.join(", ")}`);
  }

  const policyRows = await client.$queryRaw<Array<{
    table_name: string;
    policy_name: string;
    present: boolean;
  }>>(Prisma.sql`
    SELECT required.table_name,
           required.policy_name,
           p.policyname IS NOT NULL AS present
    FROM (VALUES ${sqlPairValues(REQUIRED_POLICIES)}) AS required(table_name, policy_name)
    LEFT JOIN pg_policies p
      ON p.schemaname = 'public'
     AND p.tablename = required.table_name
     AND p.policyname = required.policy_name
  `);
  const missingPolicies = policyRows
    .filter((row) => !row.present)
    .map((row) => `${row.table_name}.${row.policy_name}`);
  if (missingPolicies.length > 0 || policyRows.length !== REQUIRED_POLICIES.length) {
    throw new Error(`Database security setup is incomplete; missing RLS policies: ${missingPolicies.join(", ")}`);
  }

  const indexRows = await client.$queryRaw<Array<{ index_name: string; index_definition: string | null }>>(Prisma.sql`
    SELECT required.index_name,
           i.indexdef AS index_definition
    FROM (VALUES ${sqlValueRows(REQUIRED_PARTIAL_INDEXES)}) AS required(index_name)
    LEFT JOIN pg_indexes i
      ON i.schemaname = 'public'
     AND i.indexname = required.index_name
  `);
  const missingIndexes = indexRows
    .filter((row) => !row.index_definition || !/\bwhere\b/i.test(row.index_definition))
    .map((row) => row.index_name);
  if (missingIndexes.length > 0 || indexRows.length !== REQUIRED_PARTIAL_INDEXES.length) {
    throw new Error(`Database security setup is incomplete; missing partial indexes: ${missingIndexes.join(", ")}`);
  }
}

async function assertTablePrivileges(
  client: PrismaExecutor,
  requirements: readonly (readonly [string, string])[],
  label: string,
): Promise<void> {
  const rows = await client.$queryRaw<Array<{
    table_name: string;
    privilege: string;
    allowed: boolean;
  }>>(Prisma.sql`
    SELECT required.table_name,
           required.privilege,
           has_table_privilege(current_user, 'public.' || required.table_name, required.privilege) AS allowed
    FROM (VALUES ${sqlPairValues(requirements)}) AS required(table_name, privilege)
  `);
  const missing = rows
    .filter((row) => !row.allowed)
    .map((row) => `${row.table_name}:${row.privilege}`);
  if (missing.length > 0 || rows.length !== requirements.length) {
    throw new Error(`Database ${label} grants are incomplete: ${missing.join(", ")}`);
  }
}

export async function assertPrismaReady(): Promise<void> {
  const current = getPrisma();
  await Promise.all([
    assertRequiredTables(current.runtime, "runtime"),
    assertRequiredTables(current.operator, "operator"),
    assertSecurityObjects(current.operator),
  ]);
}

export async function assertRuntimeRoleReady(): Promise<void> {
  const current = getPrisma().runtime;
  const result = await current.$queryRaw<Array<{
    is_runtime: boolean;
    is_operator: boolean;
    login_superuser: boolean;
    login_bypass_rls: boolean;
    runtime_superuser: boolean;
    runtime_bypass_rls: boolean;
  }>>(Prisma.sql`
    SELECT pg_has_role(current_user, 'firecrawl_gateway_runtime', 'member') AS is_runtime,
           pg_has_role(current_user, 'firecrawl_gateway_operator', 'member') AS is_operator,
           login.rolsuper AS login_superuser,
           login.rolbypassrls AS login_bypass_rls,
           runtime.rolsuper AS runtime_superuser,
           runtime.rolbypassrls AS runtime_bypass_rls
    FROM pg_roles login
    INNER JOIN pg_roles runtime ON runtime.rolname = 'firecrawl_gateway_runtime'
    WHERE login.rolname = current_user
  `);
  const role = result[0];
  if (
    !role?.is_runtime ||
    role.is_operator ||
    role.login_superuser ||
    role.login_bypass_rls ||
    role.runtime_superuser ||
    role.runtime_bypass_rls
  ) {
    throw new Error(
      "Database runtime role must be a non-superuser member of firecrawl_gateway_runtime and not firecrawl_gateway_operator without BYPASSRLS.",
    );
  }
  await current.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE firecrawl_gateway_runtime");
    await assertTablePrivileges(tx, RUNTIME_PRIVILEGES, "runtime");
    const assumed = await tx.$queryRaw<Array<{ current_user: string }>>(Prisma.sql`SELECT current_user`);
    if (assumed[0]?.current_user !== "firecrawl_gateway_runtime") {
      throw new Error("Database runtime credential cannot assume firecrawl_gateway_runtime with required privileges.");
    }
  });
}

export async function assertOperatorRoleReady(): Promise<void> {
  const current = getPrisma().operator;
  const result = await current.$queryRaw<Array<{
    is_operator: boolean;
    login_superuser: boolean;
    login_bypass_rls: boolean;
    operator_superuser: boolean;
    operator_bypass_rls: boolean;
  }>>(Prisma.sql`
    SELECT pg_has_role(current_user, 'firecrawl_gateway_operator', 'member') AS is_operator,
           login.rolsuper AS login_superuser,
           login.rolbypassrls AS login_bypass_rls,
           operator.rolsuper AS operator_superuser,
           operator.rolbypassrls AS operator_bypass_rls
    FROM pg_roles login
    INNER JOIN pg_roles operator ON operator.rolname = 'firecrawl_gateway_operator'
    WHERE login.rolname = current_user
  `);
  const role = result[0];
  if (
    !role?.is_operator ||
    role.login_superuser ||
    role.login_bypass_rls ||
    role.operator_superuser ||
    role.operator_bypass_rls
  ) {
    throw new Error(
      "Database operator role must be a non-superuser member of firecrawl_gateway_operator without BYPASSRLS.",
    );
  }
  await current.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE firecrawl_gateway_operator");
    await assertTablePrivileges(tx, OPERATOR_PRIVILEGES, "operator");
    const assumed = await tx.$queryRaw<Array<{ current_user: string; can_select_users: boolean }>>(Prisma.sql`
      SELECT current_user,
             has_table_privilege(current_user, 'public.users', 'SELECT') AS can_select_users
    `);
    if (assumed[0]?.current_user !== "firecrawl_gateway_operator" || !assumed[0]?.can_select_users) {
      throw new Error("Database operator credential cannot assume firecrawl_gateway_operator with required privileges.");
    }
  });
}
