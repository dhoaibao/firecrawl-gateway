# ADR-002: Account and tenant boundary

- **Status:** Accepted
- **Decision:** Treat the existing authenticated user as the current control-plane account boundary. Preserve user ownership on API keys and audit records while leaving tenant/product modeling for a later phase.
- **Rationale:** The current gateway has user-scoped keys and session authentication but no separate tenant table. Introducing one during a mechanical move would change persistence and authorization behavior.
- **Consequences:** New control-plane work must not infer a tenant model from unrelated tables. A future tenant migration must define ownership, authorization, and data migration explicitly.
