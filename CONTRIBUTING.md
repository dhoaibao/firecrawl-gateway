# Contributing

Thanks for helping improve Firecrawl Gateway. The repository contains two independently deployable apps: a NestJS/Fastify API and a root-hosted React/Vite admin dashboard. Both front Firecrawl (Cloud and the self-hosted stack in `deploy/firecrawl`) and an externally hosted PostgreSQL; this repository does not run PostgreSQL or Firecrawl Cloud.

## Project boundaries

- `apps/api` is the gateway API. It proxies `/v1/*` and `/v2/*`, serves health/readiness endpoints, and exposes authenticated administration routes under `/admin/api/*`.
- `apps/admin` is the root-hosted operator dashboard. It talks to the API through `VITE_API_BASE_URL`.
- Firecrawl Cloud and PostgreSQL are external deployment prerequisites, not services maintained by this repository. Self-hosted Firecrawl is provided by the Docker Compose stack in `deploy/firecrawl`.
- GitHub Actions runs typecheck CI (`deploy.yml`) and, on pushes to `main`, `docker-publish.yml`, which publishes images to GHCR and deploys them over SSH to the `production` environment. A green check is not a deployment confirmation.

## Before you start

- Read the [README](README.md), [Quick Start](QUICKSTART.md), and [Self-Hosting Guide](SELF_HOST.md).
- Follow the admin UI rules in [`docs/DESIGN.md`](docs/DESIGN.md) when changing the dashboard.
- Read [`SECURITY.md`](SECURITY.md) before handling a suspected vulnerability and [`SUPPORT.md`](SUPPORT.md) for non-sensitive questions.
- Read [`RELEASING.md`](RELEASING.md) before preparing a version, tag, or deployment.

## Local development

Requirements are Bun 1.3+ and Node.js 22+.

```bash
bun install
cp .env.example .env
bun run db:generate
bun run dev
```

Keep `.env` and all credentials local. Do not paste API keys, passwords, session values, database URLs, customer data, or private target URLs into issues, pull requests, logs, or committed files.

## Validation

The repository workflow runs the following required check on pull requests and pushes to `main`:

```bash
bun run typecheck
```

Before opening a pull request, run the other relevant checks locally when your change affects them:

```bash
bun run build
bun run lint
bun run test
```

For admin-only changes, also run the checks from `apps/admin` as appropriate. Record the exact commands and outcomes in the pull request. CI does not run build, lint, test, database, or deployment jobs.

## Pull requests and review

- Use the repository pull request template and keep the change focused.
- Explain the problem, the proposed behavior, affected deployment boundary, and any operational or migration risk.
- Add or update tests and documentation when behavior changes.
- Do not commit generated output, local environment files, secrets, customer data, or private target URLs.
- Do not add a dependency without prior discussion and approval.
- Maintainers and the [`CODEOWNERS`](.github/CODEOWNERS) owner review changes for correctness, security, scope, documentation, and verification. Reviewers may request changes, additional evidence, or a narrower scope; no review or response-time SLA is promised.
- A pull request approval does not itself deploy production. Confirm the deployment and external service configuration separately.

## Database and migration warning

Do not run `bun run db:migrate` casually. Stop any running API process first and use a migration-capable direct PostgreSQL connection. The post-baseline single-admin cutover intentionally deletes existing users, virtual API keys, and audit-log records, then removes user ownership. Run migrations only with explicit approval and a verified backup. Prisma migrations are not applied during API startup.

Audit logs are stored only in PostgreSQL; do not add file-based audit persistence. The self-hosted Firecrawl (the `deploy/firecrawl` stack) is called directly via the `FIRECRAWL_SELF_HOSTED_URL` environment variable rather than an admin setting, while Cloud API keys are encrypted in PostgreSQL.

## Where to ask or report

- Use [`SUPPORT.md`](SUPPORT.md) for non-sensitive setup and usage questions.
- Use [`SECURITY.md`](SECURITY.md) for vulnerabilities; do not open a public issue for them.
- Use the bug and feature issue forms for reproducible problems and proposals.
- Follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community behavior concerns.
