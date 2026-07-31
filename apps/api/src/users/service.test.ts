import { describe, it, expect } from "vitest";
import { checkUserAccess } from "./service";
import type { User } from "../types";

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

describe("checkUserAccess", () => {
  it("allows active users", () => {
    expect(checkUserAccess(makeUser())).toEqual({ allowed: true });
  });

  it("blocks blocked users", () => {
    const result = checkUserAccess(makeUser({ status: "blocked" }));
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("blocked");
  });

  it("blocks suspended users with a future suspended_until", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = checkUserAccess(makeUser({ status: "suspended", suspended_until: future }));
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("Try again");
  });

  it("blocks suspended users without suspended_until (auto-suspension)", () => {
    const result = checkUserAccess(makeUser({ status: "suspended", suspended_until: null }));
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("suspended");
  });
});
