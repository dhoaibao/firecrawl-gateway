import { describe, expect, it } from "vitest";
import { corsOriginsFor } from "./cors";

const config = {
  adminOrigin: "https://admin.example.com",
  apiOrigin: "https://api.example.com",
  portalOrigin: "https://app.example.com",
};

describe("corsOriginsFor", () => {
  it("lets the portal origin reach only the portal API", () => {
    expect(corsOriginsFor(config, "/portal/api/auth/me")).toEqual(["https://app.example.com"]);
    for (const url of ["/admin/api/auth/me", "/admin/api/keys", "/v1/scrape", "/health"])
      expect(corsOriginsFor(config, url)).toEqual([
        "https://admin.example.com",
        "https://api.example.com",
      ]);
  });

  it("allows nothing for unset origins", () => {
    expect(corsOriginsFor({ ...config, portalOrigin: "" }, "/portal/api/auth/me")).toEqual([]);
    expect(
      corsOriginsFor({ adminOrigin: "", apiOrigin: "", portalOrigin: "" }, "/admin/api/keys"),
    ).toEqual([]);
  });
});
