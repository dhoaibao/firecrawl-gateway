-- Optional per-key limits. Additive and nullable: existing keys keep behaving as
-- before (no expiry, no per-key rate limit) and the previous image ignores the
-- columns, so rolling back to an earlier tag is safe.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER;
