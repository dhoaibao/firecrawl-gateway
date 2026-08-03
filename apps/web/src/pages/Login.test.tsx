import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it, vi } from "vitest"
import Login from "./Login"

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    login: vi.fn(),
    completeMfa: vi.fn(),
  }),
}))

describe("Login accessibility", () => {
  it("renders a labelled sign-in landmark and form controls", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><Login /></MemoryRouter>)

    expect(markup).toContain('aria-labelledby="login-title"')
    expect(markup).toContain('aria-label="Sign in"')
    expect(markup).toContain('for="email"')
    expect(markup).toContain('for="password"')
    expect(markup).toContain('type="submit"')
    expect(markup).toContain('aria-label="Show password"')
  })
})
