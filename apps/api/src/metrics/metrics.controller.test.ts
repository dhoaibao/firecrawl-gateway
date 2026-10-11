import { describe, expect, it, vi } from "vitest";
import { MetricsController } from "./metrics.controller";

const TOKEN = "metrics-token-0123456789";

function makeReply() {
  const reply = {
    code: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

function makeController(metricsToken: string) {
  const metrics = {
    render: vi.fn().mockResolvedValue({ contentType: "text/plain; version=0.0.4", body: "m 1\n" }),
  };
  const controller = new MetricsController({ metricsToken } as never, metrics as never);
  return { controller, metrics };
}

describe("MetricsController", () => {
  it("returns 404 and never renders when no token is configured", async () => {
    const { controller, metrics } = makeController("");
    const reply = makeReply();

    await controller.scrape(`Bearer ${TOKEN}`, reply as never);

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(metrics.render).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "Bearer", "Basic abc", "Bearer wrong-token-0123456789"])(
    "rejects a missing or wrong credential with 401 (%j)",
    async (authorization) => {
      const { controller, metrics } = makeController(TOKEN);
      const reply = makeReply();

      await controller.scrape(authorization, reply as never);

      expect(reply.code).toHaveBeenCalledWith(401);
      expect(reply.header).toHaveBeenCalledWith("www-authenticate", "Bearer");
      expect(metrics.render).not.toHaveBeenCalled();
    },
  );

  it("serves the exposition text with the Prometheus content type for the right token", async () => {
    const { controller, metrics } = makeController(TOKEN);
    const reply = makeReply();

    await controller.scrape(`Bearer ${TOKEN}`, reply as never);

    expect(reply.code).not.toHaveBeenCalled();
    expect(metrics.render).toHaveBeenCalledTimes(1);
    expect(reply.header).toHaveBeenCalledWith("content-type", "text/plain; version=0.0.4");
    expect(reply.header).toHaveBeenCalledWith("cache-control", "no-store");
    expect(reply.send).toHaveBeenCalledWith("m 1\n");
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const { controller, metrics } = makeController(TOKEN);

    await controller.scrape(`bearer ${TOKEN}`, makeReply() as never);

    expect(metrics.render).toHaveBeenCalledTimes(1);
  });
});
