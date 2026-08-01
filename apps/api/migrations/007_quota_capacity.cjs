exports.shorthands = undefined;

// Phase 5: recurring free-tier quota, capacity control, and usage accounting.
// All application DDL stays here; API startup never applies schema changes.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS free_tier_policy (
      id TEXT PRIMARY KEY DEFAULT 'default',
      -- Grant applied to newly admitted accounts.
      default_grant INTEGER NOT NULL DEFAULT 100 CHECK (default_grant > 0),
      -- Permanent commitments may never exceed this ceiling; operators cannot
      -- lower it below committed_amount without an explicit override flow.
      commitment_ceiling INTEGER NOT NULL DEFAULT 1000 CHECK (commitment_ceiling >= 0),
      -- Hard monthly platform consumption ceiling applied to every open period.
      hard_monthly_cap BIGINT NOT NULL DEFAULT 10000 CHECK (hard_monthly_cap >= 0),
      committed_amount INTEGER NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
      admissions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      -- Global pause for included (operator-funded) traffic; BYOK keeps working.
      included_traffic_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      -- e.g. {"commitment_pct": [80, 90], "slots_remaining": [10, 5], "consumption_pct": [80, 95]}
      warning_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- Scheduled next-period changes: [{period_id, default_grant, commitment_ceiling,
      -- hard_monthly_cap, applied_at}] consumed when that period is opened.
      next_period_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Append-only operator audit: [{at, actor, reason, before, after}].
      policy_change_log JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO free_tier_policy (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS free_tier_enrollments (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'waitlisted'
        CHECK (status IN ('waitlisted', 'enrolled', 'revoked')),
      grant_amount INTEGER NOT NULL DEFAULT 100 CHECK (grant_amount > 0),
      admitted_at TIMESTAMPTZ,
      waitlisted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      -- Operator-set skip/admit/revoke reason, plus the acting operator.
      operator_reason TEXT,
      operator_actor TEXT,
      skipped_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_free_tier_enrollments_waitlist
      ON free_tier_enrollments(waitlisted_at, account_id)
      WHERE status = 'waitlisted';

    CREATE TABLE IF NOT EXISTS quota_periods (
      id TEXT PRIMARY KEY,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      hard_cap BIGINT NOT NULL DEFAULT 0 CHECK (hard_cap >= 0),
      reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      consumed BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'paused', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (period_start)
    );

    CREATE TABLE IF NOT EXISTS account_entitlements (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_id TEXT NOT NULL REFERENCES quota_periods(id) ON DELETE CASCADE,
      allocated INTEGER NOT NULL DEFAULT 100 CHECK (allocated >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'revoked', 'closed')),
      -- Snapshot of the enrollment (grant, status) at issuance time.
      enrollment_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, period_id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_entitlements_period
      ON account_entitlements(period_id, status);

    -- Reservation lifecycle keyed by gateway request id (idempotency).
    -- reserved -> consumed (operator dispatch happened) or released (no dispatch).
    CREATE TABLE IF NOT EXISTS usage_reservations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_id TEXT NOT NULL REFERENCES quota_periods(id),
      entitlement_id TEXT NOT NULL REFERENCES account_entitlements(id),
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'consumed', 'released')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_reservations_pending
      ON usage_reservations(expires_at) WHERE status = 'reserved';

    -- Immutable accounting ledger. No UPDATE/DELETE grants; adjustments are new rows.
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_id TEXT REFERENCES quota_periods(id),
      kind TEXT NOT NULL CHECK (kind IN ('charge', 'adjustment')),
      amount INTEGER NOT NULL CHECK (amount <> 0),
      actor TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_period
      ON usage_events(account_id, period_id, created_at);

    -- Deduplicated threshold/exhaustion notifications consumed by Phase 7.
    CREATE TABLE IF NOT EXISTS quota_events (
      id TEXT PRIMARY KEY,
      dedup_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'commitment_threshold', 'slots_remaining', 'consumption_threshold',
        'hard_cap_reached', 'projected_exhaustion', 'waitlist_growth', 'source_pressure'
      )),
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      period_id TEXT REFERENCES quota_periods(id),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_quota_events_account
      ON quota_events(account_id, created_at);

    ALTER TABLE free_tier_enrollments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE free_tier_enrollments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS free_tier_enrollments_tenant_isolation ON free_tier_enrollments;
    CREATE POLICY free_tier_enrollments_tenant_isolation ON free_tier_enrollments
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    DROP POLICY IF EXISTS free_tier_enrollments_operator_access ON free_tier_enrollments;
    CREATE POLICY free_tier_enrollments_operator_access ON free_tier_enrollments
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE account_entitlements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE account_entitlements FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS account_entitlements_tenant_isolation ON account_entitlements;
    CREATE POLICY account_entitlements_tenant_isolation ON account_entitlements
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    DROP POLICY IF EXISTS account_entitlements_operator_access ON account_entitlements;
    CREATE POLICY account_entitlements_operator_access ON account_entitlements
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS usage_reservations_tenant_isolation ON usage_reservations;
    CREATE POLICY usage_reservations_tenant_isolation ON usage_reservations
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    DROP POLICY IF EXISTS usage_reservations_operator_access ON usage_reservations;
    CREATE POLICY usage_reservations_operator_access ON usage_reservations
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS usage_events_tenant_isolation ON usage_events;
    CREATE POLICY usage_events_tenant_isolation ON usage_events
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    DROP POLICY IF EXISTS usage_events_operator_access ON usage_events;
    CREATE POLICY usage_events_operator_access ON usage_events
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE quota_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE quota_events FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS quota_events_tenant_isolation ON quota_events;
    CREATE POLICY quota_events_tenant_isolation ON quota_events
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
    DROP POLICY IF EXISTS quota_events_operator_access ON quota_events;
    CREATE POLICY quota_events_operator_access ON quota_events
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    -- The singleton policy row and period counters are platform-wide state.
    -- Tenants only need read access to their period; writes stay operator-only.
    ALTER TABLE free_tier_policy ENABLE ROW LEVEL SECURITY;
    ALTER TABLE free_tier_policy FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS free_tier_policy_runtime_read ON free_tier_policy;
    CREATE POLICY free_tier_policy_runtime_read ON free_tier_policy
      FOR SELECT USING (current_user = 'firecrawl_gateway_runtime');
    DROP POLICY IF EXISTS free_tier_policy_operator_access ON free_tier_policy;
    CREATE POLICY free_tier_policy_operator_access ON free_tier_policy
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    ALTER TABLE quota_periods ENABLE ROW LEVEL SECURITY;
    ALTER TABLE quota_periods FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS quota_periods_runtime_read ON quota_periods;
    CREATE POLICY quota_periods_runtime_read ON quota_periods
      FOR SELECT USING (current_user = 'firecrawl_gateway_runtime');
    DROP POLICY IF EXISTS quota_periods_operator_access ON quota_periods;
    CREATE POLICY quota_periods_operator_access ON quota_periods
      USING (current_user = 'firecrawl_gateway_operator')
      WITH CHECK (current_user = 'firecrawl_gateway_operator');

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_runtime') THEN
        EXECUTE 'GRANT SELECT ON free_tier_policy, free_tier_enrollments, quota_periods,
          account_entitlements, usage_reservations, usage_events, quota_events
          TO firecrawl_gateway_runtime';
        EXECUTE 'GRANT UPDATE (status) ON account_entitlements TO firecrawl_gateway_runtime';
        EXECUTE 'GRANT UPDATE (status, expires_at) ON usage_reservations TO firecrawl_gateway_runtime';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON free_tier_policy, free_tier_enrollments,
          quota_periods, account_entitlements, usage_reservations, quota_events
          TO firecrawl_gateway_operator';
        -- usage_events is append-only: never DELETE, never UPDATE.
        EXECUTE 'GRANT SELECT, INSERT ON usage_events TO firecrawl_gateway_operator';
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS quota_events;
    DROP TABLE IF EXISTS usage_events;
    DROP TABLE IF EXISTS usage_reservations;
    DROP TABLE IF EXISTS account_entitlements;
    DROP TABLE IF EXISTS quota_periods;
    DROP TABLE IF EXISTS free_tier_enrollments;
    DROP TABLE IF EXISTS free_tier_policy;
  `);
};
