# ADR-003: PostgreSQL outbox and worker direction

- **Status:** Accepted direction
- **Decision:** Keep PostgreSQL as the source of truth for control-plane state and reserve `apps/api/src/worker.ts` as the durable-job entrypoint. Existing inactivity jobs continue to run behind the same service APIs during this phase.
- **Rationale:** A worker boundary makes lifecycle ownership explicit without introducing a queue, migration, or second deployable service before the current behavior is characterized.
- **Consequences:** Background work must not be started by importing `app.ts`. A later outbox implementation must be additive and preserve retry/idempotency semantics.
