CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  suspended_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Lightweight migrations: add columns if they don't exist (for existing databases)
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  key_value VARCHAR(255), -- encrypted with FIRECRAWL_KEYS_ENCRYPTION_KEY
  key_prefix VARCHAR(255) NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Lightweight migrations: add columns if they don't exist (for existing databases)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_value VARCHAR(255);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_last_used_at ON api_keys(last_used_at);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  route_mode TEXT NOT NULL,
  backend_used TEXT NOT NULL,
  fallback_used BOOLEAN NOT NULL DEFAULT false,
  fallback_reason TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  target_url TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migrate persisted routing terminology from the former local backend names.
-- The conditional update avoids a primary-key conflict if an administrator has
-- already created the renamed setting before this migration runs.
UPDATE settings
SET key = 'self_hosted_firecrawl_url', updated_at = NOW()
WHERE key = 'local_firecrawl_url'
  AND NOT EXISTS (
    SELECT 1 FROM settings WHERE key = 'self_hosted_firecrawl_url'
  );

DELETE FROM settings WHERE key = 'local_firecrawl_url';

UPDATE settings
SET value = CASE value
  WHEN 'local-first' THEN 'self-hosted-first'
  WHEN 'local-only' THEN 'self-hosted-only'
  ELSE value
END,
updated_at = NOW()
WHERE key = 'default_route_mode'
  AND value IN ('local-first', 'local-only');

UPDATE audit_logs
SET route_mode = CASE route_mode
  WHEN 'local-first' THEN 'self-hosted-first'
  WHEN 'local-only' THEN 'self-hosted-only'
  ELSE route_mode
END
WHERE route_mode IN ('local-first', 'local-only');

UPDATE audit_logs
SET backend_used = 'self-hosted'
WHERE backend_used = 'local';

UPDATE audit_logs
SET fallback_reason = replace(fallback_reason, 'local', 'self-hosted')
WHERE fallback_reason LIKE '%local%';

-- connect-pg-simple will create its own session table if configured with createTableIfMissing
