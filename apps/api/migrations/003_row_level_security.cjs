exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_runtime') THEN
        BEGIN
          CREATE ROLE firecrawl_gateway_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE WARNING 'Could not create firecrawl_gateway_runtime; create it with the deployment role';
        END;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_migrator') THEN
        BEGIN
          CREATE ROLE firecrawl_gateway_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE WARNING 'Could not create firecrawl_gateway_migrator; create it with the deployment role';
        END;
      END IF;
    END $$;

    ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
    ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE account_memberships FORCE ROW LEVEL SECURITY;
    ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
    ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts;
    CREATE POLICY accounts_tenant_isolation ON accounts
      USING (
        id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      )
      WITH CHECK (
        id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      );

    DROP POLICY IF EXISTS account_memberships_tenant_isolation ON account_memberships;
    CREATE POLICY account_memberships_tenant_isolation ON account_memberships
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      );

    DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
    CREATE POLICY api_keys_tenant_isolation ON api_keys
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      );

    DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
    CREATE POLICY audit_logs_tenant_isolation ON audit_logs
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_setting('app.operator_context', true) = 'true'
      );

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_runtime') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO firecrawl_gateway_runtime';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, account_memberships, api_keys, audit_logs TO firecrawl_gateway_runtime';
        EXECUTE 'GRANT SELECT ON pgmigrations TO firecrawl_gateway_runtime';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON users, settings, sessions TO firecrawl_gateway_runtime';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
    ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE account_memberships DISABLE ROW LEVEL SECURITY;
    ALTER TABLE account_memberships NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
    ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
    DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
    DROP POLICY IF EXISTS account_memberships_tenant_isolation ON account_memberships;
    DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts;
  `);
};
