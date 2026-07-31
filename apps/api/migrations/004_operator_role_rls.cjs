exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        BEGIN
          CREATE ROLE firecrawl_gateway_operator NOLOGIN NOSUPERUSER NOBYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE WARNING 'Could not create firecrawl_gateway_operator; create it with the deployment role';
        END;
      END IF;
    END $$;

    DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts;
    CREATE POLICY accounts_tenant_isolation ON accounts
      USING (
        id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      )
      WITH CHECK (
        id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      );

    DROP POLICY IF EXISTS account_memberships_tenant_isolation ON account_memberships;
    CREATE POLICY account_memberships_tenant_isolation ON account_memberships
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      );

    DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
    CREATE POLICY api_keys_tenant_isolation ON api_keys
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      );

    DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
    CREATE POLICY audit_logs_tenant_isolation ON audit_logs
      USING (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      )
      WITH CHECK (
        account_id = current_setting('app.account_id', true)
        OR current_user = 'firecrawl_gateway_operator'
      );

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO firecrawl_gateway_operator';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, account_memberships, api_keys, audit_logs TO firecrawl_gateway_operator';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON users, settings, sessions TO firecrawl_gateway_operator';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
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
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        EXECUTE 'REVOKE USAGE ON SCHEMA public FROM firecrawl_gateway_operator';
        EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON accounts, account_memberships, api_keys, audit_logs FROM firecrawl_gateway_operator';
        EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON users, settings, sessions FROM firecrawl_gateway_operator';
      END IF;
    END $$;
  `);
};
