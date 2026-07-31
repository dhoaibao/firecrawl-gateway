# Phase 1 — Repository Foundation

Depends on: approved master plan
Behavioral goal: restructure without changing externally observable product behavior

## Scope

- Establish an npm-workspace modular monorepo.
- Move the existing gateway and UI into stable application boundaries.
- Split process bootstrap from Express app construction.
- Define module and shared-contract conventions.
- Establish root verification and CI before product migrations.
- Optionally upgrade Express 4 -> 5 only after the move is green and through a separate checkpoint.

## Target paths

```text
apps/api/                 <- gateway backend
apps/web/                 <- gateway/admin-ui
packages/contracts/       <- control-plane Zod schemas and inferred types
docs/architecture/
docs/operations/
deploy/
package.json
package-lock.json
tsconfig.base.json
```

Do not create additional generic `utils`, `common`, or `shared` packages. Code remains local until at least two consumers require a stable contract.

## Steps

### 1. Capture the compatibility surface

- Record existing routes, response envelopes, headers, settings keys, environment variables, Docker entrypoint behavior, and database tables.
- Add characterization tests for `server.ts` composition gaps: disabled-auth behavior, static SPA fallback, 404 boundaries, middleware order, health/readiness, and graceful app creation.
- Record ADRs for the modular monolith, account/tenant boundary, PostgreSQL outbox/worker, credential separation, and permanent quota commitments.
- Record the current green baseline: backend typecheck/tests and frontend lint/build.

Done when:

- The behavior that must survive mechanical moves is represented by tests or an explicit compatibility table.
- No production behavior has changed.

### 2. Create the root npm workspace

- Add private root `package.json` with workspaces `apps/*` and `packages/*`.
- Move backend and frontend manifests under `apps/api` and `apps/web`.
- Generate one root `package-lock.json`; remove nested lockfiles only after reproducible `npm ci` succeeds from root.
- Add root scripts: `typecheck`, `lint`, `test`, `build`, and scoped workspace variants.
- Add `tsconfig.base.json` for shared strictness; retain environment-specific backend and browser options in app configs.
- Align package names to private workspace names.

Done when:

- Fresh root `npm ci` installs every workspace deterministically.
- Root scripts invoke both applications and contracts without directory-changing shell scripts.
- Lockfile changes are reviewed separately from source moves.

### 3. Perform mechanical source moves

- Move `gateway/src` to `apps/api/src` and `gateway/admin-ui` to `apps/web`.
- Move Docker/Compose support into `deploy/` or update root Docker context consistently.
- Update imports, scripts, build copy paths, workflow path filters, documentation, and AGENTS.md source map.
- Preserve generated-output ignores and never commit `dist`.

Done when:

- The existing tests and builds pass from the new paths.
- The current container serves the same API and `/admin` SPA behavior.
- `git diff --find-renames` shows moves plus only necessary path/config edits.

### 4. Introduce a testable API composition boundary

Split backend startup into:

- `config.ts`: parse injected environment and return immutable config; never call `process.exit` in library code.
- `app.ts`: `createApp(dependencies)` creates and returns Express without connecting, listening, jobs, or process handlers.
- `server.ts`: initialize dependencies, listen, and own signal/error lifecycle.
- `worker.ts`: reserved entrypoint for durable jobs; initially hosts existing jobs behind the same service APIs.
- `platform/db`, `platform/http`, `platform/logging`, and `platform/crypto`: infrastructure adapters.

Pass config, database, audit writer, clock, ID generator, and fetch adapter explicitly where tests need control. Avoid a full dependency-injection framework.

Done when:

- Supertest can test the complete app without importing a module that listens or exits.
- Database initialization and background jobs are not import-time side effects.
- Startup/shutdown tests cover API and worker lifecycle.

### 5. Establish vertical module boundaries

- Move current auth, users, API keys, settings, audit, proxy policy, and routing code into named modules without redesigning behavior.
- Each module exposes a small public index and owns its routes/services/repositories/tests.
- Replace direct cross-module table access gradually with exported application services.
- Keep proxy transport under `modules/routing` or `modules/data-plane`, not in generic middleware.

Done when:

- Module imports follow the dependency direction in the master plan.
- No frontend or backend file imports another module's private repository.
- Circular dependency checks and TypeScript compilation pass.

### 6. Create the contracts workspace

- Start only with control-plane error envelope, authenticated-user shape, route mode, pagination, and health contracts.
- Use Zod at server boundaries and infer TypeScript types for web consumption.
- Do not attempt to model the entire Firecrawl passthrough API.
- Add contract parsing tests and prevent browser bundles from importing Node-only code.

Done when:

- At least one existing API route and frontend caller share the same request/response contract.
- Invalid inputs fail with consistent field errors.

### 7. Add root CI

Replace the disabled deploy-only workflow with a non-deploying CI workflow that runs:

- Root clean install.
- Backend/contracts typecheck and tests.
- Web lint and build.
- API build.
- Docker build without push.
- Dependency review/security scan appropriate to pull requests.

Deployment remains disabled until Phase 8.

Done when:

- CI runs on pull requests and relevant main-branch changes.
- All root verification commands pass on a clean checkout.
- Workflow permissions are least-privilege and no secrets are needed for CI.

### 8. Express 5 compatibility checkpoint

After the mechanical restructure is green:

- Align Express runtime and types.
- Review changed wildcard/path syntax, `req.body`, static handling, and error behavior.
- Upgrade to Express 5 in an isolated dependency change if approved.
- Remove repetitive async try/catch only after rejection behavior is covered.

Done when:

- The full characterization suite passes on Express 5.
- No migration change is mixed with tenant/product behavior.

## Verification

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
docker build -f deploy/Dockerfile .
```

## Risks and rollback

- Large moves obscure behavior changes: commit mechanical moves separately from app-factory and framework changes.
- A single lockfile can resolve different versions: inspect lockfile and run all workspace builds before removing old locks.
- Docker paths are release-critical: build and smoke-test the image before deleting the old context.
