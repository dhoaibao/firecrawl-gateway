# Admin

Root-hosted React/Vite admin SPA for the Firecrawl Gateway.

Set `VITE_API_BASE_URL` to the deployed API origin. The API keeps the `/admin/api/*` contract while this project is deployed independently from `apps/api`. The admin session cookie is `SameSite=Lax`, so the admin and API origins must be on the same site (the same origin, or subdomains of one registrable domain).
