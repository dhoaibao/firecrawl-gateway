import { describe, it, expect } from "vitest";
import { parseCookieSecure } from "./session";

describe("parseCookieSecure", () => {
  it("defaults to auto when unset", () => {
    expect(parseCookieSecure(undefined)).toBe("auto");
  });

  it("defaults to auto for empty strings", () => {
    expect(parseCookieSecure("")).toBe("auto");
    expect(parseCookieSecure("   ")).toBe("auto");
  });

  it("parses true variants", () => {
    expect(parseCookieSecure("true")).toBe(true);
    expect(parseCookieSecure("TRUE")).toBe(true);
    expect(parseCookieSecure("1")).toBe(true);
    expect(parseCookieSecure("yes")).toBe(true);
    expect(parseCookieSecure("on")).toBe(true);
  });

  it("parses false variants", () => {
    expect(parseCookieSecure("false")).toBe(false);
    expect(parseCookieSecure("FALSE")).toBe(false);
    expect(parseCookieSecure("0")).toBe(false);
    expect(parseCookieSecure("no")).toBe(false);
    expect(parseCookieSecure("off")).toBe(false);
  });

  it("parses auto variants", () => {
    expect(parseCookieSecure("auto")).toBe("auto");
    expect(parseCookieSecure("AUTO")).toBe("auto");
  });

  it("falls back to auto for unrecognized values", () => {
    expect(parseCookieSecure("maybe")).toBe("auto");
  });
});
