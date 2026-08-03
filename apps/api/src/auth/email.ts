import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { withOperatorTransaction } from "../infrastructure/database";
import { encryptAuthValue, decryptAuthValue } from "./crypto";
import { rootLogger } from "../logger";
import type { GatewayConfig } from "../types";
import { Router } from "express";

export interface EmailPayload {
  subject: string;
  html: string;
}

interface EmailOutboxRow {
  id: string;
  payload_encrypted: string;
  recipient: string;
  idempotency_key: string;
  attempts: number;
}

export async function queueEmail(input: {
  client: Prisma.TransactionClient;
  userId?: string;
  recipient: string;
  kind: string;
  idempotencyKey: string;
  payload: EmailPayload;
  encryptionKey: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await input.client.emailOutbox.createMany({
    data: {
      id,
      idempotencyKey: input.idempotencyKey,
      userId: input.userId ?? null,
      kind: input.kind,
      recipient: input.recipient,
      payloadEncrypted: encryptAuthValue(JSON.stringify(input.payload), input.encryptionKey),
    },
    skipDuplicates: true,
  });
  const row = await input.client.emailOutbox.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (!row) throw new Error("Unable to create email outbox entry");
  return row.id;
}

export async function claimEmail(config: GatewayConfig): Promise<boolean> {
  if (!config.brevoApiKey) return false;
  const row = await withOperatorTransaction(async (tx) => {
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
      RETURNING o.*
    `);
    return result[0];
  });
  if (!row) return false;

  let payload: EmailPayload;
  try {
    payload = JSON.parse(decryptAuthValue(row.payload_encrypted, config.authEncryptionKey || "")) as EmailPayload;
  } catch (error) {
    await markEmailDead(row.id, `Unable to decrypt payload: ${String(error)}`);
    return true;
  }

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.brevoApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: config.brevoSenderEmail || "noreply@example.com", name: config.brevoSenderName || "Firecrawl Gateway" },
        to: [{ email: row.recipient }],
        subject: payload.subject,
        htmlContent: payload.html,
        headers: { "X-Mailin-custom": row.idempotency_key },
      }),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const delay = response.status === 429 ? Math.max(60_000, Number(retryAfter || 60) * 1000) : Math.min(60 * 60 * 1000, 2 ** Math.min(row.attempts, 10) * 1000 + Math.random() * 1000);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) await markEmailDead(row.id, `Brevo ${response.status}`);
      else await retryEmail(row.id, delay, `Brevo ${response.status}`);
      return true;
    }
    const body = await response.json() as { messageId?: string };
    await withOperatorTransaction((tx) => tx.emailOutbox.update({
      where: { id: row.id },
      data: { status: "sent", sentAt: new Date(), brevoMessageId: body.messageId ?? null, lockedAt: null },
    }).then(() => undefined));
    await syncOperatorNotificationEmail(row.id, "sent", row.attempts);
  } catch (error) {
    await retryEmail(row.id, Math.min(60 * 60 * 1000, 2 ** Math.min(row.attempts, 10) * 1000 + Math.random() * 1000), String(error));
  }
  return true;
}

async function retryEmail(id: string, delay: number, error: string): Promise<void> {
  let attempts = 0;
  await withOperatorTransaction((tx) => tx.emailOutbox.update({
    where: { id },
    data: {
      status: { set: "pending" },
      availableAt: new Date(Date.now() + Math.max(1000, Math.round(delay))),
      lockedAt: null,
      lastError: error.slice(0, 500),
    },
  }).then(async () => {
    const row = await tx.emailOutbox.findUnique({ where: { id }, select: { attempts: true } });
    attempts = row?.attempts ?? 0;
    if (row && row.attempts >= 8) {
      await tx.emailOutbox.update({ where: { id }, data: { status: "dead" } });
    }
  }));
  await syncOperatorNotificationEmail(id, attempts >= 8 ? "dead" : "queued", attempts, error);
}

async function markEmailDead(id: string, error: string): Promise<void> {
  let attempts = 0;
  await withOperatorTransaction(async (tx) => {
    const row = await tx.emailOutbox.update({
      where: { id },
      data: { status: "dead", lockedAt: null, lastError: error.slice(0, 500) },
      select: { attempts: true },
    });
    attempts = row.attempts;
  });
  await syncOperatorNotificationEmail(id, "dead", attempts, error);
}

async function syncOperatorNotificationEmail(id: string, status: "queued" | "sent" | "dead", attempts: number, error?: string): Promise<void> {
  await withOperatorTransaction((tx) => tx.operatorNotification.updateMany({
    where: { emailOutboxId: id },
    data: { emailStatus: status, emailAttempts: attempts, lastEmailError: error?.slice(0, 500) ?? null, updatedAt: new Date() },
  }).then(() => undefined));
}

export function createBrevoWebhookRouter(config: GatewayConfig) {
  const router = Router();
  router.post("/brevo", async (req, res, next) => {
    try {
      const authorization = req.get("authorization") || "";
      if (!config.brevoWebhookToken || authorization !== `Bearer ${config.brevoWebhookToken}`) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
      }
      const eventId = String(req.body?.["message-id"] || req.body?.eventId || req.body?.id || "");
      if (!eventId) {
        res.status(400).json({ success: false, error: "Event identifier is required" });
        return;
      }
      await withOperatorTransaction(async (tx) => {
        const eventType = String(req.body.event || "unknown");
        const inserted = await tx.emailDeliveryEvent.createMany({
          data: {
            id: crypto.randomUUID(),
            providerEventId: eventId,
            eventType,
            payload: req.body as Prisma.InputJsonValue,
          },
          skipDuplicates: true,
        });
        if (inserted.count === 1 && ["hard_bounce", "soft_bounce", "blocked", "spam"].includes(eventType)) {
          const failed = `Brevo delivery event: ${eventType}`;
          await tx.emailOutbox.updateMany({
            where: { brevoMessageId: eventId, status: "sent" },
            data: { status: "dead", lastError: failed },
          });
          await tx.operatorNotification.updateMany({
            where: { emailOutbox: { brevoMessageId: eventId } },
            data: { emailStatus: "dead", lastEmailError: failed, updatedAt: new Date() },
          });
        }
      });
      res.status(202).json({ success: true });
    } catch (error) { next(error); }
  });
  return router;
}

export function startEmailWorker(config: GatewayConfig): () => void {
  const run = () => void claimEmail(config).catch((error) => rootLogger.error({ err: error }, "Email outbox worker failed"));
  run();
  const interval = setInterval(run, 5_000);
  return () => clearInterval(interval);
}
