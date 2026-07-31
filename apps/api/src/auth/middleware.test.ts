import { describe, it, expect, vi } from "vitest";
import type { Response, NextFunction } from "express";
import { requireAuth, requireAdmin, type AuthenticatedRequest } from "./middleware";

function createReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    isAuthenticated: vi.fn().mockReturnValue(true) as unknown as AuthenticatedRequest["isAuthenticated"],
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      password_hash: "hash",
      is_admin: false,
      status: "active",
      suspended_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function createRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function createNext(): NextFunction {
  return vi.fn();
}

describe("requireAuth", () => {
  it("calls next for authenticated active user", () => {
    const req = createReq();
    const res = createRes();
    const next = createNext();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", () => {
    const req = createReq({
      isAuthenticated: vi.fn().mockReturnValue(false) as unknown as AuthenticatedRequest["isAuthenticated"],
    });
    const res = createRes();
    const next = createNext();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when user is missing", () => {
    const req = createReq({ user: undefined });
    const res = createRes();
    const next = createNext();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 for blocked user", () => {
    const req = createReq({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        password_hash: "hash",
        is_admin: false,
        status: "blocked",
        suspended_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const res = createRes();
    const next = createNext();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Account blocked" });
  });

  it("returns 403 for suspended user", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const req = createReq({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        password_hash: "hash",
        is_admin: false,
        status: "suspended",
        suspended_until: future,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const res = createRes();
    const next = createNext();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("suspended") }));
  });
});

describe("requireAdmin", () => {
  it("calls next for admin user", () => {
    const req = createReq({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        password_hash: "hash",
        is_admin: true,
        status: "active",
        suspended_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const res = createRes();
    const next = createNext();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 for non-admin user", () => {
    const req = createReq();
    const res = createRes();
    const next = createNext();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Forbidden" });
  });

  it("returns 401 when not authenticated", () => {
    const req = createReq({
      isAuthenticated: vi.fn().mockReturnValue(false) as unknown as AuthenticatedRequest["isAuthenticated"],
    });
    const res = createRes();
    const next = createNext();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
