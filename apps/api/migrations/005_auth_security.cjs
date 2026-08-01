exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset', 'email_change')),
      token_hash TEXT NOT NULL UNIQUE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS auth_tokens_lookup_idx ON auth_tokens(purpose, token_hash, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_one_active_per_purpose_idx
      ON auth_tokens(user_id, purpose) WHERE consumed_at IS NULL;

    CREATE TABLE IF NOT EXISTS mfa_factors (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      secret_encrypted TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      pending_secret_encrypted TEXT,
      verified_at TIMESTAMPTZ,
      enabled_at TIMESTAMPTZ,
      last_used_step BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id, consumed_at);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      session_id_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      auth_version INTEGER NOT NULL,
      mfa_verified_at TIMESTAMPTZ,
      ip_label TEXT,
      user_agent_label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      idle_expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, revoked_at, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      ip_label TEXT,
      user_agent_label TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      recipient TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      brevo_message_id TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS email_outbox_claim_idx ON email_outbox(status, available_at);

    CREATE TABLE IF NOT EXISTS email_delivery_events (
      id TEXT PRIMARY KEY,
      provider_event_id TEXT NOT NULL UNIQUE,
      outbox_id TEXT REFERENCES email_outbox(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tokens, mfa_factors, mfa_recovery_codes, auth_sessions, security_events, email_outbox, email_delivery_events TO firecrawl_gateway_operator';
      END IF;
    END $$;

    UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at) WHERE email_verified_at IS NULL;
    DELETE FROM settings WHERE key = 'user_inactivity_suspend_days';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_delivery_events;
    DROP TABLE IF EXISTS email_outbox;
    DROP TABLE IF EXISTS security_events;
    DROP TABLE IF EXISTS auth_sessions;
    DROP TABLE IF EXISTS mfa_recovery_codes;
    DROP TABLE IF EXISTS mfa_factors;
    DROP TABLE IF EXISTS auth_tokens;
  `);
};
