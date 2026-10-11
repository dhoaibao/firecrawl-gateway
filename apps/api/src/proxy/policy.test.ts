import { describe, expect, it } from "vitest";
import {
  chooseInitialBackend,
  isFallbackAllowed,
  mayUseCloudKeys,
  requestNeedsCloud,
  type RouteMode,
} from "./policy";

describe("routing policy", () => {
  const open = { hasSensitiveHeaders: false, hasPrivateTargetUrl: false };
  const noCloud = { required: false, reason: "" };
  const needsCloud = { required: true, reason: "agent" };

  it.each<[RouteMode, boolean, string]>([
    ["cloud-first", false, "cloud"],
    ["cloud-first", true, "cloud"],
    ["cloud-only", false, "cloud"],
    ["cloud-only", true, "cloud"],
    ["self-hosted-first", false, "self-hosted"],
    ["self-hosted-first", true, "cloud"],
    ["self-hosted-only", false, "self-hosted"],
    ["self-hosted-only", true, "reject"],
  ])("chooses the first backend for %s when Cloud is required=%s", (mode, required, expected) => {
    expect(chooseInitialBackend(mode, required ? needsCloud : noCloud)).toBe(expected);
  });

  it("loads Cloud keys only when Cloud may be used directly or as a fallback", () => {
    expect(mayUseCloudKeys("cloud", "cloud-only", open)).toBe(true);
    expect(mayUseCloudKeys("self-hosted", "self-hosted-first", open)).toBe(true);
    expect(
      mayUseCloudKeys("self-hosted", "self-hosted-first", { ...open, hasPrivateTargetUrl: true }),
    ).toBe(false);
    expect(mayUseCloudKeys("self-hosted", "self-hosted-only", open)).toBe(false);
    expect(mayUseCloudKeys("self-hosted", "cloud-first", open)).toBe(false);
    expect(mayUseCloudKeys("reject", "self-hosted-only", open)).toBe(false);
  });

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
