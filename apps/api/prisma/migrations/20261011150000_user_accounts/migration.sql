-- Portal user accounts (Google / GitHub sign-in), their sessions and their own
-- Firecrawl Cloud keys. Purely additive and unused until the portal ships:
--   * new tables only; the single-admin cutover dropped any older `users` table,
--     so plain CREATE TABLE is deliberate: a stale table must fail loudly here
--     rather than be silently reused with the wrong shape;
--   * two nullable ownership columns (no foreign key, no default, no rewrite).
-- The previous image ignores all of it, so rolling back to an earlier tag is safe.

CREATE TABLE users (
  id TEXT NOT NULL,
  email VARCHAR(320) NOT NULL,
  name VARCHAR(255),
  avatar_url VARCHAR(2048),
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  max_api_keys INTEGER,
  rate_limit_per_minute INTEGER,
  monthly_quota INTEGER,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ(3),
  deleted_at TIMESTAMPTZ(3),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE user_identities (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_identities_pkey PRIMARY KEY (id),
  CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX user_identities_provider_provider_user_id_key
  ON user_identities (provider, provider_user_id);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

CREATE TABLE user_sessions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  user_agent VARCHAR(255),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  last_seen_at TIMESTAMPTZ(3),
  revoked_at TIMESTAMPTZ(3),
  CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX user_sessions_token_hash_key ON user_sessions (token_hash);
CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

CREATE TABLE user_cloud_keys (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name VARCHAR(255) NOT NULL,
  key_value TEXT NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'cloud',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TIMESTAMPTZ(3),
  CONSTRAINT user_cloud_keys_pkey PRIMARY KEY (id),
  CONSTRAINT user_cloud_keys_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX user_cloud_keys_user_id_idx ON user_cloud_keys (user_id);

-- Ownership of virtual keys and audit rows. api_keys is small, so it is indexed
-- now; audit_logs is not (the index comes with the endpoint that needs it).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id TEXT;
