import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module";
import { CoreConfigModule } from "../../core/config/config.module";
import { EmailModule } from "../email/email.module";
import { BrevoWebhookService } from "./application/brevo-webhook.service";
import { BrevoWebhookController } from "./presentation/brevo-webhook.controller";

@Module({ imports: [CoreConfigModule, DatabaseModule, EmailModule], controllers: [BrevoWebhookController], providers: [BrevoWebhookService], exports: [BrevoWebhookService] })
export class WebhooksModule {}
