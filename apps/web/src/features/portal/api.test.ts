import { describe, expect, it, vi } from "vitest"

const mockPost = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({
  API_BASE: "/api/v1",
  api: {
    get: vi.fn(),
    post: mockPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  parseContract: vi.fn((_schema: unknown, value: unknown) => value),
}))

import { portalApi } from "./api"

describe("portal playground API", () => {
  it("sends the gateway token as a Bearer credential", () => {
    const response = Promise.resolve({ data: { status: 200 } })
    mockPost.mockReturnValue(response)

    expect(portalApi.playground("/v2/scrape", { url: "https://example.com" }, "fc_test_secret")).toBe(response)
    expect(mockPost).toHaveBeenCalledWith(
      "/api/v1/app/playground/v2/scrape",
      { url: "https://example.com" },
      { headers: { Authorization: "Bearer fc_test_secret" } },
    )
  })
})
