# Landing page

Static marketing page for the customer portal, built with [Astro](https://astro.build)
and styled with the shared design tokens from `packages/ui`. It has no client-side
JavaScript, no API calls and no tracking.

## Develop

```bash
bun --cwd apps/landing dev
```

Sign-in links point at `PUBLIC_PORTAL_URL` (default `http://localhost:5173`) in dev.

## Deploy

The `landing` target of the root `Dockerfile` serves the built files with nginx. The
portal's address is not baked in: the build leaves a `__PORTAL_URL__` placeholder and
the container replaces it from `LANDING_PORTAL_URL` when it starts
(`deploy/landing/40-landing-config.sh`). The service is opt-in with
`COMPOSE_PROFILES=landing`; see `SELF_HOST.md`.

## Checks

`bun run typecheck` runs `astro check`; `bun run build` builds the site. The page's
copy states only what the gateway actually does; keep it that way when editing.
