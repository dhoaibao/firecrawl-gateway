import { describe, expect, it, vi } from "vitest";
import { EmailService } from "./email.service";

const config = {
  authEncryptionKey: "0".repeat(64),
  brevoApiKey: "",
  brevoSenderEmail: "noreply@example.com",
  brevoSenderName: "Firecrawl Gateway",
} as never;

describe("EmailService", () => {
  it("queues encrypted outbox entries idempotently", async () => {
    const transaction = {
      emailOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: "outbox-1" }),
      },
    };
    const service = new EmailService(config, {} as never);
    await expect(service.queue(transaction as never, {
      recipient: "user@example.com",
      kind: "verification",
      idempotencyKey: "verification:user-1",
      payload: { subject: "Verify", html: "<p>Verify</p>" },
    })).resolves.toBe("outbox-1");
    expect(transaction.emailOutbox.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true, data: expect.objectContaining({ payloadEncrypted: expect.any(String) }) }));
  });

  it("does not mutate delivery state for duplicate provider events", async () => {
    const transaction = {
      emailDeliveryEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      emailOutbox: { updateMany: vi.fn() },
      operatorNotification: { updateMany: vi.fn() },
    };
    const service = new EmailService(config, {} as never);
    await service.handleBrevoWebhook(transaction as never, { "message-id": "message-1", event: "hard_bounce" });
    expect(transaction.emailOutbox.updateMany).not.toHaveBeenCalled();
    expect(transaction.operatorNotification.updateMany).not.toHaveBeenCalled();
  });

  it("marks sent messages dead for terminal delivery failures", async () => {
    const transaction = {
      emailDeliveryEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      emailOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      operatorNotification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new EmailService(config, {} as never);
    await service.handleBrevoWebhook(transaction as never, { "message-id": "message-1", event: "hard_bounce" });
    expect(transaction.emailOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { brevoMessageId: "message-1", status: "sent" } }));
    expect(transaction.operatorNotification.updateMany).toHaveBeenCalled();
  });
});
