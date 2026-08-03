import { describe, expect, it, vi } from "vitest";
import { BrevoWebhookService } from "./brevo-webhook.service";

const token = "webhook-token";

describe("BrevoWebhookService", () => {
  it("rejects requests without the configured bearer token", async () => {
    const service = new BrevoWebhookService({ brevoWebhookToken: token } as never, {} as never, {} as never);
    await expect(service.accept("Bearer wrong", { id: "event-1" })).rejects.toMatchObject({ status: 401 });
  });

  it("requires a provider event identifier", async () => {
    const service = new BrevoWebhookService({ brevoWebhookToken: token } as never, {} as never, {} as never);
    await expect(service.accept(`Bearer ${token}`, { event: "delivered" })).rejects.toMatchObject({ status: 400 });
  });

  it("passes authenticated events to the email delivery boundary", async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const transactions = { runAsOperator: vi.fn((operation: (tx: object) => Promise<void>) => operation({})) };
    const service = new BrevoWebhookService({ brevoWebhookToken: token } as never, transactions as never, { handleBrevoWebhook: handle } as never);
    await expect(service.accept(`Bearer ${token}`, { "message-id": "event-1", event: "delivered" })).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledWith({}, { "message-id": "event-1", event: "delivered" });
  });
});
