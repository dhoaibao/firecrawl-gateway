import { describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller";

function reply() {
  const value: {
    status: number;
    body?: unknown;
    code: (status: number) => typeof value;
    send: (body: unknown) => typeof value;
  } = {
    status: 200,
    code(status) {
      value.status = status;
      return value;
    },
    send(body) {
      value.body = body;
      return value;
    },
  };
  return value;
}

describe("AuthController", () => {
  it("authenticates only the configured environment admin", async () => {
    const sessions = { setAdmin: vi.fn(), clearAdmin: vi.fn() };
    const controller = new AuthController(
      {
        authEnabled: true,
        adminEmail: "admin@example.com",
        adminPassword: "correct-password",
      } as never,
      sessions as never,
    );

    const wrong = reply();
    await controller.login(
      { email: "admin@example.com", password: "wrong-password" },
      wrong as never,
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ success: false, error: "Invalid email or password" });
    expect(sessions.setAdmin).not.toHaveBeenCalled();

    const right = reply();
    await controller.login(
      { email: " ADMIN@EXAMPLE.COM ", password: "correct-password" },
      right as never,
    );
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ success: true, data: { email: "admin@example.com" } });
    expect(sessions.setAdmin).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, { email: 42, password: ["x"] }])(
    "answers 401, not 500, for the missing or malformed body %j",
    async (body) => {
      const sessions = { setAdmin: vi.fn(), clearAdmin: vi.fn() };
      const controller = new AuthController(
        {
          authEnabled: true,
          adminEmail: "admin@example.com",
          adminPassword: "correct-password",
        } as never,
        sessions as never,
      );

      const response = reply();
      await controller.login(body as never, response as never);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ success: false, error: "Invalid email or password" });
      expect(sessions.setAdmin).not.toHaveBeenCalled();
    },
  );
});
