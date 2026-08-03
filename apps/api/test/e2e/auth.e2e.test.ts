import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://localhost/firecrawl_test";
  process.env.NODE_ENV = "test";
});

import { AppModule } from "../../src/app.module";
import { configureFastifyHttp } from "../../src/common/http/fastify-http";
import { PrismaService } from "../../src/core/database/prisma.service";
import { RateLimitService } from "../../src/core/rate-limit/rate-limit.service";
import { AuthService } from "../../src/modules/auth/application/auth.service";

const user = {
  id: "user-1",
  email: "user@example.com",
  normalized_email: "user@example.com",
  name: "Test User",
  password_hash: "$2b$12$hash",
  is_admin: false,
  platform_role: "user",
  email_verified_at: "2026-01-01T00:00:00.000Z",
  auth_version: 1,
  account_id: "personal:user-1",
  status: "active",
  suspended_until: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const openApplications: NestFastifyApplication[] = [];

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) throw new Error("Expected a session cookie");
  return first.split(";", 1)[0];
}

async function createApplication() {
  const auth = {
    authenticate: vi.fn().mockResolvedValue(user),
    getMfaState: vi.fn().mockResolvedValue({ enabled: false, verified: false }),
    createSession: vi.fn().mockResolvedValue(undefined),
    authorizeSession: vi.fn().mockResolvedValue(user),
    checkAccess: vi.fn().mockReturnValue({ allowed: true }),
    verifyPassword: vi.fn().mockResolvedValue(true),
    requestEmailChange: vi.fn().mockResolvedValue(false),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
  };
  const rateLimits = {
    consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 299, resetAt: new Date(Date.now() + 60_000) }),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({ $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) })
    .overrideProvider(RateLimitService)
    .useValue(rateLimits)
    .overrideProvider(AuthService)
    .useValue(auth)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureFastifyHttp(app, ["http://portal.test"]);
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);
  await app.register(fastifySession as unknown as Parameters<typeof app.register>[0], {
    secret: "test-session-secret-that-is-at-least-32-characters",
    cookieName: "firecrawl.sid",
    store: new fastifySession.MemoryStore(),
    saveUninitialized: false,
    rolling: false,
    cookie: { secure: false, httpOnly: true, sameSite: "lax", path: "/" },
  });
  await app.init();
  const server = app.getHttpAdapter().getInstance() as FastifyInstance;
  await server.ready();
  openApplications.push(app);
  return { auth, rateLimits, server };
}

afterEach(async () => {
  await Promise.all(openApplications.splice(0).map((app) => app.close()));
});

describe("native Nest auth endpoints", () => {
  it("establishes a server-side session and returns the authenticated user", async () => {
    const { auth, rateLimits, server } = await createApplication();
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct horse battery staple" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ success: true, data: { id: "user-1", email: "user@example.com" } });
    expect(auth.createSession).toHaveBeenCalledWith(expect.objectContaining({ user, sessionId: expect.any(String) }));
    expect(rateLimits.consume).toHaveBeenCalledWith(
      [expect.stringMatching(/^auth-attempt:login:[a-f0-9]{32}$/)],
      8,
      15 * 60 * 1000,
    );
    expect(JSON.stringify(rateLimits.consume.mock.calls)).not.toContain("user@example.com");

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookie(login) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { id: "user-1" } });
  });

  it("rejects login before password verification when the shared auth-attempt limit is exhausted", async () => {
    const { auth, rateLimits, server } = await createApplication();
    rateLimits.consume.mockImplementation(async (keys: string[]) => ({
      allowed: !keys[0]?.startsWith("auth-attempt:login:"),
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    }));

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "incorrect password" },
    });

    expect(response.statusCode).toBe(429);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("enforces origin and CSRF tokens for authenticated mutations", async () => {
    const { auth, server } = await createApplication();
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct horse battery staple" },
    });
    const sessionCookie = cookie(login);

    const rejected = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions/revoke-all",
      headers: { cookie: sessionCookie },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["x-request-id"]).toEqual(expect.any(String));
    expect(rejected.json()).toMatchObject({
      success: false,
      error: "CSRF validation failed",
      requestId: rejected.headers["x-request-id"],
    });

    const csrf = await server.inject({
      method: "GET",
      url: "/api/v1/auth/csrf",
      headers: { cookie: sessionCookie },
    });
    const token = csrf.json<{ data: { token: string } }>().data.token;
    const accepted = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions/revoke-all",
      headers: {
        cookie: sessionCookie,
        host: "gateway.test",
        origin: "http://gateway.test",
        "x-csrf-token": token,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(auth.revokeAllSessions).toHaveBeenCalledWith("user-1", expect.any(Object));

    const duplicateEmail = await server.inject({
      method: "POST",
      url: "/api/v1/auth/email",
      headers: {
        cookie: sessionCookie,
        host: "gateway.test",
        origin: "http://gateway.test",
        "x-csrf-token": token,
      },
      payload: { email: "taken@example.com", current_password: "correct horse battery staple" },
    });
    expect(duplicateEmail.statusCode).toBe(409);
    expect(duplicateEmail.json()).toMatchObject({ success: false, error: "Email is already in use" });
  });

  it("applies CORS, security headers, request IDs, and the auth body limit before routing", async () => {
    const { server } = await createApplication();
    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: {
        origin: "http://portal.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://portal.test");

    const oversized = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `${"a".repeat(33 * 1024)}@example.com`, password: "password" },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers["x-request-id"]).toEqual(expect.any(String));
    expect(oversized.headers["content-security-policy"]).toContain("default-src 'self'");

    const missing = await server.inject({ method: "GET", url: "/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-request-id"]).toEqual(expect.any(String));
  });
});
