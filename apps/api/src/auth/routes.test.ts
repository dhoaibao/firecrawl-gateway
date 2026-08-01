import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import type { GatewayConfig } from "../types";
import { createAuthRouter } from "./routes";

const mockUpdateUser = vi.hoisted(() => vi.fn());
const mockRequestPasswordReset = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./passport", () => ({
  passport: {
    authenticate: () => (_req: express.Request, _res: express.Response, _next: express.NextFunction) => undefined,
  },
}));

vi.mock("../users/service", () => ({
  updateUser: mockUpdateUser,
  checkUserAccess: () => ({ allowed: true }),
}));

vi.mock("./service", () => ({
  GENERIC_AUTH_MESSAGE: "If the account can be processed, you will receive an email shortly.",
  requestPasswordReset: mockRequestPasswordReset,
}));

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash("current-password", 4);
});

function createApp(authenticated = true, databaseDates = false, config?: GatewayConfig) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => authenticated) as typeof req.isAuthenticated;
    if (authenticated) {
      const timestamp = databaseDates ? new Date("2026-01-01T00:00:00.000Z") : new Date().toISOString();
      req.user = {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        password_hash: passwordHash,
        is_admin: true,
        status: "active",
        suspended_until: databaseDates ? new Date("2026-01-02T00:00:00.000Z") : null,
        created_at: timestamp,
        updated_at: timestamp,
      } as unknown as Express.User;
    }
    next();
  });
  app.use("/auth", createAuthRouter(config));
  return app;
}

describe("GET /auth/me", () => {
  it("serializes database timestamp values as ISO strings", async () => {
    const res = await request(createApp(true, true)).get("/auth/me").expect(200);

    expect(res.body.data).toMatchObject({
      suspended_until: "2026-01-02T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(res.body.data).not.toHaveProperty("password_hash");
  });
});

describe("POST /auth/password/forgot", () => {
  it("uses the configured canonical URL rather than the request Host", async () => {
    await request(createApp(true, false, { publicAppUrl: "https://gateway.example.test" } as GatewayConfig))
      .post("/auth/password/forgot")
      .set("Host", "attacker.example.test")
      .send({ email: "user@example.com" })
      .expect(202);

    expect(mockRequestPasswordReset).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://gateway.example.test",
    }));
  });
});

describe("POST /auth/password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    await request(createApp(false))
      .post("/auth/password")
      .send({ current_password: "current-password", new_password: "new-password" })
      .expect(401);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects an incorrect current password", async () => {
    const res = await request(createApp())
      .post("/auth/password")
      .send({ current_password: "wrong-password", new_password: "new-password" })
      .expect(401);
    expect(res.body.error).toBe("Current password is incorrect");
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "short"],
    ["too long", "a".repeat(129)],
  ])("rejects a %s new password", async (_label, newPassword) => {
    const res = await request(createApp())
      .post("/auth/password")
      .send({ current_password: "current-password", new_password: newPassword })
      .expect(400);
    expect(res.body.error).toContain("Password must be");
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("updates the password hash", async () => {
    const res = await request(createApp())
      .post("/auth/password")
      .send({ current_password: "current-password", new_password: "new-password" })
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(mockUpdateUser).toHaveBeenCalledWith("admin-1", { password_hash: expect.any(String) });
    const [, updates] = mockUpdateUser.mock.calls[0];
    await expect(bcrypt.compare("new-password", updates.password_hash)).resolves.toBe(true);
  });
});
