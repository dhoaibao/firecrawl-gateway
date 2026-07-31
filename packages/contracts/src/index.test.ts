import { describe, expect, it } from "vitest";
import {
  authenticatedUserResponseSchema,
  errorEnvelopeSchema,
  paginationSchema,
  routeModeSchema,
} from "./index";

describe("control-plane contracts", () => {
  it("accepts supported route modes and rejects unknown modes", () => {
    expect(routeModeSchema.parse("cloud-first")).toBe("cloud-first");
    expect(() => routeModeSchema.parse("local-first")).toThrow();
  });

  it("normalizes pagination defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(() => paginationSchema.parse({ pageSize: 101 })).toThrow();
  });

  it("requires consistent error fields", () => {
    expect(errorEnvelopeSchema.parse({ success: false, error: "Bad request" })).toEqual({
      success: false,
      error: "Bad request",
    });
    expect(() => errorEnvelopeSchema.parse({ error: "Bad request" })).toThrow();
  });

  it("parses the authenticated user response", () => {
    expect(
      authenticatedUserResponseSchema.parse({
        data: {
          id: "user-1",
          email: "admin@example.com",
          name: "Admin",
          is_admin: true,
          status: "active",
          suspended_until: null,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
        },
      }).data.id,
    ).toBe("user-1");
  });
});
