import { describe, expect, it, vi } from "vitest";
import { BrevoWebhookController } from "./brevo-webhook.controller";

describe("BrevoWebhookController", () => {
  it("returns the accepted response after durable processing", async () => {
    const service = { accept: vi.fn().mockResolvedValue(undefined) };
    const controller = new BrevoWebhookController(service as never);
    await expect(controller.receive("Bearer token", { id: "event-1" })).resolves.toEqual({ success: true });
    expect(service.accept).toHaveBeenCalledWith("Bearer token", { id: "event-1" });
  });
});
