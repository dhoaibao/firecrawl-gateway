-- Optional per-key monthly request quota. Additive and nullable: existing keys keep
-- behaving as before (no quota) and the previous image ignores the column, so
-- rolling back to an earlier tag is safe. Counts live in rate_limits under
-- quota:<key id>:<YYYY-MM> and are pruned by the existing maintenance job.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS monthly_quota INTEGER;
