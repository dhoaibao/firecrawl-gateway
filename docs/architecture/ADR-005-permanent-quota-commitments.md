# ADR-005: Permanent quota commitments

- **Status:** Accepted direction
- **Decision:** Do not add quota, billing, or permanent credit commitments in the foundation restructure. Existing upstream credit usage and routing behavior remain observational and configuration-driven.
- **Rationale:** Quota semantics require product, tenant, and billing decisions that are not represented by the current schema.
- **Consequences:** Future quota work needs an explicit contract, persistence model, and migration plan; this phase only preserves existing proxy and credit-usage behavior.
