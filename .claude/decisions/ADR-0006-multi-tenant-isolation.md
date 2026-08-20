# ADR-0006 — Shared database, mandatory scoping, RLS as second layer

**Status:** Accepted · **Date:** 2026-08-20

## Context

Tenant isolation is the control most likely to fail, because it fails silently. A missing
`where organizationId` clause compiles, passes review, passes tests, and leaks data. In a
product holding many organisations' unfixed vulnerabilities simultaneously, a single such leak
is worse than a compromise of any one customer.

The design must assume a developer will forget, and make forgetting non-fatal.

## Decision

**Shared database, shared schema**, with `organizationId` on **every** tenant-owned table
directly — never derived through a join — and three independent enforcement layers:

1. **A mandatory tenant-scoped Prisma client** (primary). A client extension injects the tenant
   predicate into every read and write on tenant models, **rewrites `findUnique` into a scoped
   `findFirst`**, and throws if no organisation is in context. Handlers only ever receive this
   client; a lint rule forbids importing the unscoped one outside migrations, seeds, and the
   platform admin module.
2. **PostgreSQL Row-Level Security** (defence in depth), on every tenant table, keyed to a
   per-transaction setting. Catches raw SQL and any bug in layer 1.
3. **Explicit response DTOs** (leak prevention). Responses never serialise raw Prisma models, so
   an accidentally-included relation cannot escape.

Plus a **generated test matrix**: a resource registry drives cross-tenant assertions across
read, list, update, delete, evidence download, presigned URL, report download, search, export,
and SSE. **Adding a tenant-owned resource without registering it fails CI.**

## Alternatives considered

**Schema-per-tenant.** Rejected. Strong isolation, but migrations across thousands of schemas
are operationally brutal, connection pooling degrades, and cross-tenant platform queries become
very hard. Revisit only for a specific enterprise customer with a contractual requirement.

**Database-per-tenant.** Rejected at this stage. The strongest isolation and the highest
operational cost per tenant. The explicit `organizationId` on every row is deliberately what
would make this migration tractable if a large enterprise ever requires it.

**RLS alone.** Rejected as sole control. RLS is excellent but depends on the session variable
being set correctly on every connection; a pooled connection reused without resetting it is a
real failure mode. It is a superb second layer and a fragile only layer.

**Application-layer filtering alone (the common approach).** Rejected. This is precisely the
"someone will forget" case. `findUnique({ where: { id } })` bypassing a tenant filter is the
single most common multi-tenant bug, and it is the one the client extension specifically
eliminates.

## Consequences

**Positive.** Two independent mechanisms must both fail for a leak. Handlers cannot query
another tenant even by mistake. Simple migrations, simple pooling, straightforward platform
analytics. The test matrix cannot rot as the product grows.

**Negative.** One denormalised column on every tenant table. RLS adds a small per-query
overhead. Raw SQL must include the tenant predicate manually, since the extension cannot rewrite
it — a documented, reviewed, tested requirement rather than an unmanaged risk. A database-level
compromise is a total compromise; recorded as an accepted residual risk in
[`../security/tenant-isolation.md`](../security/tenant-isolation.md) §5.

**Neutral.** The non-REST surfaces — SSE, object storage, search, exports, webhooks, background
jobs — need their own isolation reasoning, which is why they are enumerated explicitly in that
document rather than assumed covered by "the API is scoped".
