import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import { createAuthRouter } from "./routes";

const mockUpdateUser = vi.hoisted(() => vi.fn());

vi.mock("./passport", () => ({
  passport: {
    authenticate: () => (_req: express.Request, _res: express.Response, _next: express.NextFunction) => undefined,
  },
}));

vi.mock("../users/service", () => ({
  updateUser: mockUpdateUser,
  checkUserAccess: () => ({ allowed: true }),
}));

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash("current-password", 4);
});

function createApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => authenticated) as typeof req.isAuthenticated;
    if (authenticated) {
      req.user = {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        password_hash: passwordHash,
        is_admin: true,
        status: "active",
        suspended_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    next();
  });
  app.use("/auth", createAuthRouter());
  return app;
}

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
