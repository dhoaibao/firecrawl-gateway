import { describe, expect, it } from "vitest";
import { OAuthStateCodec } from "./oauth-state";

const value = { state: "s", verifier: "v", provider: "google" as const, expiresAt: 2_000 };

describe("OAuthStateCodec", () => {
  it("round-trips a state signed with the same secret", () => {
    const codec = new OAuthStateCodec("secret");
    expect(codec.decode(codec.encode(value), 1_000)).toEqual(value);
  });

  it("carries the user a link flow belongs to", () => {
    const codec = new OAuthStateCodec("secret");
    const linked = { ...value, linkUserId: "u1" };
    expect(codec.decode(codec.encode(linked), 1_000)).toEqual(linked);
    expect(codec.decode(codec.encode({ ...value, linkUserId: 5 as never }), 1_000)).toBeNull();
  });

  it("rejects a cookie signed with another secret, a tampered payload, and an expired state", () => {
    const codec = new OAuthStateCodec("secret");
    const cookie = codec.encode(value);
    expect(new OAuthStateCodec("other").decode(cookie, 1_000)).toBeNull();
    const [payload, signature] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ ...value, provider: "github" })).toString(
      "base64url",
    );
    expect(codec.decode(`${forged}.${signature}`, 1_000)).toBeNull();
    expect(codec.decode(`${payload}.`, 1_000)).toBeNull();
    expect(codec.decode(cookie, 2_000)).toBeNull();
    expect(codec.decode(undefined)).toBeNull();
    expect(codec.decode("garbage")).toBeNull();
  });

  it("compares the returned state in constant time and exactly", () => {
    expect(OAuthStateCodec.stateMatches("abc", "abc")).toBe(true);
    expect(OAuthStateCodec.stateMatches("abc", "abd")).toBe(false);
    expect(OAuthStateCodec.stateMatches("abc", "")).toBe(false);
  });
});
