# ADR-006: Feature-layered Prisma backend

- **Status:** Accepted
- **Decision:** Keep the API as a modular monolith, with each feature exposing HTTP routes/controllers, application services, domain types, and persistence adapters. Prisma is the persistence boundary for PostgreSQL.
- **Decision:** Use separate runtime and operator Prisma clients. Tenant transactions set `app.account_id`; operator transactions assume `firecrawl_gateway_operator` explicitly.
- **Decision:** Keep PostgreSQL-specific SQL only in infrastructure/repository adapters for RLS setup, row locks, `SKIP LOCKED`, advisory locks, and quota ledger atomics.
- **Rationale:** This removes database-client leakage from HTTP code without weakening the existing tenant and operator security model. Prisma schema modeling provides the fresh database source of truth while SQL preserves PostgreSQL security features Prisma does not model.
- **Consequences:** A fresh database is bootstrapped with the checked-in Prisma baseline via `prisma migrate deploy`, followed by `prisma/security.sql`; existing databases use an explicit reviewed baseline procedure. Prisma-generated types stay inside persistence adapters; domain and HTTP contracts use explicit application types.
