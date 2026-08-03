import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { GatewayConfig } from "./types";
import { withOperatorTransaction } from "./infrastructure/database";
import { queueEmail } from "./auth/email";

export type NotificationState = "active" | "acknowledged" | "resolved";
export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationInput {
  type: string;
  severity: NotificationSeverity;
  dedupKey: string;
  payload?: Record<string, unknown>;
  periodId?: string;
  sourceId?: string;
  accountId?: string;
}

const MAX_PAYLOAD_KEYS = 24;
const SENSITIVE = /(secret|token|password|credential|api[-_]?key|authorization|cookie|url)/i;

function safePayload(input: Record<string, unknown> | undefined): Prisma.InputJsonObject {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {}).slice(0, MAX_PAYLOAD_KEYS)) {
    if (SENSITIVE.test(key)) continue;
    if (typeof value === "string") output[key] = value.slice(0, 240);
    else if (typeof value === "number" || typeof value === "boolean") output[key] = value;
    else if (value === null) output[key] = null;
  }
  return output as Prisma.InputJsonObject;
}

function mapNotification(row: {
  id: string; type: string; severity: string; dedupKey: string; state: string;
  firstOccurredAt: Date; lastOccurredAt: Date; acknowledgedAt: Date | null;
  acknowledgedBy: string | null; resolvedAt: Date | null; resolvedBy: string | null;
  periodId: string | null; sourceId: string | null; accountId: string | null;
  payload: unknown; emailStatus: string; emailAttempts: number; lastEmailError: string | null; emailOutboxId: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id, type: row.type, severity: row.severity, dedup_key: row.dedupKey,
    state: row.state, first_occurred_at: row.firstOccurredAt.toISOString(),
    last_occurred_at: row.lastOccurredAt.toISOString(),
    acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
    acknowledged_by: row.acknowledgedBy, resolved_at: row.resolvedAt?.toISOString() ?? null,
    resolved_by: row.resolvedBy, period_id: row.periodId, source_id: row.sourceId,
    account_id: row.accountId, payload: row.payload, email_status: row.emailStatus,
    email_attempts: row.emailAttempts, last_email_error: row.lastEmailError, email_outbox_id: row.emailOutboxId,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  };
}

export async function upsertNotification(input: NotificationInput, config?: GatewayConfig) {
  const now = new Date();
  const payload = safePayload(input.payload);
  return withOperatorTransaction(async (tx) => {
    const existing = await tx.operatorNotification.findUnique({ where: { dedupKey: input.dedupKey } });
    if (existing) {
      const row = await tx.operatorNotification.update({
        where: { id: existing.id },
        data: { lastOccurredAt: now, payload, updatedAt: now, state: existing.state === "resolved" ? "active" : existing.state },
      });
      return mapNotification(row);
    }

    const emailEnabled = Boolean(config?.brevoApiKey && config.adminEmail && config.authEncryptionKey);
    const row = await tx.operatorNotification.create({
      data: {
        id: crypto.randomUUID(), type: input.type.slice(0, 120), severity: input.severity,
        dedupKey: input.dedupKey.slice(0, 255), firstOccurredAt: now, lastOccurredAt: now,
        periodId: input.periodId ?? null, sourceId: input.sourceId ?? null, accountId: input.accountId ?? null,
        payload, emailStatus: emailEnabled ? "queued" : "not_configured",
      },
    });
    let notificationRow = row;
    if (emailEnabled) {
      const outboxId = await queueEmail({
        client: tx, recipient: config!.adminEmail, kind: `operator_alert_${input.type}`,
        idempotencyKey: `operator-notification:${input.dedupKey}`,
        encryptionKey: config!.authEncryptionKey!,
        payload: {
          subject: `[Gateway ${input.severity}] ${input.type}`,
          html: `<p>Operator alert: ${input.type}</p><p>Notification ID: ${row.id}</p>`,
        },
      });
      notificationRow = await tx.operatorNotification.update({ where: { id: row.id }, data: { emailOutboxId: outboxId, updatedAt: new Date() } });
    }
    return mapNotification(notificationRow);
  });
}

export async function syncQuotaNotifications(config?: GatewayConfig): Promise<void> {
  const events = await withOperatorTransaction((tx) => tx.quotaEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 }));
  for (const event of events) {
    await upsertNotification({
      type: event.eventType,
      severity: event.severity as NotificationSeverity,
      dedupKey: event.dedupKey,
      payload: event.payload as Record<string, unknown>,
      periodId: event.periodId ?? undefined,
      accountId: event.accountId ?? undefined,
    }, config);
  }
}

export async function listNotifications(options: { state?: NotificationState; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.operatorNotification.findMany({
      where: options.state ? { state: options.state } : undefined,
      orderBy: [{ lastOccurredAt: "desc" }, { id: "desc" }], take: limit,
    });
    return rows.map(mapNotification);
  });
}

export async function updateNotificationState(id: string, state: Extract<NotificationState, "acknowledged" | "resolved">, actor: string) {
  return withOperatorTransaction(async (tx) => {
    const now = new Date();
    const row = await tx.operatorNotification.updateMany({
      where: { id },
      data: state === "acknowledged"
        ? { state, acknowledgedAt: now, acknowledgedBy: actor, updatedAt: now }
        : { state, resolvedAt: now, resolvedBy: actor, updatedAt: now },
    });
    return row.count === 1;
  });
}
