# Deploy and operate Firecrawl Gateway

This repository deploys the **gateway only**. It does not run Firecrawl,
PostgreSQL, Redis, or any other Firecrawl runtime service. Provide a reachable
external Firecrawl API and PostgreSQL database before starting the gateway.

## Choose a deployment method

| Method | Compose file | Image setting |
| --- | --- | --- |
| Build from this checkout | `docker-compose.yaml` | Not used |
| Run a release image | `docker-compose.prebuilt.yaml` | `GATEWAY_IMAGE` is required and must be an immutable `@sha256:` digest |

Both topologies start one-shot `migrate`, then start the API and worker only
when it succeeds. The API and worker never receive the migration credential.
The external Firecrawl URL and Cloud credentials are configured after sign-in
in **Configure > Routing** and **BYOK Credentials**; they are not environment
variables.

## Before you start

- Docker Compose
- An externally managed PostgreSQL database with separate runtime, operator,
  and migration credentials
- An externally hosted Firecrawl API reachable from the gateway container
- A production public HTTPS URL when authentication is enabled

Create local configuration without committing it:

```bash
cp .env.example .env
```

Generate each 64-character hex encryption key with `openssl rand -hex 32`.
Use a different value for every key; never put real values in source control or
logs.

## Minimum production configuration

Set these values in `.env` before either Compose deployment:

```dotenv
DATABASE_URL=postgresql://runtime_user:password@postgres.example.com:5432/firecrawl_gateway
OPERATOR_DATABASE_URL=postgresql://operator_user:password@postgres.example.com:5432/firecrawl_gateway
MIGRATION_DATABASE_URL=postgresql://migration_user:password@postgres.example.com:5432/firecrawl_gateway
SESSION_SECRET=at-least-32-random-characters
PUBLIC_APP_URL=https://gateway.example.com
AUTH_ENCRYPTION_KEY=64-character-hex-key
FIRECRAWL_KEYS_ENCRYPTION_KEY=64-character-hex-key
PROVIDER_CREDENTIALS_ENCRYPTION_KEY=a-different-64-character-hex-key
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a-strong-bootstrap-password
```

The three database URLs must use different roles. The migration role is only
for one-shot schema/security work; do not give it to `api` or `worker`. See
[database bootstrap](docs/operations/database-bootstrap.md) before using an
existing database.

## Start and verify

Build from source:

```bash
docker compose up -d --build
```

Use a prebuilt release image:

```bash
# Set GATEWAY_IMAGE to the release digest in .env first.
docker compose -f docker-compose.prebuilt.yaml up -d
```

Verify the deployment:

```bash
docker compose ps
docker compose logs api worker migrate
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

The gateway is exposed on `http://localhost:8080` by default, and the admin UI
is at `/admin` when authentication is enabled. Sign in with the bootstrap
admin, enroll MFA, configure the external Firecrawl URL using a hostname that
resolves **from the gateway container** (not `localhost`), then create a
gateway token for client requests.

The gateway begins in `cloud-first` mode. Change the saved default under
**Configure > Routing**, or set a request-specific header:

```text
X-Firecrawl-Route-Mode: self-hosted-first | self-hosted-only | cloud-first | cloud-only
```

## Environment reference

“Required” below means required by the described execution mode, not merely
that the sample file has a placeholder. Compose provides some defaults, while
the API validates other values at startup.

### Deployment and process

| Variable | Required? | Default | What it does |
| --- | --- | --- | --- |
| `GATEWAY_PORT` | Optional; Compose only | `8080` | Maps the host port to the API container's fixed port `8080`. It does not change the port listened to inside the container. |
| `GATEWAY_IMAGE` | Required for prebuilt Compose; unused by source Compose | — | Release image reference for `docker-compose.prebuilt.yaml`. Pin an immutable `repository@sha256:...` digest; never use a mutable tag such as `latest`. |
| `NODE_ENV` | Optional | `production` in Compose | Selects production safeguards. In production, authenticated deployments require the session secret, auth encryption key, public URL, and admin email; session cookies are always Secure and source URLs must be HTTPS. Use `development` only for local HTTP work. |
| `PORT` | Optional for a direct Node process; set by Compose | `8080` | TCP port the NestJS/Fastify API listens on. Compose always injects `8080`; use this rather than `GATEWAY_PORT` when not using Compose. |
| `WORKER_ENABLED` | Retained only for compatibility configuration | `false` for API, `true` for worker | The API and worker are separate NestJS processes; Compose selects the native `main.js` and `worker-main.js` entrypoints. |
| `WORKER_HEARTBEAT_FILE` | Optional for a direct worker process; overridden by Compose | `/tmp/firecrawl-worker-heartbeat` | Path updated by the worker for health monitoring. The Compose worker fixes this path so its healthcheck can read it. |
| `MIGRATION_BACKUP_CONFIRMED` | Required only to run `preflight` on an existing database | `false` | Must be exactly `true` after a restorable backup has been verified. It unlocks the read-only migration preflight; it does not authorize or run a migration by itself. |

### Database and migrations

| Variable | Required? | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required for API and worker | — | PostgreSQL connection string for the runtime role. This role is tenant-scoped and must not be a superuser or bypass RLS. |
| `OPERATOR_DATABASE_URL` | Required for API and worker | — | Separate PostgreSQL connection string for controlled cross-tenant operator transactions. It must be a different login that can assume the operator role. |
| `MIGRATION_DATABASE_URL` | Required for Compose `migrate`/`preflight` and manual schema work; not passed to API or worker | — | Deployment-only connection string used by the one-shot entrypoint. It applies Prisma migrations and `prisma/security.sql`; never use it as either runtime URL. |

For a fresh database, Compose uses `MIGRATION_DATABASE_URL` automatically in its
one-shot migration container. Existing installations need the reviewed
[bootstrap procedure](docs/operations/database-bootstrap.md), including
preflight and the explicit baseline decision.

### Authentication, browser security, and bootstrap administration

| Variable | Required? | Default | What it does |
| --- | --- | --- | --- |
| `AUTH_ENABLED` | Optional | `true` | Enables the admin UI, sessions, account routes, and authentication middleware. False-like values are empty, `false`, `0`, `no`, or `off`; with it disabled, `/admin` is unavailable. |
| `SESSION_SECRET` | Required when `NODE_ENV=production` and auth is enabled; otherwise optional | Random per-process secret when omitted outside that mode | Signs server-side sessions. In production it must be at least 32 characters and remain stable across restarts, otherwise every session is invalidated. |
| `SESSION_SECURE` | Optional | `auto` | Controls Secure cookies outside production: true-like values force them and false-like values disable them. Production always forces Secure cookies, so set false only for local HTTP development. |
| `PUBLIC_APP_URL` | Required when `NODE_ENV=production` and auth is enabled; otherwise optional | Empty | Canonical public origin used in account-verification and recovery links. It must be a valid URL and is never inferred from request headers. |
| `AUTH_ENCRYPTION_KEY` | Required when `NODE_ENV=production` and auth is enabled; otherwise optional | Empty | 64-character hex key that encrypts MFA secrets and short-lived email payloads. Keep it stable or stored data becomes unreadable. |
| `CORS_ORIGIN` | Optional | CORS disabled | Comma-separated list of exact allowed browser origins. When empty, cross-origin browser requests are not allowed. Do not use `*` with cookie authentication. |
| `TRUST_PROXY` | Optional | `false` | Fastify proxy-trust setting. Enable only behind a known reverse proxy that correctly sanitizes forwarded headers; otherwise client-supplied forwarding headers can affect request metadata. |
| `BCRYPT_ROUNDS` | Optional | `12` | bcrypt work factor for passwords and bootstrap-admin hashing. It must be an integer from 4 to 31; increasing it raises login CPU cost and rehashes passwords after successful login. |
| `ADMIN_EMAIL` | Required when `NODE_ENV=production` and auth is enabled | Empty | Bootstrap administrator email and recipient for applicable operator notifications. It must be configured in production, but does not overwrite an existing account. |
| `ADMIN_PASSWORD` | Required only to create the initial bootstrap admin | Empty | Password used once when both it and `ADMIN_EMAIL` are set and no matching admin exists. It is bcrypt-hashed; rotate/remove the deployment secret after bootstrap. Existing installs do not need it to start. |
| `REGISTRATION_ENABLED` | Optional | `false` | Opens public account registration only for true-like values (`true`, `1`, `yes`, `on`). Keep false until capacity, abuse controls, and email delivery are ready. |

### Encryption keys and email delivery

| Variable | Required? | Default | What it does |
| --- | --- | --- | --- |
| `FIRECRAWL_KEYS_ENCRYPTION_KEY` | Required in every supported configuration | — | 64-character hex key for legacy encrypted Cloud-key settings. It must remain stable until the legacy-source conversion is complete. Compose rejects a missing value. |
| `PROVIDER_CREDENTIALS_ENCRYPTION_KEY` | Required by both Compose files; optional only for a direct process that deliberately falls back to the legacy key | Falls back to `FIRECRAWL_KEYS_ENCRYPTION_KEY` outside Compose | Independent 64-character hex vault key for provider credentials. Set a distinct value; Compose requires it to prevent new deployments from relying on the compatibility fallback. |
| `BREVO_API_KEY` | Optional | Empty | Brevo API credential used to send verification, password-reset, and operator email through the durable outbox. With it empty, those messages are not sent. |
| `BREVO_SENDER_EMAIL` | Required by the supplied Compose files, even if `BREVO_API_KEY` is empty; optional when omitted by a direct process | `noreply@example.com` | Valid sender address placed on Brevo messages. The sample supplies this default; Compose passes a blank value through and startup rejects it. Set it to a sender verified in the Brevo account when email is enabled. |
| `BREVO_SENDER_NAME` | Required by the supplied Compose files, even if `BREVO_API_KEY` is empty; optional when omitted by a direct process | `Firecrawl Gateway` | Display name used for Brevo messages. The sample supplies this default; Compose passes a blank value through and startup rejects it. |
| `BREVO_WEBHOOK_TOKEN` | Required only when accepting Brevo webhook events | Empty | Bearer token expected by the Brevo webhook endpoint. Set a high-entropy secret before configuring that endpoint with Brevo. |

### Gateway limits, logging, and retention

| Variable | Required? | Default | What it does |
| --- | --- | --- | --- |
| `GATEWAY_REQUEST_TIMEOUT_MS` | Optional | `120000` | Positive millisecond ceiling for upstream gateway work. The server request/header timeouts are set slightly above it so stalled clients cannot hold sockets indefinitely. |
| `GATEWAY_MAX_BODY_BYTES` | Optional | `5242880` (5 MiB) | Positive maximum gateway request-body size and default upstream response-buffer cap, in bytes. Increase only after considering memory pressure and upstream limits. |
| `GATEWAY_TOKEN_MAX_LIFETIME_DAYS` | Optional for a direct process; not forwarded by the supplied Compose files | `365` | Positive maximum lifetime for user-created gateway tokens, capped at 3650 days. To use a non-default value in Compose, add it to the shared Compose environment deliberately. |
| `AUDIT_RETENTION_DAYS` | Optional | `90` | Number of days to retain request-audit rows. It must be 30–3650; the worker performs bounded retention cleanup while preserving usage and quota records. |
| `LOG_LEVEL` | Optional | `info` | Pino log threshold, for example `debug`, `info`, `warn`, or `error`. Avoid debug logging in production unless the operational impact and sensitive-data handling are understood. |
| `GATEWAY_LOG_FILE` | Optional compatibility setting; not forwarded by the supplied Compose files | `/data/hybrid-firecrawl-requests.jsonl` for direct processes | Legacy JSONL audit path. The production server persists canonical audit events to PostgreSQL with file output disabled, so this does not create production audit logs. |

## Update a prebuilt deployment

Update the immutable digest in `.env`, then pull and recreate the services:

```bash
docker compose -f docker-compose.prebuilt.yaml pull
docker compose -f docker-compose.prebuilt.yaml up -d
```

For production rollout, backup/restore-test first, run preflight for an existing
database, and use forward-only migrations. See
[hardening and rollout](docs/operations/hardening-rollout.md).

## Development

Node 22.22.0 or newer is required. From the repository root:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

These root scripts use Turborepo to run workspace tasks in dependency order. Task relationships and cache settings are defined in [`turbo.json`](turbo.json); invoke the npm scripts rather than requiring a global Turbo installation.

For routes, tenant request format, routing policy, and focused API development,
see [the API guide](apps/api/README.md). Authentication and MFA behavior are
documented in [authentication security](docs/AUTH_SECURITY.md).
