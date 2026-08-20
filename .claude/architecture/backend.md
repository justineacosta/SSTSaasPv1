# Backend architecture

> **Status: Partially Implemented (Phase 1).** The application bootstrap, the request-ID and
> security-header middleware, the Zod validation pipe, the global exception filter, the logging
> interceptor, and the `health` module are built and tested (`apps/api`). Every other module in
> §1 and every stage in §3 marked *Not Implemented* below is still Designed only.

NestJS modular monolith. One deployable, many bounded modules, explicit dependencies.

## 1. Module structure

```
src/
  main.ts, app.module.ts
  common/          guards, interceptors, filters, decorators, pipes
  infrastructure/  prisma, redis, queue, storage, mail, stripe clients
  modules/
    auth/  users/  organizations/  memberships/  invitations/  roles/
    projects/  assets/  scope/  tags/
    scans/  engines/  jobs/
    findings/  evidence/  risk/
    engagements/  test-cases/  retests/
    reports/  notifications/  search/  audit/
    api-keys/  webhooks/  integrations/
    billing/  entitlements/  usage/
    platform-admin/  feature-flags/  health/
```

Each module owns `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `dto/`, and tests.

**Dependency rules**, enforced by an import-boundary lint rule so they cannot erode:
modules depend on `common` and `infrastructure` freely; cross-module dependencies go through
the other module's **service**, never its repository; no circular dependencies; the domain
layer does not import HTTP or Prisma types.

## 2. Layers

**Controller** — HTTP only. Validates input, delegates, serialises a DTO. No business logic,
no Prisma. **Service** — business logic, transactions, orchestration, events, audit. Framework
agnostic and unit-testable. **Repository** — data access through the tenant-scoped client.
Every method takes a `TenantContext`.

The rule that keeps this honest: a service must be testable without HTTP, and a domain rule
must be testable without a database. Where that becomes hard, the layering has slipped.

## 3. Cross-cutting pipeline

Order matters and is asserted by a test.

| Stage | Mechanism | Status |
|---|---|---|
| Request ID + trace | Middleware; `x-request-id` propagated everywhere including into jobs | Implemented (`traceId` in Phase 4) |
| Security headers | Middleware; [`../security/transport-and-headers.md`](../security/transport-and-headers.md) §2–§3 | Implemented |
| Rate limit | Guard, Redis-backed, per IP then per principal | Not Implemented |
| Authenticate | Guard, session cookie or API key -> `Principal` | Not Implemented (Phase 2) |
| Tenant resolve | Guard, membership + org state -> `TenantContext` | Not Implemented (Phase 2) |
| CSRF | Guard, cookie-authenticated unsafe methods only | Not Implemented (Phase 2) |
| Validate | Zod pipe against `packages/contracts` schemas | Implemented; no consumer until Phase 2 |
| Authorize | Guard reading `@RequirePermission` | Decorator implemented, guard Not Implemented |
| Entitlement | Guard reading `@RequireEntitlement` | Not Implemented (Phase 10) |
| Handle | Controller -> service | Implemented |
| Serialise | Interceptor, explicit DTO | Not Implemented |
| Errors | Global filter -> shared error envelope | Implemented |
| Audit | Service-level, in the mutation's transaction | Not Implemented (Phase 3) |
| Logging | Interceptor, structured, redacted | Implemented |

A route without an explicit access declaration **fails a startup assertion**. Missing
authorization is a boot crash, not a production discovery. The declaration itself —
`@Public()` and `@RequirePermission()`, both keyed on `ACCESS_METADATA_KEY` — lives in
`apps/api/src/common/decorators/access.decorator.ts`. **The startup assertion that reads it
does not exist yet**, so today an undeclared route is simply undeclared; the assertion is the
next task's work.

## 4. Transactions

Any multi-write operation runs in one transaction, and the audit event is part of it. If the
change rolls back, so does the record of it.

Side effects — queue enqueue, email, webhook dispatch, realtime publish — happen **after
commit**, never inside the transaction. A job enqueued inside a transaction that later rolls
back is a worker processing something that does not exist, which is a class of bug worth
designing out entirely.

## 5. Errors

One envelope, always:

```jsonc
{ "error": { "code": "SCOPE_VIOLATION",
             "message": "Target is not permitted by the project scope.",
             "details": { "target": "...", "rule": "DENY /admin" },
             "requestId": "req_01J..." } }
```

Typed domain exceptions map to status codes in the global filter. Internal errors log fully
server-side and return a generic message plus the request ID. Stack traces never reach a
client. See [`../api/errors.md`](../api/errors.md).

## 6. Validation

Zod schemas in `packages/contracts` are shared with the frontend, so client and server
validate identically and cannot drift. Types are inferred from schemas — the schema is the
source of truth, never a hand-written interface alongside it. Every external input is
validated: bodies, queries, params, headers, webhook payloads, and engine output.

## 7. OpenAPI

Generated from the Zod contracts and decorators, published at `/api/v1/openapi.json`,
committed to the repository, and **diffed in CI** so an unintended contract change is caught
in review rather than by a customer.

## 8. Health

`/health/live` (process up), `/health/ready` (database, Redis, storage reachable),
`/health/detailed` (authenticated: queue depth, worker heartbeats, migration state).
Readiness gates deployment; liveness restarts a wedged process.

**Status: Implemented, with `/health/detailed` deliberately reduced.** All three routes are
excluded from the `/api` global prefix and are version-neutral, so a probe URL does not move
when the API version does. `/health/ready` returns 503 carrying a per-dependency verdict in
the shared error envelope, and never the driver's error text. `/health/detailed` currently
returns readiness plus a per-probe latency and nothing else: the queue, worker-heartbeat and
migration-state fields are authenticated-only per
[`../operations/monitoring.md`](../operations/monitoring.md) §5, authentication does not exist
until Phase 2, and shipping an operator payload behind a decorator that no guard reads would
be an unauthenticated infrastructure map. Those fields arrive with the guard.

## 9. Performance

Every list endpoint paginates (cursor by default, offset only where a jump-to-page UI needs
it). Hot paths assert query counts in integration tests to catch N+1 regressions. Dashboard
aggregates are cached in Redis with tenant-prefixed keys and explicit invalidation on write.
Expensive work — reports, exports, bulk operations — is queued, never handled inline.
