import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { BrevoWebhookService } from "../application/brevo-webhook.service";

@Controller("api/v1/webhooks")
export class BrevoWebhookController {
  constructor(private readonly webhooks: BrevoWebhookService) {}
  @Post("brevo")
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Headers("authorization") authorization: string | undefined, @Body() body: Record<string, unknown>) { await this.webhooks.accept(authorization, body); return { success: true }; }
}
