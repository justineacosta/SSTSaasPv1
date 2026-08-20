# Tenant isolation

> **Status: Designed. Not Implemented.** Layer 1 in Phase 1, layers 2–3 in Phase 3.

Tenant isolation is the control most likely to fail, because it fails silently. A missing
`where` clause produces working code, passing tests, and a data breach. The design assumes
someone will forget, and makes forgetting non-fatal.

## 1. Tenant boundary

The **Organization** is the tenant. Every tenant-owned row carries `organizationId`
directly — not through a join — so that isolation is a single predicate on every table.
`User` is the one global entity; `Membership` binds a user into a tenant.

## 2. Three layers

### Layer 1 — Mandatory scoping in the data client (primary)

Handlers never receive a raw Prisma client. They receive one bound to the request's
organisation by a Prisma client extension that, for every tenant-owned model:

- injects `organizationId` into `where` for `findMany`, `findFirst`, `count`,
  `aggregate`, `groupBy`, `update`, `updateMany`, `delete`, `deleteMany`;
- injects `organizationId` into `data` for `create` and `createMany`;
- rewrites `findUnique` into `findFirst` with the tenant predicate, since `findUnique` by
  ID would otherwise bypass the filter entirely — this is the single easiest mistake to
  make and the extension removes the possibility;
- **throws** if no organisation is present in context.

The unscoped client lives in one module. An ESLint rule forbids importing it outside
`packages/db/migrations`, seeds, and the platform-admin module, and CI fails on violation.

### Layer 2 — PostgreSQL Row-Level Security (defence in depth)

RLS is enabled on every tenant table with a policy on
`current_setting('app.organization_id', true)`, set per transaction by the request
pipeline. The application role is not `BYPASSRLS`.

This catches what layer 1 cannot: hand-written SQL, raw queries for optimised analytics,
future ORM changes, and mistakes in the extension itself. Two independent mechanisms must
both be wrong for a leak to occur.

### Layer 3 — Response serialisation

Responses are built from explicit DTOs, never from raw Prisma models. A relation
accidentally included cannot leak, because the serialiser only emits declared fields. This
also prevents the subtler leak of internal fields — fingerprints, storage keys, internal
IDs of other tenants' referenced rows.

## 3. Isolation beyond the REST API

The REST API is the obvious surface and the one people remember to protect. These are the
ones that get missed:

| Surface | Risk | Control |
|---|---|---|
| **SSE / realtime** | Subscribing to another org's event stream | Connection is bound to an authenticated tenant at handshake; the fan-out filters by that tenant *and* by per-event permission before writing |
| **Object storage** | Guessing an evidence key | Keys prefixed `org/{organizationId}/`; buckets never public; every presign re-authorises server-side; presigned URLs short-lived and single-purpose |
| **Background jobs** | A job executing with the wrong tenant | Workers re-resolve the tenant from the database by resource ID and ignore the payload's claims |
| **Search** | Full-text results crossing tenants | Tenant predicate is applied inside the query, never as a post-filter on results |
| **Reports** | A report embedding another tenant's data | Generation runs under the same tenant-scoped client; download re-authorises |
| **Webhooks** | Delivering org A's event to org B's endpoint | Endpoint and event are matched on `organizationId` at dispatch |
| **Notifications** | Cross-tenant notification | Recipient membership verified at creation and at read |
| **Aggregates / dashboard** | A `COUNT(*)` without a tenant predicate | All analytics go through the scoped client or an RLS-covered raw query; reviewed explicitly |
| **Error messages** | Leaking existence or names | Generic messages; details only in server logs |
| **Exports / CSV** | Bypassing DTO serialisation | Exports use the same DTO layer |

## 4. Test suite (release-blocking)

A shared harness creates two organisations with overlapping-looking data, then, for
**every** tenant-owned resource, asserts that Tenant A operating on Tenant B's ID gets 404
across: read, list, update, delete, evidence download, presigned URL, report download,
search, export, SSE subscription, and webhook delivery.

The harness is table-driven over a resource registry. **Adding a tenant-owned resource
without adding it to the registry fails CI**, so the coverage cannot rot as the product
grows — which is exactly how isolation bugs normally appear: not in the code that was
reviewed for isolation, but in the resource added six months later.

Additional cases: removed member loses access immediately; suspended organisation blocks
all access; API key scoped to org A rejected against org B; a job enqueued for org A that
somehow names org B's resource fails safely.

## 5. Known residual risks

Recorded honestly rather than assumed away.

- **Platform admin break-glass** genuinely can cross tenants. Mitigated by separate
  authentication, mandatory reason, full audit, and owner notification — not eliminated.
- **Shared infrastructure.** One database and one Redis serve all tenants; a database
  compromise is a total compromise. Accepted for the current scale; per-tenant or
  per-region isolation is the enterprise escalation path, and the schema's explicit
  `organizationId` on every row is what would make that migration tractable.
- **Aggregate timing side channels.** Response times may weakly reveal that other tenants
  exist. Judged acceptable.
- **Redis cache keys.** Every cache key is prefixed with the organisation ID; a missing
  prefix would cross tenants. Covered by a key-construction helper that makes the prefix
  non-optional and a lint rule against raw key strings.
