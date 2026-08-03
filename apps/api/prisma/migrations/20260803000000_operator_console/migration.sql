CREATE TABLE "operator_notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "first_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "last_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" TEXT,
    "period_id" TEXT,
    "source_id" TEXT,
    "account_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "email_status" TEXT NOT NULL DEFAULT 'not_queued',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_email_error" TEXT,
    "email_outbox_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_notifications_dedup_key_key" ON "operator_notifications"("dedup_key");
CREATE INDEX "operator_notifications_state_idx" ON "operator_notifications"("state", "severity", "last_occurred_at");
CREATE INDEX "operator_notifications_source_idx" ON "operator_notifications"("source_id", "last_occurred_at");
CREATE INDEX "operator_notifications_account_idx" ON "operator_notifications"("account_id", "last_occurred_at");
CREATE UNIQUE INDEX "operator_notifications_email_outbox_id_key" ON "operator_notifications"("email_outbox_id");
ALTER TABLE "operator_notifications" ADD CONSTRAINT "operator_notifications_email_outbox_id_fkey" FOREIGN KEY ("email_outbox_id") REFERENCES "email_outbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operator_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "operator_notifications_operator_access" ON "operator_notifications"
  USING (current_user = 'firecrawl_gateway_operator')
  WITH CHECK (current_user = 'firecrawl_gateway_operator');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firecrawl_gateway_operator') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON operator_notifications TO firecrawl_gateway_operator';
  END IF;
END $$;
