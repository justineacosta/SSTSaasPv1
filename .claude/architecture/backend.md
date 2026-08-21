# Backend architecture

> **Status: Partially Implemented (Phase 1).** The application bootstrap, the request-ID and
> security-header middleware, the Zod validation pipe, the global exception filter, the logging
> interceptor, the boot-time route access assertion (§3), the generated OpenAPI document (§7),
> and the `health` module are built and tested (`apps/api`). Every other module in §1 and every
> stage in §3 marked *Not Implemented* below is still Designed only.

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

Order matters and is asserted by a test —
`apps/api/src/app-setup.spec.ts`, which asserts it on the registration path production
actually takes.

The first two stages are registered with `app.use()` in `configureApp`, not through
`MiddlewareConsumer`. A consumer registration resolves its paths under the global prefix and
runs after Nest's body parser, which left every off-prefix path and every body-parse failure
with no request ID and no security headers. Guard stages from Phase 2 onward are Nest guards
and are unaffected; anything that must cover *every* response, routed or not, belongs in
`configureApp`.

| Stage | Mechanism | Status |
|---|---|---|
| Request ID + trace | Middleware; `x-request-id` propagated everywhere including into jobs | Implemented (`traceId` in Phase 4) |
| Security headers | Middleware; [`../security/transport-and-headers.md`](../security/transport-and-headers.md) §2–§3 | Implemented |
| Rate limit | Guard, Redis-backed, every declared scope | Implemented (global `APP_GUARD`) |
| Authenticate | Guard, session cookie or API key -> `Principal` | Not Implemented (Phase 2) |
| Tenant resolve | Guard, membership + org state -> `TenantContext` | Not Implemented (Phase 2) |
| CSRF | Guard, cookie-authenticated unsafe methods only | Not Implemented (Phase 2) |
| Validate | Zod pipe against `packages/contracts` schemas | Implemented; no consumer until Phase 2 |
| Authorize | Guard reading `@RequirePermission` | Decorator implemented and asserted at boot; guard Not Implemented (Phase 2) |
| Entitlement | Guard reading `@RequireEntitlement` | Not Implemented (Phase 10) |
| Handle | Controller -> service | Implemented |
| Serialise | Interceptor, explicit DTO | Not Implemented |
| Errors | Global filter -> shared error envelope | Implemented |
| Audit | Service-level, in the mutation's transaction | Not Implemented (Phase 3) |
| Logging | Interceptor, structured, redacted | Implemented |

A route without an explicit access declaration **fails a startup assertion**. Missing
authorization is a boot crash, not a production discovery.

**Status: Implemented.** The declaration — `@Public()` and `@RequirePermission()`, both keyed
on `ACCESS_METADATA_KEY` — lives in `apps/api/src/common/decorators/access.decorator.ts`. The
assertion that reads it is `assertEveryRouteDeclaresAccess` in
`apps/api/src/common/access-assertion.ts`, called from `main.ts`. It reports **every** offender
in one message rather than the first, so one boot reveals the whole backlog.

Two properties of it are load-bearing and are asserted by tests, because both failure modes are
silent:

- **It runs after an explicit `await app.init()`, not merely "before `listen`".** Nest registers
  no route until `init()` runs, and `listen()` runs it implicitly — so an assertion placed
  immediately before `listen` inspects an empty router and passes without checking anything. The
  assertion therefore refuses to run at all against a router with no routes.
- **It compares its own inventory against Express's router on every boot.** The inventory is
  built from controller metadata (`apps/api/src/common/route-inventory.ts`, which borrows Nest's
  own `RoutePathFactory` so the paths cannot disagree with the ones Nest registered). Metadata is
  exactly what survives when routing breaks, so a route registered outside that metadata, or a
  path assembled differently by a future Nest, is a boot failure rather than a route the check
  quietly never looked at.

The check lands in Phase 1 with one module on purpose. Added in Phase 2 with thirty routes
already written, it would start life with a backlog of offenders and get switched off.

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

**Status: Implemented; the CI diff step itself is Not Implemented (next task).**

- The **path list comes from the running application**, never from a table maintained beside it:
  `generateOpenApiDocument` reads the same route inventory the access assertion checks, so the
  document cannot describe a deleted route or miss a new one. An integration test compares the
  document's paths against Express's own router.
- The **schemas come from Zod**. `@ApiDoc()`
  (`apps/api/src/common/decorators/openapi.decorator.ts`) carries the Zod schema itself, and
  `zod-to-json-schema` converts it with the `openApi3` target. `errorEnvelopeSchema` from
  `packages/contracts` is published once as `components.schemas.ErrorEnvelope` and referenced by
  every route's `default` response, because §5's envelope is part of every route's contract
  whether or not the route says so.
- **`@nestjs/swagger` is deliberately not a dependency.** It does not read Zod, so every route
  would declare its shape twice — once for validation, once for documentation — which is the
  drift this document exists to prevent.
- Each operation publishes its access declaration as `x-sentinel-access`. There is no
  `securitySchemes` entry to point at until Phase 2, and inventing one would describe a control
  that does not exist; publishing the declaration makes an authorization change visible in the
  committed document's diff, which is the review step this section is asking for.
- Regenerate with `pnpm --filter @sentinel/api openapi:generate`, which writes
  `apps/api/openapi.json`. It builds the container but does **not** call `app.init()`, so
  regeneration needs no Postgres, Redis or MinIO — only a valid environment. A test asserts the
  committed file equals what the code generates.
- `/api/v1/openapi.json` is served in **every** environment and is `@Public()`. That is a
  deliberate call: the document describes a public API surface and names no host, no dependency
  and no internal identifier, and a description available only where nobody looks at it goes
  stale.

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
