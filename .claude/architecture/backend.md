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

**A module may legitimately have fewer of those, and one already does.** `auth/` shipped in Phase 2
Task 3 with two services, no controller and no repository: the password and breach-check services
are pure functions of their inputs, and the endpoints that call them arrive in Tasks 8–10. Shipping
a controller before the authentication guard (Task 7) would mean an unguarded route existing for
several tasks, which is why its absence is deliberate rather than incomplete. The list above is what
a module owns *when it has that concern*, not a checklist every directory must satisfy.

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
| CORS | Middleware, third; one configured origin, exact match, credentials ([ADR-0017](../decisions/ADR-0017-cors-allowlist-with-credentials.md)) | **Implemented (Task 7)**. Middleware rather than a guard so a preflight is answered before the rate limiter and the authentication guard, and so the headers reach error responses. **A preflight therefore reaches neither the limiter nor `LoggingInterceptor`**: every unsafe browser request generates one request that no limit counts and no log line records — see below |
| Rate limit | Guard, Redis-backed, every declared scope | Implemented (global `APP_GUARD`) |
| Authenticate | Guard, session cookie or API key -> `Principal` | **Implemented (Task 7)** for the session-cookie half: `AuthenticationGuard`, global `APP_GUARD`, constructs a `UserPrincipal` onto `request.principal`. The API-key half is Not Implemented — no key can be issued in Phase 2 |
| Tenant resolve | Guard, membership + org state -> `TenantContext` | Not Implemented (Phase 2). `TenantContext` is declared in `packages/contracts` as of Task 2; nothing constructs one |
| CSRF | Guard, cookie-authenticated unsafe methods only | **Implemented (Task 7)**: `CsrfGuard`, global `APP_GUARD`, after Authenticate. Governs no cookie-authenticated route yet, because none exists |
| Validate | Zod pipe against `packages/contracts` schemas | Implemented; no consumer until Phase 2 |
| Authorize | Guard reading `@RequirePermission` | Decorator implemented and asserted at boot; **guard still Not Implemented** (Task 12). Task 7 added a third *declaration* arm, `@AuthenticatedOnly()`, which does not move this row: a route naming a permission is authenticated by Task 7's guard and its permission is evaluated by nobody |
| Entitlement | Guard reading `@RequireEntitlement` | Not Implemented (Phase 10) |
| Handle | Controller -> service | Implemented |
| Serialise | Interceptor, explicit DTO | Not Implemented |
| Errors | Global filter -> shared error envelope | Implemented |
| Audit | Service-level, in the mutation's transaction | Not Implemented (Phase 3) |
| Logging | Interceptor, structured, redacted | Implemented |

A route without an explicit access declaration **fails a startup assertion**. Missing
authorization is a boot crash, not a production discovery.

**A preflight `OPTIONS` is unmetered and unlogged.** The CORS stage ends the response
before `next()`, which is the documented intent for the rate limiter and the guards and an
undocumented consequence for the logging interceptor. Measured during the Task 7 review:
three `OPTIONS` in one burst — two preflights and one plain — produced exactly one log line,
the plain one that reached the router. The abuse cost is small (the handler does no I/O),
and the alternative — a credential-less request charging a real rate-limit budget, then
401ing on the authentication guard — is worse. Recorded here because
[`../security/abuse-prevention.md`](../security/abuse-prevention.md) says the limiter is
global "so there is an answer for every endpoint", and this is a request shape with no
answer. It is **not** added to ADR-0017: an accepted ADR is superseded, never edited, and
this is a consequence found after acceptance rather than a change of decision.

**Guard order is the order of the `APP_GUARD` providers in `app.module.ts`, and nothing
else makes it visible** — a reordering is a one-line diff to an array that changes no type
and still runs every guard. `app.module.spec.ts` asserts it: rate limit, authenticate,
CSRF. Rate limiting stays first so an unauthenticated flood carrying a garbage cookie
does not buy a Redis read and a Postgres read each before anything refuses it. The cost of
that order is recorded rather than fixed: `generalSession` keys on
`principalSource: 'authenticated'`, which reads `request.principalId` — a field the limiter
reads before the authentication guard could set it — so that scope is unresolvable and
`generalSession`'s per-principal limit is applied to no request. **Nothing reports it**: the
limiter's `unresolvedWarned` warn is gated on a fail-**closed** class with at least one
resolved scope, and `generalSession` is fail-open with `perPrincipal` as its only scope, so
neither conjunct holds. The line that does fire is at `debug`, and `LOG_LEVEL` defaults to
`info`. Splitting the limiter into an early per-IP stage and a late per-principal one is the
fix, and it is not built.

**Status: Implemented.** The declaration — `@Public()`, `@AuthenticatedOnly()` and
`@RequirePermission()`, all three keyed on `ACCESS_METADATA_KEY` — lives in
`apps/api/src/common/decorators/access.decorator.ts`. Task 7 added the second of those as a
**third arm, not a relaxation**: the assertion still refuses a route that declares nothing,
and `access-assertion.spec.ts` keeps the undeclared-route crash beside the new arm so the
check cannot start passing vacuously because it learned a new word. Proved by booting the
real application with an undeclared route (refused, naming it) and again with the same
route carrying `@AuthenticatedOnly()` (listened) — Task 7's report records both runs. The
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
  built from controller metadata (`apps/api/src/common/route-inventory.ts`), reusing *both*
  halves of what Nest does to a path: its own `RoutePathFactory` for assembly, then the HTTP
  adapter's `normalizePath` — the step that rewrites legacy syntax such as `*` into `{*path}`,
  and whose omission would make a legal `@Get('*')` refuse to boot. Metadata is exactly what
  survives when routing breaks, so a route registered outside that metadata — including one
  registered directly on Express with a non-string path — or a path assembled differently by a
  future Nest, is a boot failure rather than a route the check quietly never looked at. The
  comparison is what makes that guarantee real: nothing here relies on the reproduction being
  correct, only on the two agreeing.

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
