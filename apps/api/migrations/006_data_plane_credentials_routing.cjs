exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS funding_preference TEXT NOT NULL DEFAULT 'auto',
      ADD CONSTRAINT accounts_funding_preference_check
        CHECK (funding_preference IN ('byok', 'included', 'auto'));

    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS inactivity_timeout_seconds INTEGER,
      ADD CONSTRAINT api_keys_inactivity_timeout_check
        CHECK (inactivity_timeout_seconds IS NULL OR inactivity_timeout_seconds > 0);
    CREATE INDEX IF NOT EXISTS idx_api_keys_active_lookup
      ON api_keys(key_hash) WHERE revoked = false;

    CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'operator')),
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('firecrawl_cloud', 'self_hosted_upstream')),
      encrypted_value TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      masked_prefix TEXT NOT NULL,
      masked_suffix TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'valid', 'invalid', 'revoked')),
      provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_validated_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT provider_credentials_owner_check CHECK (
        (owner_type = 'account' AND account_id IS NOT NULL) OR
        (owner_type = 'operator' AND account_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS provider_credentials_account_active_idx
      ON provider_credentials(account_id, purpose, created_at DESC)
      WHERE status != 'revoked' AND superseded_at IS NULL;

    CREATE TABLE IF NOT EXISTS infrastructure_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cloud', 'self_hosted')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'draining', 'paused', 'unhealthy')),
      priority INTEGER NOT NULL DEFAULT 100,
      base_url TEXT NOT NULL DEFAULT '',
      credential_id TEXT REFERENCES provider_credentials(id) ON DELETE SET NULL,
      capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
      monthly_budget_cents BIGINT,
      hard_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (hard_concurrency > 0),
      request_timeout_ms INTEGER NOT NULL DEFAULT 120000 CHECK (request_timeout_ms > 0),
      response_buffer_max_bytes INTEGER NOT NULL DEFAULT 5242880 CHECK (response_buffer_max_bytes > 0),
      health_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
      last_health_check_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT infrastructure_sources_cloud_url_check CHECK (
        (kind = 'cloud' AND base_url = '') OR (kind = 'self_hosted' AND base_url <> '')
      )
    );
    CREATE INDEX IF NOT EXISTS infrastructure_sources_routing_idx
      ON infrastructure_sources(status, priority, created_at);

    CREATE TABLE IF NOT EXISTS gateway_jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      public_job_id TEXT NOT NULL,
      upstream_job_id TEXT NOT NULL,
      route_family TEXT NOT NULL,
      -- Account BYOK sources are credential-derived virtual IDs, not operator
      -- infrastructure_sources rows, so lifecycle pinning cannot use an FK here.
      source_id TEXT,
      credential_id TEXT REFERENCES provider_credentials(id) ON DELETE RESTRICT,
      funding_type TEXT NOT NULL CHECK (funding_type IN ('byok', 'included')),
      creation_request JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (account_id, public_job_id)
    );
    CREATE INDEX IF NOT EXISTS gateway_jobs_account_lookup_idx
      ON gateway_jobs(account_id, public_job_id);

    ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS provider_credentials_tenant_isolation ON provider_credentials;
    CREATE POLICY provider_credentials_tenant_isolation ON provider_credentials
      USING (owner_type = 'account' AND account_id = current_setting('app.account_id', true))
      WITH CHECK (owner_type = 'account' AND account_id = current_setting('app.account_id', true));
    CREATE POLICY provider_credentials_operator_access ON provider_credentials
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE gateway_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE gateway_jobs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS gateway_jobs_tenant_isolation ON gateway_jobs;
    CREATE POLICY gateway_jobs_tenant_isolation ON gateway_jobs
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    CREATE POLICY gateway_jobs_operator_access ON gateway_jobs
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_runtime') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON provider_credentials, gateway_jobs TO firecrawl_gateway_runtime';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON provider_credentials, infrastructure_sources, gateway_jobs TO firecrawl_gateway_operator';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS gateway_jobs;
    DROP TABLE IF EXISTS infrastructure_sources;
    DROP TABLE IF EXISTS provider_credentials;
    DROP INDEX IF EXISTS idx_api_keys_active_lookup;
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_inactivity_timeout_check;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS inactivity_timeout_seconds;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;
    ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_funding_preference_check;
    ALTER TABLE accounts DROP COLUMN IF EXISTS funding_preference;
  `);
};
