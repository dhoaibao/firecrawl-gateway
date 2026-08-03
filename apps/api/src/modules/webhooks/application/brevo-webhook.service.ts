import crypto from "node:crypto";
import { Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";

@Injectable()
export class BrevoWebhookService {
  constructor(private readonly config: AppConfigService, private readonly transactions: TransactionService) {}

  async accept(authorization: string | undefined, payload: Record<string, unknown>): Promise<void> {
    if (!this.config.brevoWebhookToken || authorization !== `Bearer ${this.config.brevoWebhookToken}`) throw new UnauthorizedException("Unauthorized");
    const eventId = String(payload["message-id"] ?? payload.eventId ?? payload.id ?? "");
    if (!eventId) throw new BadRequestException("Event identifier is required");
    const eventType = String(payload.event ?? "unknown");
    await this.transactions.runAsOperator(async (tx) => {
      const inserted = await tx.emailDeliveryEvent.createMany({ data: { id: crypto.randomUUID(), providerEventId: eventId, eventType, payload: payload as Prisma.InputJsonValue }, skipDuplicates: true });
      if (inserted.count !== 1 || !["hard_bounce", "soft_bounce", "blocked", "spam"].includes(eventType)) return;
      const failed = `Brevo delivery event: ${eventType}`;
      await tx.emailOutbox.updateMany({ where: { brevoMessageId: eventId, status: "sent" }, data: { status: "dead", lastError: failed } });
      await tx.operatorNotification.updateMany({ where: { emailOutbox: { brevoMessageId: eventId } }, data: { emailStatus: "dead", lastEmailError: failed, updatedAt: new Date() } });
    });
  }
}
