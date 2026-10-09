# Releasing

This document is a lightweight checklist for an authorized maintainer preparing a version. It does not assert that any version has been released, tagged, or deployed. Keep [`CHANGELOG.md`](CHANGELOG.md) honest: do not move an item out of `Unreleased` until the corresponding change is actually ready to publish.

## Release boundary

- The repository contains two independently deployable apps: `apps/api` (Node server) and `apps/admin` (static SPA).
- `deploy.yml` runs typecheck-only CI for pull requests and pushes to `main`. `docker-publish.yml` builds and publishes the images to GHCR and deploys them over SSH on pushes to `main`, running `prisma migrate deploy` on each deploy. Neither publishes GitHub releases.
- Firecrawl Cloud and PostgreSQL are external services. A repository release does not create or upgrade those services, nor does it redeploy a running self-hosted Firecrawl stack from `deploy/firecrawl`.

## Prepare the release

- Confirm the intended scope from the reviewed changes and preserve unrelated work.
- Run the required check and the relevant local checks:

  ```bash
  bun run typecheck
  bun run build
  bun run lint
  bun run test
  rtk git diff --check
  ```

  If a check is not relevant or cannot run in the release environment, record that fact rather than implying it passed.

- Update `CHANGELOG.md` by changing `## [Unreleased]` to a verified version heading such as `## [X.Y.Z] - YYYY-MM-DD`, keeping only changes included in that version, then add a fresh empty `Unreleased` section above it.
- Decide the version deliberately. If package manifest versions are changed for the release, keep the relevant workspace manifests consistent and include that change in the release notes.
- Re-read the release notes for unsupported claims, secrets, customer data, private URLs, or unverified deployment statements.

## Tag and GitHub release

After review and merge on the intended commit:

1. Create the agreed annotated tag, for example `vX.Y.Z`, on that commit.
2. Push the tag only through the authorized maintainer process; this repository does not do that from CI.
3. Create the GitHub release from that tag and use the corresponding changelog section as its notes.
4. Do not create a release, tag, or adoption claim for work that remains unpublished or unverified.

The exact version, tag, and release are decisions for the maintainer; this checklist does not select one.

## Verify deployments separately

Verify the deployment that corresponds to the intended commit:

- Confirm the configured origins and `VITE_API_BASE_URL` match the deployed API/admin origins.
- Check the API `/health` and `/ready` endpoints, then perform a minimal non-sensitive request through the intended gateway origin.
- Confirm the root-hosted admin loads and can reach the API using the configured origin.
- Confirm the `maintenance` container logged a successful call (`docker compose logs maintenance`) and review logs without exposing secrets.
- Check the deployed `IMAGE_TAG` (`sha-<7 hex>`) matches the intended commit; roll back by re-running the workflow manually with an earlier tag.

A green GitHub typecheck does not prove that either app deployed successfully or that the self-hosted Firecrawl stack, Firecrawl Cloud, or PostgreSQL configuration is correct.

## Prisma migrations are separate

Do not treat a release or deployment as permission to migrate the database. Prisma migrations are separate, operationally sensitive, and approval-gated:

- Stop any running API process first.
- Take or verify an appropriate PostgreSQL backup and use a migration-capable direct `DATABASE_URL`; do not use a transaction-only PgBouncer endpoint as-is.
- Review the exact migration and obtain explicit cutover approval before running `bun run db:migrate`.
- The post-baseline single-admin cutover intentionally deletes existing users, virtual API keys, and audit-log records, then removes user ownership. This is destructive. It is not applied by API startup, but `docker-publish.yml` stops the gateway and runs `prisma migrate deploy` on every deploy, so a database that has not yet applied it will be wiped by the next deploy; apply it deliberately or hold deploys until then. Require reviewers on the `production` environment to gate this.
- Verify the API only after the migration completes successfully and the administrator has confirmed the resulting configuration.

For contributor and review expectations, see [`CONTRIBUTING.md`](CONTRIBUTING.md). For security-sensitive release concerns, see [`SECURITY.md`](SECURITY.md).
