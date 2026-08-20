# ADR-0002 — PostgreSQL and Prisma

**Status:** Accepted · **Date:** 2026-08-20

## Context

We need a primary datastore for a strongly relational, multi-tenant domain, holding data
classified up to Restricted. Requirements: transactional integrity across many related tables,
enforced referential integrity, full-text search without a second system initially, JSON for
engine configuration and audit metadata, row-level security as a defence-in-depth layer for
tenant isolation, and mature managed hosting with point-in-time recovery.

## Decision

**PostgreSQL 16** as the system of record. **Prisma** as the ORM, with raw parameterised SQL as
a reviewed escape hatch for queries Prisma cannot express efficiently.

## Alternatives considered

**MySQL/MariaDB.** Rejected. Weaker JSON support, no native row-level security, less capable
full-text search, and no partial indexes — which we rely on heavily for status-filtered finding
queries.

**MongoDB.** Rejected outright. The domain is relational, and we need transactions across
tables plus enforced foreign keys. Multi-tenant isolation without referential integrity would
rest entirely on application code, which contradicts the security posture in
[`../security/tenant-isolation.md`](../security/tenant-isolation.md).

**TypeORM / Drizzle / Kysely instead of Prisma.** Considered seriously. Drizzle and Kysely give
better raw SQL ergonomics and lighter runtime. Prisma was chosen for its migration tooling,
generated type safety, and — decisively — **client extensions**, which let us implement
mandatory tenant scoping as a mechanical property of the client rather than a convention every
developer must remember. That single capability is worth more to this product than the
performance ergonomics we give up.

**Search: OpenSearch from day one.** Rejected as premature. Postgres full-text with GIN indexes
serves the expected scale, and search is designed behind an interface so it can be swapped
later ([`../api/filtering.md`](../api/filtering.md)).

## Consequences

**Positive.** Transactions, foreign keys, and check constraints enforce integrity in the
database rather than in application code. RLS gives a second, independent tenant-isolation
layer. Partial and GIN indexes serve our actual query shapes. Prisma's client extension makes
tenant scoping structural. Managed Postgres with PITR is available from every major provider.

**Negative.** Prisma generates suboptimal SQL for complex aggregates; mitigated by the raw SQL
escape hatch, which carries an explicit requirement to include the tenant predicate manually
since the extension cannot rewrite raw queries. Prisma's connection handling requires attention
to pool sizing during rolling deploys. The Prisma engine adds startup overhead and image size.

**Neutral.** If search outgrows Postgres, OpenSearch is added behind the existing interface. If
analytics queries begin to affect transactional performance, a read replica is added before any
architectural change is considered.
