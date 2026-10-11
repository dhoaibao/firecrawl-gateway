import { describe, expect, it } from "vitest";
import { chooseInitialBackend, isFallbackAllowed, requestNeedsCloud } from "./policy";

describe("routing policy", () => {
  it("routes managed features to cloud", () => {
    const needsCloud = requestNeedsCloud("/v1/agent", null);
    expect(needsCloud.required).toBe(true);
    expect(chooseInitialBackend("self-hosted-first", needsCloud)).toBe("cloud");
  });

  it("only permits privacy-safe self-hosted fallback", () => {
    expect(
      isFallbackAllowed("self-hosted-first", {
        hasSensitiveHeaders: false,
        hasPrivateTargetUrl: false,
      }),
    ).toBe(true);
    expect(
      isFallbackAllowed("self-hosted-first", {
        hasSensitiveHeaders: true,
        hasPrivateTargetUrl: false,
      }),
    ).toBe(false);
  });
});
