import { Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { EmailService } from "../../email/application/email.service";

@Injectable()
export class BrevoWebhookService {
  constructor(private readonly config: AppConfigService, private readonly transactions: TransactionService, private readonly email: EmailService) {}

  async accept(authorization: string | undefined, payload: Record<string, unknown>): Promise<void> {
    if (!this.config.brevoWebhookToken || authorization !== `Bearer ${this.config.brevoWebhookToken}`) throw new UnauthorizedException("Unauthorized");
    const eventId = String(payload["message-id"] ?? payload.eventId ?? payload.id ?? "");
    if (!eventId) throw new BadRequestException("Event identifier is required");
    await this.transactions.runAsOperator((tx) => this.email.handleBrevoWebhook(tx, payload));
  }
}
