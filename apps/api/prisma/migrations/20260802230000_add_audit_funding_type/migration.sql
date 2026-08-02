ALTER TABLE "audit_logs"
  ADD COLUMN "funding_type" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_funding_type_check"
  CHECK ("funding_type" IN ('included', 'byok', 'unknown'));
