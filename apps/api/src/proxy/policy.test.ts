import { describe, expect, it } from "vitest";
import type { CloudKeyEntry } from "../common/types";
import {
  chooseInitialBackend,
  isCloudQuotaFallbackAllowed,
  isFallbackAllowed,
  mayUseCloudKeys,
  requestNeedsCloud,
  selectKeyPools,
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
    ["hybrid", false, "cloud"],
    ["hybrid", true, "cloud"],
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
    expect(isFallbackAllowed("hybrid", open)).toBe(true);
    expect(isFallbackAllowed("hybrid", { ...open, hasPrivateTargetUrl: true })).toBe(false);
    expect(isFallbackAllowed("cloud-first", open)).toBe(false);
  });

  it("allows the self-hosted quota fallback for hybrid unless Cloud is required", () => {
    expect(isCloudQuotaFallbackAllowed("hybrid", noCloud)).toBe(true);
    expect(isCloudQuotaFallbackAllowed("hybrid", needsCloud)).toBe(false);
  });

  describe("selectKeyPools", () => {
    const entries: CloudKeyEntry[] = [
      { key: "fc-cloud-1", role: "cloud" },
      { key: "fc-fallback-1", role: "fallback" },
      { key: "fc-cloud-2", role: "cloud" },
    ];

    it("uses every key as one pool outside hybrid, ignoring roles", () => {
      expect(selectKeyPools("cloud-first", "cloud", noCloud, entries)).toEqual({
        initialBackend: "cloud",
        cloudApiKeys: ["fc-cloud-1", "fc-fallback-1", "fc-cloud-2"],
        fallbackApiKeys: [],
      });
    });

    it("tries cloud-role keys first in hybrid and holds fallback keys in reserve", () => {
      expect(selectKeyPools("hybrid", "cloud", noCloud, entries)).toEqual({
        initialBackend: "cloud",
        cloudApiKeys: ["fc-cloud-1", "fc-cloud-2"],
        fallbackApiKeys: ["fc-fallback-1"],
      });
    });

    it("starts hybrid on self-hosted when no cloud-role key exists", () => {
      const onlyFallback = entries.filter((entry) => entry.role === "fallback");
      expect(selectKeyPools("hybrid", "cloud", noCloud, onlyFallback)).toEqual({
        initialBackend: "self-hosted",
        cloudApiKeys: ["fc-fallback-1"],
        fallbackApiKeys: [],
      });
      expect(selectKeyPools("hybrid", "cloud", needsCloud, onlyFallback)).toEqual({
        initialBackend: "cloud",
        cloudApiKeys: ["fc-fallback-1"],
        fallbackApiKeys: [],
      });
    });
  });
});
