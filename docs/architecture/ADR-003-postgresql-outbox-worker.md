# ADR-003: PostgreSQL outbox and worker direction

- **Status:** Accepted direction
- **Decision:** Keep PostgreSQL as the source of truth for control-plane state and use `apps/api/src/worker-main.ts` with `WorkerAppModule` as the dedicated durable-job entrypoint. Native email outbox delivery, audit retention, quota maintenance, and worker heartbeat lifecycle belong to that process.
- **Rationale:** A dedicated Nest application context makes lifecycle ownership explicit without introducing a queue or second deployable service.
- **Consequences:** Background work must not be started by importing the API module. Email delivery preserves encrypted payloads, retry/dead-letter transitions, and provider idempotency.
