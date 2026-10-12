# Customer portal

React/Vite SPA where a signed-in customer manages their own virtual API keys and
Firecrawl Cloud keys and sees request usage. It talks only to `/portal/api/*` of the
gateway API and shares `packages/ui` and `packages/api-client` with the admin.

## Develop

```bash
bun --cwd apps/portal dev
```

The dev server calls the API at `VITE_API_BASE_URL` (for example
`http://localhost:8080`). The API must have `PORTAL_ORIGIN` set to the dev server's
origin (`http://localhost:5173`) and at least one OAuth client configured; see
`.env.example`. The portal and the API must share a site (`localhost` does).

## Deploy

The `portal` target of the root `Dockerfile` serves the built files with nginx. The API
origin is not baked in: the container writes `/config.js` at start from
`PORTAL_API_BASE_URL`, so the same image works in every environment. See
`deploy/portal/` and `SELF_HOST.md`.
