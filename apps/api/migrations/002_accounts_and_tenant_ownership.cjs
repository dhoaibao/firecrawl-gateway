exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS normalized_email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;

    UPDATE users
    SET normalized_email = lower(btrim(email)),
        platform_role = CASE WHEN is_admin THEN 'admin' ELSE 'user' END
    WHERE normalized_email IS NULL OR platform_role IS NULL;

    ALTER TABLE users ALTER COLUMN normalized_email SET NOT NULL;
    ALTER TABLE users ALTER COLUMN platform_role SET NOT NULL;
    ALTER TABLE users ALTER COLUMN platform_role SET DEFAULT 'user';

    CREATE UNIQUE INDEX IF NOT EXISTS users_normalized_email_unique
      ON users (normalized_email);
    CREATE INDEX IF NOT EXISTS idx_users_platform_role ON users(platform_role);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_platform_role_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_platform_role_check
          CHECK (platform_role IN ('user', 'admin', 'support', 'operator'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_status_check
          CHECK (status IN ('active', 'suspended', 'blocked', 'deleted'));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE
        DEFAULT md5(random()::text || clock_timestamp()::text),
      display_name VARCHAR(255) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT accounts_status_check CHECK (status IN ('active', 'suspended', 'closed'))
    );

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

    CREATE TABLE IF NOT EXISTS account_memberships (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, user_id),
      CONSTRAINT account_memberships_role_check CHECK (role IN ('owner', 'member'))
    );

    CREATE INDEX IF NOT EXISTS idx_account_memberships_user_id
      ON account_memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_account_memberships_account_id
      ON account_memberships(account_id);

    INSERT INTO accounts (id, display_name)
    SELECT 'personal:' || u.id, COALESCE(NULLIF(btrim(u.name), ''), u.normalized_email)
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id = 'personal:' || u.id
    );

    INSERT INTO account_memberships (account_id, user_id, role)
    SELECT 'personal:' || u.id, u.id, 'owner'
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM account_memberships m
      WHERE m.account_id = 'personal:' || u.id AND m.user_id = u.id
    );

    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS account_id TEXT;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS account_id TEXT;

    UPDATE api_keys ak
    SET account_id = 'personal:' || ak.user_id
    WHERE ak.account_id IS NULL;

    UPDATE audit_logs al
    SET account_id = 'personal:' || al.user_id
    WHERE al.account_id IS NULL AND al.user_id IS NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_account_id_fkey'
      ) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_account_id_fkey
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_account_id_fkey'
      ) THEN
        ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_account_id_fkey
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL NOT VALID;
      END IF;
    END $$;

    ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_account_id_fkey;
    ALTER TABLE audit_logs VALIDATE CONSTRAINT audit_logs_account_id_fkey;
    ALTER TABLE api_keys ALTER COLUMN account_id SET NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys(account_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id ON audit_logs(account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS account_personal_owner_unique
      ON account_memberships(user_id)
      WHERE role = 'owner' AND account_id LIKE 'personal:%';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS account_personal_owner_unique;
    ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_account_id_fkey;
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_account_id_fkey;
    ALTER TABLE audit_logs DROP COLUMN IF EXISTS account_id;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS account_id;
    DROP TABLE IF EXISTS account_memberships;
    DROP TRIGGER IF EXISTS accounts_public_id_immutable ON accounts;
    DROP FUNCTION IF EXISTS prevent_account_public_id_change();
    DROP TABLE IF EXISTS accounts;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_platform_role_check;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    DROP INDEX IF EXISTS users_normalized_email_unique;
    DROP INDEX IF EXISTS idx_users_platform_role;
    ALTER TABLE users DROP COLUMN IF EXISTS auth_version;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
    ALTER TABLE users DROP COLUMN IF EXISTS platform_role;
    ALTER TABLE users DROP COLUMN IF EXISTS normalized_email;
  `);
};
