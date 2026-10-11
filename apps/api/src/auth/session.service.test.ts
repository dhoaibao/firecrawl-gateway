import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SessionService } from "./session.service";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeService(overrides: Record<string, unknown> = {}) {
  return new SessionService({
    sessionSecret: "test-session-secret",
    adminEmail: "Admin@Example.com",
    adminPassword: "correct-password",
    ...overrides,
  } as never);
}

function issue(service: SessionService) {
  const reply = { setCookie: vi.fn() };
  service.setAdmin(reply as never);
  const [name, value, options] = reply.setCookie.mock.calls[0] as [
    string,
    string,
    Record<string, unknown>,
  ];
  return { name, value, options };
}

function requestWith(value: string | undefined) {
  return { cookies: value === undefined ? {} : { [SESSION_COOKIE]: value } } as never;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("SessionService", () => {
  it("accepts a freshly issued session and normalizes the admin email", () => {
    const service = makeService();
    const { name, value } = issue(service);

    expect(name).toBe(SESSION_COOKIE);
    expect(service.getAdmin(requestWith(value))).toEqual({ email: "admin@example.com" });
  });

  it("sets an http-only, same-site lax cookie that is secure only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(issue(makeService()).options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 30 * 24 * 60 * 60,
    });

    vi.stubEnv("NODE_ENV", "development");
    expect(issue(makeService()).options).toMatchObject({ sameSite: "lax", secure: false });
    expect(issue(makeService({ sessionSecure: true })).options).toMatchObject({ secure: true });
    vi.stubEnv("NODE_ENV", "production");
    expect(issue(makeService({ sessionSecure: false })).options).toMatchObject({ secure: false });
  });

  it("rejects a session older than 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const service = makeService();
    const { value } = issue(service);

    vi.setSystemTime(Date.now() + 30 * DAY_MS - 1_000);
    expect(service.getAdmin(requestWith(value))).not.toBeNull();
    vi.setSystemTime(Date.now() + 2_000);
    expect(service.getAdmin(requestWith(value))).toBeNull();
  });

  it("rejects a session after the admin password is rotated", () => {
    const { value } = issue(makeService());

    expect(makeService({ adminPassword: "new-password" }).getAdmin(requestWith(value))).toBeNull();
  });

  it("rejects a session signed with another secret or for another admin", () => {
    const { value } = issue(makeService());

    expect(makeService({ sessionSecret: "other-secret" }).getAdmin(requestWith(value))).toBeNull();
    expect(
      makeService({ adminEmail: "other@example.com" }).getAdmin(requestWith(value)),
    ).toBeNull();
  });

  it("rejects a tampered issue time or signature", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const service = makeService();
    const { value } = issue(service);
    const [issuedAt, signature] = value.split(".");

    // The issue time is covered by the signature, so it cannot be rewritten (here: backdated
    // within the valid window and later than now) without invalidating the cookie.
    expect(service.getAdmin(requestWith(`${Number(issuedAt) - DAY_MS}.${signature}`))).toBeNull();
    expect(service.getAdmin(requestWith(`${Number(issuedAt) + DAY_MS}.${signature}`))).toBeNull();
    expect(service.getAdmin(requestWith(`${issuedAt}.${signature}x`))).toBeNull();
    expect(service.getAdmin(requestWith(`${issuedAt}.`))).toBeNull();
    expect(service.getAdmin(requestWith(`.${signature}`))).toBeNull();
  });

  it("rejects missing, legacy, and malformed cookies", () => {
    const service = makeService();

    expect(service.getAdmin(requestWith(undefined))).toBeNull();
    // Legacy cookies were a bare HMAC of the email with no issue time.
    expect(service.getAdmin(requestWith("bGVnYWN5LXNpZ25hdHVyZQ"))).toBeNull();
    expect(service.getAdmin(requestWith("not-a-number.signature"))).toBeNull();
    expect(service.getAdmin({} as never)).toBeNull();
  });

  it("rejects every session when no admin credentials are configured", () => {
    const { value } = issue(makeService());

    expect(makeService({ adminPassword: "" }).getAdmin(requestWith(value))).toBeNull();
    expect(makeService({ adminEmail: " " }).getAdmin(requestWith(value))).toBeNull();
  });
});
