import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createUsersRouter } from "./routes";
import type { User } from "../types";

const mockListUsers = vi.hoisted(() => vi.fn());
const mockGetUserById = vi.hoisted(() => vi.fn());
const mockGetUserByEmail = vi.hoisted(() => vi.fn());
const mockRegisterUser = vi.hoisted(() => vi.fn());
const mockUpdateUser = vi.hoisted(() => vi.fn());
const mockSuspendUser = vi.hoisted(() => vi.fn());
const mockBlockUser = vi.hoisted(() => vi.fn());
const mockActivateUser = vi.hoisted(() => vi.fn());
const mockDeleteUserSafely = vi.hoisted(() => vi.fn());

vi.mock("./service", () => ({
  listUsers: mockListUsers,
  getUserById: mockGetUserById,
  getUserByEmail: mockGetUserByEmail,
  updateUser: mockUpdateUser,
  suspendUser: mockSuspendUser,
  blockUser: mockBlockUser,
  activateUser: mockActivateUser,
  deleteUserSafely: mockDeleteUserSafely,
}));

vi.mock("../auth/service", () => ({ registerUser: mockRegisterUser }));

function createApp(user: { id: string; is_admin: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: user.id,
      email: "admin@example.com",
      name: "Admin",
      password_hash: "hash",
      is_admin: user.is_admin,
      status: "active",
      suspended_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    next();
  });
  app.use("/users", createUsersRouter({
    publicAppUrl: "https://gateway.example.test",
    authEncryptionKey: "a".repeat(64),
  } as never));
  return app;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "User",
    password_hash: "hash",
    is_admin: false,
    status: "active",
    suspended_until: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("GET /users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists users", async () => {
    mockListUsers.mockResolvedValue([makeUser()]);
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).get("/users").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty("password_hash");
  });
});

describe("GET /users/:id", () => {
  it("returns user by id", async () => {
    mockGetUserById.mockResolvedValue(makeUser());
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).get("/users/user-1").expect(200);
    expect(res.body.data.id).toBe("user-1");
  });

  it("returns 404 for missing user", async () => {
    mockGetUserById.mockResolvedValue(null);
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app).get("/users/missing").expect(404);
  });
});

describe("POST /users", () => {
  it("creates a user with valid input", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockRegisterUser.mockResolvedValue(makeUser({ email: "new@example.com" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "new@example.com", name: "New User", password: "safe-password123" })
      .expect(201);
    expect(res.body.data.email).toBe("new@example.com");
  });

  it("returns 400 for invalid email", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "not-an-email", name: "User", password: "safe-password123" })
      .expect(400);
    expect(res.body.error).toContain("Invalid email");
  });

  it("returns 400 for short password", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "new@example.com", name: "User", password: "short" })
      .expect(400);
    expect(res.body.error).toContain("Password");
  });

  it("rejects a common password", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "new@example.com", name: "User", password: "123456789012" })
      .expect(400);
    expect(res.body.error).toContain("less common");
  });

  it("returns 409 for duplicate email", async () => {
    mockGetUserByEmail.mockResolvedValue(makeUser({ email: "exists@example.com" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "exists@example.com", name: "User", password: "safe-password123" })
      .expect(409);
    expect(res.body.error).toContain("already exists");
  });

  it("normalizes email to lowercase", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockRegisterUser.mockResolvedValue(makeUser({ email: "new@example.com" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app)
      .post("/users")
      .send({ email: "New@Example.com", name: "New User", password: "safe-password123" })
      .expect(201);
    expect(mockRegisterUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "new@example.com",
      name: "New User",
      password: "safe-password123",
      isAdmin: false,
    }));
  });

  it("returns 400 for password exceeding max length", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users")
      .send({ email: "new@example.com", name: "User", password: "a".repeat(129) })
      .expect(400);
    expect(res.body.error).toContain("at most");
  });
});

describe("PATCH /users/:id", () => {
  it("updates user name", async () => {
    mockUpdateUser.mockResolvedValue(makeUser({ name: "Updated" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/user-1").send({ name: "Updated" }).expect(200);
    expect(res.body.data.name).toBe("Updated");
  });

  it("returns 400 for invalid status", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/user-1").send({ status: "deleted" }).expect(400);
    expect(res.body.error).toContain("Status");
  });

  it("returns 400 for invalid suspended_until", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/user-1").send({ suspended_until: "not-a-date" }).expect(400);
    expect(res.body.error).toContain("suspended_until");
  });

  it("prevents self-revocation of admin rights", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/admin-1").send({ is_admin: false }).expect(400);
    expect(res.body.error).toContain("Cannot revoke your own admin rights");
  });

  it("prevents self-blocking", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/admin-1").send({ status: "blocked" }).expect(400);
    expect(res.body.error).toContain("Cannot block or suspend yourself");
  });

  it("prevents self-suspension via patch", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/admin-1").send({ status: "suspended" }).expect(400);
    expect(res.body.error).toContain("Cannot block or suspend yourself");
  });

  it("prevents self-suspension via suspended_until", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).patch("/users/admin-1").send({ suspended_until: future }).expect(400);
    expect(res.body.error).toContain("Cannot suspend yourself");
  });

  it("allows clearing own suspended_until", async () => {
    mockUpdateUser.mockResolvedValue(makeUser({ id: "admin-1", suspended_until: null }));
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app).patch("/users/admin-1").send({ suspended_until: null }).expect(200);
    expect(mockUpdateUser).toHaveBeenCalledWith("admin-1", expect.objectContaining({ suspended_until: null }));
  });

  it("normalizes email on update", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockUpdateUser.mockResolvedValue(makeUser({ email: "updated@example.com" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app).patch("/users/user-1").send({ email: "Updated@Example.com" }).expect(200);
    expect(mockUpdateUser).toHaveBeenCalledWith("user-1", expect.objectContaining({ email: "updated@example.com" }));
  });
});

describe("POST /users/:id/suspend", () => {
  it("suspends a user", async () => {
    mockSuspendUser.mockResolvedValue(makeUser({ status: "suspended" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users/user-2/suspend")
      .send({ duration: 1, unit: "days" })
      .expect(200);
    expect(res.body.data.status).toBe("suspended");
  });

  it("returns 400 for invalid duration", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users/user-2/suspend")
      .send({ duration: -1, unit: "days" })
      .expect(400);
    expect(res.body.error).toContain("Duration");
  });

  it("returns 400 for invalid unit", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app)
      .post("/users/user-2/suspend")
      .send({ duration: 1, unit: "months" })
      .expect(400);
    expect(res.body.error).toContain("Unit");
  });
});

describe("POST /users/:id/block", () => {
  it("blocks a user", async () => {
    mockBlockUser.mockResolvedValue(makeUser({ status: "blocked" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).post("/users/user-2/block").expect(200);
    expect(res.body.data.status).toBe("blocked");
  });
});

describe("POST /users/:id/activate", () => {
  it("activates a user", async () => {
    mockActivateUser.mockResolvedValue(makeUser({ status: "active" }));
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).post("/users/user-1/activate").expect(200);
    expect(res.body.data.status).toBe("active");
  });
});

describe("DELETE /users/:id", () => {
  it("deletes a user", async () => {
    mockDeleteUserSafely.mockResolvedValue("deleted");
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app).delete("/users/user-1").expect(204);
  });

  it("returns 404 for missing user", async () => {
    mockDeleteUserSafely.mockResolvedValue("not_found");
    const app = createApp({ id: "admin-1", is_admin: true });
    await request(app).delete("/users/missing").expect(404);
  });

  it("prevents self-deletion", async () => {
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).delete("/users/admin-1").expect(400);
    expect(res.body.error).toContain("Cannot delete yourself");
  });

  it("prevents deleting the last admin", async () => {
    mockDeleteUserSafely.mockResolvedValue("last_admin");
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).delete("/users/user-1").expect(400);
    expect(res.body.error).toContain("last admin");
  });
});
