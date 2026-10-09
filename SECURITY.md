# Security Policy

## Scope

This policy covers the gateway application, the admin dashboard, repository configuration, and first-party workflows in this repository. Firecrawl Cloud, PostgreSQL, and their infrastructure are outside this repository's control; the upstream Firecrawl images used by the `deploy/firecrawl` Compose stack and the host that runs it are also outside it. Report provider or account issues to the relevant provider; report a vulnerability in this gateway here.

The gateway is a separate project in front of those services. It does not host PostgreSQL or Firecrawl Cloud, and a successful repository check does not validate the security of a deployed Firecrawl stack (including one started from `deploy/firecrawl`, which runs unauthenticated and must stay on loopback or behind an authenticating proxy, VPN, or firewall) or of external services.

## Reporting a vulnerability

Do not report security vulnerabilities in a public issue, pull request, or discussion. Do not include secrets, credentials, customer data, session values, or private target URLs in a report.

Use [GitHub's private vulnerability reporting for this repository](https://github.com/dhoaibao/firecrawl-gateway/security/advisories/new) when it is available. If private reporting is unavailable, contact the public maintainer account [@dhoaibao](https://github.com/dhoaibao) through GitHub before sharing sensitive details. No email address, private channel, or response-time commitment is implied here.

A useful report includes:

- the affected component, route, configuration boundary, or dependency;
- a minimal reproduction using redacted values;
- the security impact and the conditions required to trigger it; and
- a suggested mitigation, if you have one.

Maintainers may ask for a smaller or further-redacted reproduction. Coordinate any public disclosure with the maintainers; do not publish exploit details while a report is being investigated. There is no guaranteed response or remediation schedule.

## Safe handling

- Keep `.env` and other credential-bearing files local. Use `.env.example` for configuration documentation; never commit API keys, passwords, session values, or database credentials.
- Virtual API keys are `fc_`-prefixed, stored as hashes with encrypted key values, and their plaintext is returned only at creation. Treat the plaintext as a secret and redact it from logs, screenshots, and issues.
- Admin credentials come from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; they are not stored in PostgreSQL. Admin sessions use signed HTTP-only cookies.
- Audit logs are stored only in PostgreSQL. Do not add file-based audit artifacts that could expose sensitive request data.
- Redact authorization headers, cookies, tokens, private target URLs, customer content, and database connection strings from diagnostics.
- The gateway is intended for UTF-8 JSON traffic. Non-UTF-8 payloads, including binary uploads or Latin-1 text, can be corrupted in transit.

## CI and deployment boundary

- The GitHub Actions workflow is intentionally typecheck-only for pull requests and pushes to `main`; it is not a security scan, build, or deployment system.
- The API and admin dashboard deploy separately. Production credentials and external service configuration belong in the deployment environment, not in GitHub Actions logs or repository files.
- A passing CI check does not prove that CORS origins, database access, upstream URLs, API keys, or rate limits are safe. Include the relevant deployment boundary in a report without including its secret values.

## Migration warning

Stop any running API process before running `bun run db:migrate`. The same `DATABASE_URL` is used by runtime and migrations, so it must be migration-capable; do not use a transaction-only PgBouncer endpoint as-is. The post-baseline single-admin cutover migration intentionally deletes existing users, virtual API keys, and audit-log records, then removes user ownership. Run migrations only with explicit approval and a verified backup; Prisma migrations are not applied during API startup.

For routine development and support, see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SUPPORT.md`](SUPPORT.md). For a release or deployment checklist, see [`RELEASING.md`](RELEASING.md).
