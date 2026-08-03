import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { decryptAuthValue, encryptAuthValue } from "../../../auth/crypto";

type EmailPayload = { subject: string; html: string };
type EmailTransaction = Prisma.TransactionClient;

type EmailOutboxRow = {
  id: string;
  payloadEncrypted: string;
  recipient: string;
  idempotencyKey: string;
  attempts: number;
};

const MAX_ATTEMPTS = 8;

@Injectable()
export class EmailService {

  constructor(
    private readonly config: AppConfigService,
    private readonly transactions: TransactionService,
  ) {}

  async queue(transaction: EmailTransaction, input: {
    userId?: string;
    recipient: string;
    kind: string;
    idempotencyKey: string;
    payload: EmailPayload;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await transaction.emailOutbox.createMany({
      data: {
        id,
        idempotencyKey: input.idempotencyKey,
        userId: input.userId ?? null,
        kind: input.kind,
        recipient: input.recipient,
        payloadEncrypted: encryptAuthValue(JSON.stringify(input.payload), this.config.authEncryptionKey),
      },
      skipDuplicates: true,
    });
    const row = await transaction.emailOutbox.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
    if (!row) throw new Error("Unable to create email outbox entry");
    return row.id;
  }

  async handleBrevoWebhook(transaction: EmailTransaction, payload: Record<string, unknown>): Promise<void> {
    const eventId = String(payload["message-id"] ?? payload.eventId ?? payload.id ?? "");
    if (!eventId) return;
    const eventType = String(payload.event ?? "unknown");
    const inserted = await transaction.emailDeliveryEvent.createMany({
      data: {
        id: crypto.randomUUID(),
        providerEventId: eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });
    if (inserted.count !== 1 || !["hard_bounce", "soft_bounce", "blocked", "spam"].includes(eventType)) return;
    const failed = `Brevo delivery event: ${eventType}`;
    await transaction.emailOutbox.updateMany({ where: { brevoMessageId: eventId, status: "sent" }, data: { status: "dead", lastError: failed } });
    await transaction.operatorNotification.updateMany({
      where: { emailOutbox: { brevoMessageId: eventId } },
      data: { emailStatus: "dead", lastEmailError: failed, updatedAt: new Date() },
    });
  }

  async claimOne(): Promise<boolean> {
    if (!this.config.brevoApiKey) return false;
    const row = await this.transactions.runAsOperator(async (tx) => {
      const result = await tx.$queryRaw<EmailOutboxRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT id FROM email_outbox
          WHERE status IN ('pending', 'processing') AND available_at <= NOW()
            AND (status = 'pending' OR locked_at < NOW() - INTERVAL '10 minutes')
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE email_outbox o SET status = 'processing', locked_at = NOW(), attempts = attempts + 1
        FROM candidate WHERE o.id = candidate.id
        RETURNING o.id, o.payload_encrypted AS "payloadEncrypted", o.recipient, o.idempotency_key AS "idempotencyKey", o.attempts
      `);
      return result[0];
    });
    if (!row) return false;

    let payload: EmailPayload;
    try {
      payload = JSON.parse(decryptAuthValue(row.payloadEncrypted, this.config.authEncryptionKey)) as EmailPayload;
    } catch (error) {
      await this.markDead(row.id, `Unable to decrypt payload: ${String(error)}`);
      return true;
    }

    try {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": this.config.brevoApiKey, "content-type": "application/json" },
        body: JSON.stringify({
          sender: { email: this.config.brevoSenderEmail, name: this.config.brevoSenderName },
          to: [{ email: row.recipient }],
          subject: payload.subject,
          htmlContent: payload.html,
          headers: { "X-Mailin-custom": row.idempotencyKey },
        }),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const delay = response.status === 429
          ? Math.max(60_000, Number(retryAfter || 60) * 1000)
          : Math.min(60 * 60 * 1000, 2 ** Math.min(row.attempts, 10) * 1000 + Math.random() * 1000);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) await this.markDead(row.id, `Brevo ${response.status}`);
        else await this.retry(row.id, delay, `Brevo ${response.status}`);
        return true;
      }
      const responseBody = await response.json() as { messageId?: string };
      await this.transactions.runAsOperator((tx) => tx.emailOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), brevoMessageId: responseBody.messageId ?? null, lockedAt: null },
      }).then(() => undefined));
      await this.syncNotification(row.id, "sent", row.attempts);
    } catch (error) {
      await this.retry(row.id, Math.min(60 * 60 * 1000, 2 ** Math.min(row.attempts, 10) * 1000 + Math.random() * 1000), String(error));
    }
    return true;
  }

  private async retry(id: string, delay: number, error: string): Promise<void> {
    let attempts = 0;
    await this.transactions.runAsOperator(async (tx) => {
      await tx.emailOutbox.update({
        where: { id },
        data: { status: "pending", availableAt: new Date(Date.now() + Math.max(1_000, Math.round(delay))), lockedAt: null, lastError: error.slice(0, 500) },
      });
      const row = await tx.emailOutbox.findUnique({ where: { id }, select: { attempts: true } });
      attempts = row?.attempts ?? 0;
      if (row && row.attempts >= MAX_ATTEMPTS) await tx.emailOutbox.update({ where: { id }, data: { status: "dead" } });
    });
    await this.syncNotification(id, attempts >= MAX_ATTEMPTS ? "dead" : "queued", attempts, error);
  }

  private async markDead(id: string, error: string): Promise<void> {
    let attempts = 0;
    await this.transactions.runAsOperator(async (tx) => {
      const row = await tx.emailOutbox.update({ where: { id }, data: { status: "dead", lockedAt: null, lastError: error.slice(0, 500) }, select: { attempts: true } });
      attempts = row.attempts;
    });
    await this.syncNotification(id, "dead", attempts, error);
  }

  private async syncNotification(id: string, status: "queued" | "sent" | "dead", attempts: number, error?: string): Promise<void> {
    await this.transactions.runAsOperator((tx) => tx.operatorNotification.updateMany({
      where: { emailOutboxId: id },
      data: { emailStatus: status, emailAttempts: attempts, lastEmailError: error?.slice(0, 500) ?? null, updatedAt: new Date() },
    }).then(() => undefined));
  }
}
