-- PostgreSQL security and invariants that Prisma schema modeling does not express.
-- Run this after `prisma db push` with the deployment/owner credential.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_runtime') THEN
    CREATE ROLE firecrawl_gateway_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
    CREATE ROLE firecrawl_gateway_operator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_account_public_id_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'accounts.public_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_public_id_immutable ON accounts;
CREATE TRIGGER accounts_public_id_immutable
  BEFORE UPDATE OF public_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_account_public_id_change();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_platform_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_platform_role_check
      CHECK (platform_role IN ('user', 'admin', 'support', 'operator'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_status_check
      CHECK (status IN ('active', 'suspended', 'blocked', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_status_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
      CHECK (status IN ('active', 'suspended', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_funding_preference_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_funding_preference_check
      CHECK (funding_preference IN ('byok', 'included', 'auto'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_memberships_role_check') THEN
    ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_role_check
      CHECK (role IN ('owner', 'member'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_inactivity_timeout_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_inactivity_timeout_check
      CHECK (inactivity_timeout_seconds IS NULL OR inactivity_timeout_seconds > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_tokens_purpose_check') THEN
    ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check
      CHECK (purpose IN ('email_verification', 'password_reset', 'email_change'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_status_check') THEN
    ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check
      CHECK (status IN ('pending', 'processing', 'sent', 'dead'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_owner_check') THEN
    ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_owner_check
      CHECK (
        (owner_type = 'account' AND account_id IS NOT NULL) OR
        (owner_type = 'operator' AND account_id IS NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_owner_type_check') THEN
    ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_owner_type_check
      CHECK (owner_type IN ('account', 'operator'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_purpose_check') THEN
    ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_purpose_check
      CHECK (purpose IN ('firecrawl_cloud', 'self_hosted_upstream'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_status_check') THEN
    ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_status_check
      CHECK (status IN ('pending', 'valid', 'invalid', 'revoked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_kind_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_kind_check
      CHECK (kind IN ('cloud', 'self_hosted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_status_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_status_check
      CHECK (status IN ('active', 'draining', 'paused', 'unhealthy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_health_status_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_health_status_check
      CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_concurrency_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_concurrency_check
      CHECK (hard_concurrency > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_timeout_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_timeout_check
      CHECK (request_timeout_ms > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_buffer_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_buffer_check
      CHECK (response_buffer_max_bytes > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'infrastructure_sources_url_check') THEN
    ALTER TABLE infrastructure_sources ADD CONSTRAINT infrastructure_sources_url_check
      CHECK ((kind = 'cloud' AND base_url = '') OR (kind = 'self_hosted' AND base_url <> ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gateway_jobs_funding_type_check') THEN
    ALTER TABLE gateway_jobs ADD CONSTRAINT gateway_jobs_funding_type_check
      CHECK (funding_type IN ('byok', 'included'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_periods_status_check') THEN
    ALTER TABLE quota_periods ADD CONSTRAINT quota_periods_status_check
      CHECK (status IN ('open', 'paused', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_entitlements_status_check') THEN
    ALTER TABLE account_entitlements ADD CONSTRAINT account_entitlements_status_check
      CHECK (status IN ('active', 'suspended', 'revoked', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_reservations_status_check') THEN
    ALTER TABLE usage_reservations ADD CONSTRAINT usage_reservations_status_check
      CHECK (status IN ('reserved', 'consumed', 'released'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_kind_check') THEN
    ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check
      CHECK (kind IN ('charge', 'adjustment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_amount_check') THEN
    ALTER TABLE usage_events ADD CONSTRAINT usage_events_amount_check
      CHECK (amount <> 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_events_type_check') THEN
    ALTER TABLE quota_events ADD CONSTRAINT quota_events_type_check
      CHECK (event_type IN (
        'commitment_threshold', 'slots_remaining', 'consumption_threshold',
        'hard_cap_reached', 'projected_exhaustion', 'waitlist_growth', 'source_pressure'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_events_severity_check') THEN
    ALTER TABLE quota_events ADD CONSTRAINT quota_events_severity_check
      CHECK (severity IN ('info', 'warn', 'critical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_tier_enrollments_status_check') THEN
    ALTER TABLE free_tier_enrollments ADD CONSTRAINT free_tier_enrollments_status_check
      CHECK (status IN ('waitlisted', 'enrolled', 'revoked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_tier_policy_grant_check') THEN
    ALTER TABLE free_tier_policy ADD CONSTRAINT free_tier_policy_grant_check
      CHECK (default_grant > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_tier_policy_ceiling_check') THEN
    ALTER TABLE free_tier_policy ADD CONSTRAINT free_tier_policy_ceiling_check
      CHECK (commitment_ceiling >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_tier_policy_cap_check') THEN
    ALTER TABLE free_tier_policy ADD CONSTRAINT free_tier_policy_cap_check
      CHECK (hard_monthly_cap >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'free_tier_policy_commitment_check') THEN
    ALTER TABLE free_tier_policy ADD CONSTRAINT free_tier_policy_commitment_check
      CHECK (committed_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_entitlements_allocated_check') THEN
    ALTER TABLE account_entitlements ADD CONSTRAINT account_entitlements_allocated_check
      CHECK (allocated >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_entitlements_reserved_check') THEN
    ALTER TABLE account_entitlements ADD CONSTRAINT account_entitlements_reserved_check
      CHECK (reserved >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_entitlements_consumed_check') THEN
    ALTER TABLE account_entitlements ADD CONSTRAINT account_entitlements_consumed_check
      CHECK (consumed >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_periods_hard_cap_check') THEN
    ALTER TABLE quota_periods ADD CONSTRAINT quota_periods_hard_cap_check
      CHECK (hard_cap >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_periods_reserved_check') THEN
    ALTER TABLE quota_periods ADD CONSTRAINT quota_periods_reserved_check
      CHECK (reserved >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_periods_consumed_check') THEN
    ALTER TABLE quota_periods ADD CONSTRAINT quota_periods_consumed_check
      CHECK (consumed >= 0);
  END IF;
END $$;

INSERT INTO free_tier_policy (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS account_personal_owner_unique
  ON account_memberships(user_id)
  WHERE role = 'owner' AND account_id LIKE 'personal:%';
CREATE INDEX IF NOT EXISTS idx_api_keys_active_lookup
  ON api_keys(key_hash) WHERE revoked = false;
CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_one_active_per_purpose_idx
  ON auth_tokens(user_id, purpose) WHERE consumed_at IS NULL;

-- These names were previously used by non-partial Prisma indexes. Replace
-- those indexes explicitly so the security predicates cannot be skipped by
-- CREATE INDEX IF NOT EXISTS.
DROP INDEX IF EXISTS provider_credentials_account_active_idx;
CREATE INDEX provider_credentials_account_active_idx
  ON provider_credentials(account_id, purpose, created_at DESC)
  WHERE status != 'revoked' AND superseded_at IS NULL;
DROP INDEX IF EXISTS idx_free_tier_enrollments_waitlist;
CREATE INDEX idx_free_tier_enrollments_waitlist
  ON free_tier_enrollments(waitlisted_at, account_id)
  WHERE status = 'waitlisted';
DROP INDEX IF EXISTS idx_usage_reservations_pending;
CREATE INDEX idx_usage_reservations_pending
  ON usage_reservations(expires_at) WHERE status = 'reserved';

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE gateway_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE free_tier_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_tier_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE account_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_events FORCE ROW LEVEL SECURITY;
ALTER TABLE free_tier_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_tier_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_tenant_isolation ON accounts;
CREATE POLICY accounts_tenant_isolation ON accounts
  USING (id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS account_memberships_tenant_isolation ON account_memberships;
CREATE POLICY account_memberships_tenant_isolation ON account_memberships
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS provider_credentials_tenant_isolation ON provider_credentials;
CREATE POLICY provider_credentials_tenant_isolation ON provider_credentials
  USING ((owner_type = 'account' AND account_id = current_setting('app.account_id', true)) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK ((owner_type = 'account' AND account_id = current_setting('app.account_id', true)) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS gateway_jobs_tenant_isolation ON gateway_jobs;
CREATE POLICY gateway_jobs_tenant_isolation ON gateway_jobs
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS free_tier_enrollments_tenant_isolation ON free_tier_enrollments;
CREATE POLICY free_tier_enrollments_tenant_isolation ON free_tier_enrollments
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS account_entitlements_tenant_isolation ON account_entitlements;
CREATE POLICY account_entitlements_tenant_isolation ON account_entitlements
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS usage_reservations_tenant_isolation ON usage_reservations;
CREATE POLICY usage_reservations_tenant_isolation ON usage_reservations
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS usage_events_tenant_isolation ON usage_events;
CREATE POLICY usage_events_tenant_isolation ON usage_events
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS quota_events_tenant_isolation ON quota_events;
CREATE POLICY quota_events_tenant_isolation ON quota_events
  USING (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator')
  WITH CHECK (account_id = current_setting('app.account_id', true) OR current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS free_tier_policy_runtime_read ON free_tier_policy;
CREATE POLICY free_tier_policy_runtime_read ON free_tier_policy
  FOR SELECT USING (
    current_user = 'firecrawl_gateway_runtime'
    OR pg_has_role(current_user, 'firecrawl_gateway_runtime', 'member')
  );
DROP POLICY IF EXISTS free_tier_policy_operator_access ON free_tier_policy;
CREATE POLICY free_tier_policy_operator_access ON free_tier_policy
  USING (current_user = 'firecrawl_gateway_operator')
  WITH CHECK (current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS quota_periods_runtime_read ON quota_periods;
CREATE POLICY quota_periods_runtime_read ON quota_periods
  FOR SELECT USING (
    current_user = 'firecrawl_gateway_runtime'
    OR pg_has_role(current_user, 'firecrawl_gateway_runtime', 'member')
  );
DROP POLICY IF EXISTS quota_periods_operator_access ON quota_periods;
CREATE POLICY quota_periods_operator_access ON quota_periods
  USING (current_user = 'firecrawl_gateway_operator')
  WITH CHECK (current_user = 'firecrawl_gateway_operator');
DROP POLICY IF EXISTS operator_notifications_operator_access ON operator_notifications;
CREATE POLICY operator_notifications_operator_access ON operator_notifications
  USING (current_user = 'firecrawl_gateway_operator')
  WITH CHECK (current_user = 'firecrawl_gateway_operator');

GRANT USAGE ON SCHEMA public TO firecrawl_gateway_runtime, firecrawl_gateway_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO firecrawl_gateway_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, settings, sessions TO firecrawl_gateway_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, account_memberships, api_keys, audit_logs,
  provider_credentials, gateway_jobs TO firecrawl_gateway_runtime;
GRANT SELECT ON free_tier_policy, quota_periods, free_tier_enrollments, account_entitlements,
  usage_reservations, usage_events, quota_events TO firecrawl_gateway_runtime;
GRANT UPDATE (status) ON account_entitlements TO firecrawl_gateway_runtime;
GRANT UPDATE (status, expires_at) ON usage_reservations TO firecrawl_gateway_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, settings, sessions, accounts, account_memberships,
  api_keys, audit_logs, provider_credentials, infrastructure_sources, gateway_jobs
  TO firecrawl_gateway_operator;
GRANT SELECT, INSERT, UPDATE ON free_tier_policy, free_tier_enrollments, quota_periods,
  account_entitlements, usage_reservations, quota_events, operator_notifications TO firecrawl_gateway_operator;
GRANT SELECT, INSERT ON usage_events TO firecrawl_gateway_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tokens, mfa_factors, mfa_recovery_codes,
  auth_sessions, security_events, email_outbox, email_delivery_events
  TO firecrawl_gateway_operator;
