# ADR-004: Credential separation

- **Status:** Accepted
- **Decision:** Keep deployment credentials in environment configuration, store virtual API-key hashes and encrypted upstream key values in PostgreSQL, and expose plaintext virtual keys only at creation.
- **Rationale:** This matches the existing security model and prevents the workspace restructure from broadening credential exposure.
- **Consequences:** Contracts and logs must never include passwords, session secrets, encryption keys, or plaintext API keys. Runtime examples belong in `.env.example` only.
