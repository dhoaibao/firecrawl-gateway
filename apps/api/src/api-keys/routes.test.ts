import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createApiKeysRouter } from "./routes";
import type { ApiKey } from "../types";

const mockListApiKeys = vi.hoisted(() => vi.fn());
const mockGetApiKeyById = vi.hoisted(() => vi.fn());
const mockCreateApiKey = vi.hoisted(() => vi.fn());
const mockRevokeApiKey = vi.hoisted(() => vi.fn());

vi.mock("./service", () => ({
  listApiKeys: mockListApiKeys,
  getApiKeyById: mockGetApiKeyById,
  createApiKey: mockCreateApiKey,
  revokeApiKey: mockRevokeApiKey,
}));

function createApp(user: { id: string; is_admin: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: user.id,
      email: "user@example.com",
      name: "User",
      password_hash: "hash",
      is_admin: user.is_admin,
      status: "active",
      suspended_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    next();
  });
  app.use("/api-keys", createApiKeysRouter());
  return app;
}

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-1",
    user_id: "user-1",
    name: "Test Key",
    key_hash: "hash",
    key_value: "fc_plainkey",
    key_prefix: "abcdef12",
    revoked: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

describe("GET /api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists all keys for admin", async () => {
    mockListApiKeys.mockResolvedValue([makeKey()]);
    const app = createApp({ id: "admin-1", is_admin: true });
    const res = await request(app).get("/api-keys").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty("key");
    expect(mockListApiKeys).toHaveBeenCalledWith(undefined);
  });

  it("lists only own keys for non-admin", async () => {
    mockListApiKeys.mockResolvedValue([makeKey()]);
    const app = createApp({ id: "user-1", is_admin: false });
    await request(app).get("/api-keys").expect(200);
    expect(mockListApiKeys).toHaveBeenCalledWith("user-1");
  });

  it("never redisplays a gateway token plaintext", async () => {
    mockListApiKeys.mockResolvedValue([makeKey()]);
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).get("/api-keys").expect(200);
    expect(res.body.data[0]).not.toHaveProperty("key_hash");
    expect(res.body.data[0]).not.toHaveProperty("key");
    expect(res.body.data[0]).not.toHaveProperty("key_value");
  });
});

describe("GET /api-keys/:id", () => {
  it("returns key for owner", async () => {
    mockGetApiKeyById.mockResolvedValue(makeKey({ user_id: "user-1" }));
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).get("/api-keys/key-1").expect(200);
    expect(res.body.data.id).toBe("key-1");
  });

  it("returns 403 for non-owner", async () => {
    mockGetApiKeyById.mockResolvedValue(makeKey({ user_id: "user-1" }));
    const app = createApp({ id: "user-2", is_admin: false });
    const res = await request(app).get("/api-keys/key-1").expect(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("returns 404 for missing key", async () => {
    mockGetApiKeyById.mockResolvedValue(null);
    const app = createApp({ id: "user-1", is_admin: false });
    await request(app).get("/api-keys/missing").expect(404);
  });

  it("does not return revoked key values", async () => {
    mockGetApiKeyById.mockResolvedValue(makeKey({ user_id: "user-1", revoked: true }));
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).get("/api-keys/key-1").expect(200);
    expect(res.body.data).not.toHaveProperty("key");
  });
});

describe("POST /api-keys", () => {
  it("creates a key for authenticated user", async () => {
    mockCreateApiKey.mockResolvedValue({
      ...makeKey(),
      key: "fc_plainkey",
    });
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).post("/api-keys").send({ name: "New Key" }).expect(201);
    expect(res.body.data.key).toBe("fc_plainkey");
    expect(mockCreateApiKey).toHaveBeenCalledWith("user-1", "New Key", {
      scopes: undefined,
      expiresAt: null,
      inactivityTimeoutSeconds: null,
    });
  });

  it("returns 400 when name is missing", async () => {
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).post("/api-keys").send({}).expect(400);
    expect(res.body.error).toContain("name");
  });
});

describe("DELETE /api-keys/:id", () => {
  it("revokes key for owner", async () => {
    mockGetApiKeyById.mockResolvedValue(makeKey({ user_id: "user-1" }));
    mockRevokeApiKey.mockResolvedValue(makeKey({ user_id: "user-1", revoked: true }));
    const app = createApp({ id: "user-1", is_admin: false });
    const res = await request(app).delete("/api-keys/key-1").expect(200);
    expect(res.body.data.revoked).toBe(true);
  });

  it("returns 403 for non-owner", async () => {
    mockGetApiKeyById.mockResolvedValue(makeKey({ user_id: "user-1" }));
    const app = createApp({ id: "user-2", is_admin: false });
    await request(app).delete("/api-keys/key-1").expect(403);
  });
});
