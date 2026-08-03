import { describe, expect, it, vi } from "vitest";
import { StaticUiController } from "./static-ui.controller";

function reply() {
  const response = {
    code: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
  };
  return response;
}

describe("StaticUiController negative-space rules", () => {
  it("returns JSON for API paths instead of SPA HTML", async () => {
    const response = reply();
    const controller = new StaticUiController({ authEnabled: true } as never);
    await controller.serve({ url: "/api/v1/not-a-route", raw: { url: "/api/v1/not-a-route" } } as never, response as never);

    expect(response.code).toHaveBeenCalledWith(404);
    expect(response.send).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(response.type).not.toHaveBeenCalledWith(expect.stringContaining("text/html"));
  });

  it("disables admin UI paths when authentication is disabled", async () => {
    const response = reply();
    const controller = new StaticUiController({ authEnabled: false } as never);
    await controller.serve({ url: "/admin", raw: { url: "/admin" } } as never, response as never);

    expect(response.code).toHaveBeenCalledWith(404);
    expect(response.send).toHaveBeenCalledWith({ success: false, error: "Admin UI is unavailable when AUTH_ENABLED=false." });
  });
});
