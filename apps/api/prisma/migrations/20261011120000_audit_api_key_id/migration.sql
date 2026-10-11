-- Attribute audit entries to the virtual API key that made the request.
-- Additive and nullable: the previous image ignores the column, so rolling back
-- to an earlier tag is safe. No foreign key, so revoking a key never blocks.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS api_key_id TEXT;

CREATE INDEX IF NOT EXISTS audit_logs_api_key_id_created_at_idx
  ON audit_logs (api_key_id, created_at DESC);
