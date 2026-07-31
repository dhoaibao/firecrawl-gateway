# ADR-001: Modular monolith workspace

- **Status:** Accepted
- **Decision:** Keep the gateway API, admin web application, and control-plane contracts in one npm-workspace repository. The API remains a single deployable process while source boundaries are represented by `apps/api`, `apps/web`, and `packages/contracts`.
- **Rationale:** This preserves the current operational model while allowing independently testable application composition and shared boundary schemas. New generic `common`, `shared`, or `utils` packages are not introduced.
- **Consequences:** Cross-application contracts must be added deliberately to `packages/contracts`; product behavior is not split into services during the foundation phase.
