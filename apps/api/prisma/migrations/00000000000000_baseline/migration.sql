-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "platform_role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "suspended_until" TIMESTAMPTZ(6),
    "email_verified_at" TIMESTAMPTZ(6),
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "public_id" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
    "display_name" VARCHAR(255) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "funding_preference" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_memberships" (
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_memberships_pkey" PRIMARY KEY ("account_id","user_id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "key_value" VARCHAR(255),
    "key_prefix" VARCHAR(255) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "expires_at" TIMESTAMPTZ(6),
    "inactivity_timeout_seconds" INTEGER,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "route_mode" TEXT NOT NULL,
    "backend_used" TEXT NOT NULL,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "fallback_reason" TEXT NOT NULL DEFAULT '',
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "target_url" TEXT NOT NULL DEFAULT '',
    "user_id" TEXT,
    "account_id" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "sessions" (
    "sid" VARCHAR(255) NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "pending_secret_encrypted" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "enabled_at" TIMESTAMPTZ(6),
    "last_used_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "session_id_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "auth_version" INTEGER NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(6),
    "ip_label" TEXT,
    "user_agent_label" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "ip_label" TEXT,
    "user_agent_label" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "payload_encrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "brevo_message_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_delivery_events" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "outbox_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "account_id" TEXT,
    "purpose" TEXT NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "masked_prefix" TEXT NOT NULL,
    "masked_suffix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_metadata" JSONB NOT NULL DEFAULT '{}',
    "last_validated_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infrastructure_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "base_url" TEXT NOT NULL DEFAULT '',
    "credential_id" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "monthly_budget_cents" BIGINT,
    "hard_concurrency" INTEGER NOT NULL DEFAULT 1,
    "request_timeout_ms" INTEGER NOT NULL DEFAULT 120000,
    "response_buffer_max_bytes" INTEGER NOT NULL DEFAULT 5242880,
    "health_status" TEXT NOT NULL DEFAULT 'unknown',
    "last_health_check_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infrastructure_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_jobs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "public_job_id" TEXT NOT NULL,
    "upstream_job_id" TEXT NOT NULL,
    "route_family" TEXT NOT NULL,
    "source_id" TEXT,
    "credential_id" TEXT,
    "funding_type" TEXT NOT NULL,
    "creation_request" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "gateway_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_tier_policy" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "default_grant" INTEGER NOT NULL DEFAULT 100,
    "commitment_ceiling" INTEGER NOT NULL DEFAULT 1000,
    "hard_monthly_cap" BIGINT NOT NULL DEFAULT 10000,
    "committed_amount" INTEGER NOT NULL DEFAULT 0,
    "admissions_enabled" BOOLEAN NOT NULL DEFAULT false,
    "included_traffic_enabled" BOOLEAN NOT NULL DEFAULT true,
    "warning_thresholds" JSONB NOT NULL DEFAULT '{}',
    "next_period_changes" JSONB NOT NULL DEFAULT '[]',
    "policy_change_log" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_tier_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_tier_enrollments" (
    "account_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waitlisted',
    "grant_amount" INTEGER NOT NULL DEFAULT 100,
    "admitted_at" TIMESTAMPTZ(6),
    "waitlisted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "operator_reason" TEXT,
    "operator_actor" TEXT,
    "skipped_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_tier_enrollments_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "quota_periods" (
    "id" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "hard_cap" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_entitlements" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "allocated" INTEGER NOT NULL DEFAULT 100,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "enrollment_snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reservations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_id" TEXT,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "actor" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_events" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "account_id" TEXT,
    "period_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users"("normalized_email");

-- CreateIndex
CREATE INDEX "idx_users_created_at" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "idx_users_platform_role" ON "users"("platform_role");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_public_id_key" ON "accounts"("public_id");

-- CreateIndex
CREATE INDEX "idx_account_memberships_user_id" ON "account_memberships"("user_id");

-- CreateIndex
CREATE INDEX "idx_account_memberships_account_id" ON "account_memberships"("account_id");

-- CreateIndex
CREATE INDEX "idx_api_keys_user_id" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "idx_api_keys_key_hash" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_key_prefix" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "idx_api_keys_last_used_at" ON "api_keys"("last_used_at");

-- CreateIndex
CREATE INDEX "idx_api_keys_account_id" ON "api_keys"("account_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_account_id" ON "audit_logs"("account_id");

-- CreateIndex
CREATE INDEX "IDX_session_expire" ON "sessions"("expire");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_lookup_idx" ON "auth_tokens"("purpose", "token_hash", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_user_id_key" ON "mfa_factors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes"("user_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_session_id_hash_key" ON "auth_sessions"("session_id_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions"("user_id", "revoked_at", "last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_user_idx" ON "security_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotency_key_key" ON "email_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_outbox_claim_idx" ON "email_outbox"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_events_provider_event_id_key" ON "email_delivery_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "infrastructure_sources_routing_idx" ON "infrastructure_sources"("status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "gateway_jobs_account_lookup_idx" ON "gateway_jobs"("account_id", "public_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_jobs_account_id_public_job_id_key" ON "gateway_jobs"("account_id", "public_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "quota_periods_period_start_key" ON "quota_periods"("period_start");

-- CreateIndex
CREATE INDEX "idx_account_entitlements_period" ON "account_entitlements"("period_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "account_entitlements_account_id_period_id_key" ON "account_entitlements"("account_id", "period_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_request_id_key" ON "usage_events"("request_id");

-- CreateIndex
CREATE INDEX "idx_usage_events_period" ON "usage_events"("account_id", "period_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quota_events_dedup_key_key" ON "quota_events"("dedup_key");

-- CreateIndex
CREATE INDEX "idx_quota_events_account" ON "quota_events"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_events" ADD CONSTRAINT "email_delivery_events_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "email_outbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infrastructure_sources" ADD CONSTRAINT "infrastructure_sources_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_jobs" ADD CONSTRAINT "gateway_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_jobs" ADD CONSTRAINT "gateway_jobs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_tier_enrollments" ADD CONSTRAINT "free_tier_enrollments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entitlements" ADD CONSTRAINT "account_entitlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entitlements" ADD CONSTRAINT "account_entitlements_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "quota_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "quota_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "account_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "quota_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "quota_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
