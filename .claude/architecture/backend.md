# Backend architecture

> **Status: Designed. Not Implemented.** Phase 1 onward.

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

| Stage | Mechanism |
|---|---|
| Request ID + trace | Middleware; `x-request-id` propagated everywhere including into jobs |
| Rate limit | Guard, Redis-backed, per IP then per principal |
| Authenticate | Guard, session cookie or API key -> `Principal` |
| Tenant resolve | Guard, membership + org state -> `TenantContext` |
| CSRF | Guard, cookie-authenticated unsafe methods only |
| Validate | Zod pipe against `packages/contracts` schemas |
| Authorize | Guard reading `@RequirePermission` |
| Entitlement | Guard reading `@RequireEntitlement` |
| Handle | Controller -> service |
| Serialise | Interceptor, explicit DTO |
| Errors | Global filter -> shared error envelope |
| Audit | Service-level, in the mutation's transaction |
| Logging | Interceptor, structured, redacted |

A route without an explicit access declaration **fails a startup assertion**. Missing
authorization is a boot crash, not a production discovery.

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

## 9. Performance

Every list endpoint paginates (cursor by default, offset only where a jump-to-page UI needs
it). Hot paths assert query counts in integration tests to catch N+1 regressions. Dashboard
aggregates are cached in Redis with tenant-prefixed keys and explicit invalidation on write.
Expensive work — reports, exports, bulk operations — is queued, never handled inline.
