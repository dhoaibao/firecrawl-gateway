import crypto from "node:crypto";
import { withOperatorTransaction } from "../db";
import { encryptAuthValue, decryptAuthValue } from "./crypto";
import { rootLogger } from "../logger";
import type { GatewayConfig } from "../types";
import { Router } from "express";

export interface EmailPayload {
  subject: string;
  html: string;
}

export async function queueEmail(input: {
  client: import("pg").PoolClient;
  userId?: string;
  recipient: string;
  kind: string;
  idempotencyKey: string;
  payload: EmailPayload;
  encryptionKey: string;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO email_outbox (id, idempotency_key, user_id, kind, recipient, payload_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [crypto.randomUUID(), input.idempotencyKey, input.userId ?? null, input.kind, input.recipient, encryptAuthValue(JSON.stringify(input.payload), input.encryptionKey)],
  );
}

export async function claimEmail(config: GatewayConfig): Promise<boolean> {
  if (!config.brevoApiKey) return false;
  const row = await withOperatorTransaction(async (client) => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT id FROM email_outbox
         WHERE status IN ('pending', 'processing') AND available_at <= NOW()
           AND (status = 'pending' OR locked_at < NOW() - INTERVAL '10 minutes')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE email_outbox o SET status = 'processing', locked_at = NOW(), attempts = attempts + 1
       FROM candidate WHERE o.id = candidate.id
       RETURNING o.*`,
    );
    return result.rows[0];
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
    await withOperatorTransaction((client) => client.query(
      `UPDATE email_outbox SET status = 'sent', sent_at = NOW(), brevo_message_id = $2, locked_at = NULL WHERE id = $1`,
      [row.id, body.messageId ?? null],
    ).then(() => undefined));
  } catch (error) {
    await retryEmail(row.id, Math.min(60 * 60 * 1000, 2 ** Math.min(row.attempts, 10) * 1000 + Math.random() * 1000), String(error));
  }
  return true;
}

async function retryEmail(id: string, delay: number, error: string): Promise<void> {
  await withOperatorTransaction((client) => client.query(
    `UPDATE email_outbox SET status = CASE WHEN attempts >= 8 THEN 'dead' ELSE 'pending' END,
       available_at = NOW() + ($2 || ' milliseconds')::interval, locked_at = NULL, last_error = $3 WHERE id = $1`,
    [id, String(Math.max(1000, Math.round(delay))), error.slice(0, 500)],
  ).then(() => undefined));
}

async function markEmailDead(id: string, error: string): Promise<void> {
  await withOperatorTransaction((client) => client.query(
    "UPDATE email_outbox SET status = 'dead', locked_at = NULL, last_error = $2 WHERE id = $1",
    [id, error.slice(0, 500)],
  ).then(() => undefined));
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
      await withOperatorTransaction(async (client) => {
        const eventType = String(req.body.event || "unknown");
        const inserted = await client.query(
          `INSERT INTO email_delivery_events (id, provider_event_id, event_type, payload)
           VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
          [crypto.randomUUID(), eventId, eventType, JSON.stringify(req.body)],
        );
        if (inserted.rowCount === 1 && ["hard_bounce", "soft_bounce", "blocked", "spam"].includes(eventType)) {
          await client.query(
            "UPDATE email_outbox SET status = 'dead', last_error = $2 WHERE brevo_message_id = $1 AND status = 'sent'",
            [eventId, `Brevo delivery event: ${eventType}`],
          );
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
