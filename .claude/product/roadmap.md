# Roadmap and current status

**This is the authoritative answer to "what actually works?"** Every other document
describes design. This one describes reality. It is updated at the end of every phase, and
a status is only raised after the functionality has been run and verified — not after the
code was written.

Status vocabulary (specification §79): **Implemented** / **Partially Implemented** /
**Not Implemented** / **Blocked**.

## Current state — 2026-08-20

| Phase | Scope | Status |
|---|---|---|
| **0** | Repository audit, architecture, documentation foundation | **Implemented** |
| 1 | Production foundation | **Partially Implemented** |
| 2 | Identity | **Not Implemented** |
| 3 | SaaS core | **Not Implemented** |
| 4 | Execution platform | **Not Implemented** |
| 5 | Web security engine | **Not Implemented** |
| 6 | API security engine | **Not Implemented** |
| 7 | Pentest workspace | **Not Implemented** |
| 8 | Reports | **Not Implemented** |
| 9 | Integrations | **Not Implemented** |
| 10 | Billing | **Not Implemented** |
| 11 | Enterprise | **Not Implemented** |
| 12 | Additional engines | **Not Implemented** |

**Five Phase 1 packages and the API skeleton exist and are verified working**, per the
honesty rule in `CLAUDE.md` (run and verified, not just written): `packages/config` (validated
env loading), `packages/observability` (structured logging with redaction),
`packages/contracts` (error envelope, pagination, IDs, permission matrix), `packages/storage`
(S3-compatible adapter with mandatory tenant key prefixes), and `packages/db` (Prisma schema,
migrations, the mandatory tenant-scoped client, and PostgreSQL row-level security — the
two-layer tenant isolation control the whole roadmap depends on, covered by 40+ integration
tests and 20+ unit tests against a real Postgres 16).

**`apps/api` now boots.** A NestJS application with the request-ID middleware, the
security-header and CSP middleware, the global error-envelope filter, the structured logging
interceptor, the Zod validation pipe, the `@Public()`/`@RequirePermission()` access
decorators, and a `health` module answering `/health/live`, `/health/ready` and
`/health/detailed` against the live Postgres, Redis and MinIO stack. It has **no
authentication and no business endpoint**: the only routes are the health probes and the
OpenAPI document.

The boot-time assertion that every route declares its access is now built: a route declaring
neither `@Public()` nor `@RequirePermission()` refuses startup with an error naming every
offender, and the inventory it checks is cross-checked against Express's own router on each
boot so it cannot pass by inspecting nothing. `@Public()` is therefore load-bearing today.
**`@RequirePermission()` is still metadata no guard reads** — the authorization guard is
Phase 2 — so declaring a permission records an intention, it does not enforce one.

The OpenAPI document is generated from the route inventory and the Zod contracts, served at
`/api/v1/openapi.json`, and committed as `apps/api/openapi.json`; a test asserts the committed
file is byte-identical to what the code generates. The CI diff of that file arrives in Task 14.

Rate limiting is built and globally registered — a Redis sliding window over the table in
`security/abuse-prevention.md` §1 — but it limits **nothing today**, and that distinction
matters more than the checkmark. No route carries any limit class: the only routes that exist
are the health probes, and liveness is deliberately exempt from the limiter so that it depends
on no backing service. What Phase 1 delivers
is a control that is correct and tested in advance of the endpoints it will govern, not a
control that is currently governing anything.

There is no `apps/web`, nothing is deployed, and no request reaches this code from outside a
test or a developer's own machine — so Phase 1 is Partially Implemented, not Implemented.
Nothing in this product runs, scans, stores, bills, or authenticates for an actual user
today.

### Blocked items

| Item | Blocker | Owner |
|---|---|---|
| Go worker engines | **Go toolchain not installed**; deferred by [ADR-0010](../decisions/ADR-0010-engine-contract.md) | Operator, if Go is wanted |
| Terraform IaC execution | **Terraform not installed**; Phase 11 anyway | Operator |

## Phase detail and exit criteria

A phase is complete only when its exit criteria are demonstrably met.

### Phase 1 — Production foundation
pnpm + Turborepo monorepo; TypeScript strict; ESLint/Prettier; `packages/config` with
validated env; structured logging with redaction; `packages/db` with Prisma and the
tenant-scoped client; Docker Compose (Postgres, Redis, MinIO, Mailpit); storage adapter;
rate limiting; security headers and CSP; base design system; GitHub Actions running
install → lint → typecheck → test → build; `.env.example`.

*Exit:* `pnpm install && pnpm build && pnpm test` passes from a clean clone; the compose
stack starts; a migration applies; CI is green.

#### Where Phase 1 stopped — read this before resuming

Phase 1 is being executed as 16 tasks from
`docs/superpowers/plans/2026-08-20-phase-1-foundation.md`, subagent-driven: a fresh implementer
per task, then a separate adversarial reviewer, then scoped re-reviews per fix round.

**Tasks 1–11 are complete.** 1 workspace and CI · 2 `packages/config` · 3
`packages/observability` · 4 compose stack, schema, prefixed UUIDv7 IDs, first migration · 5
`packages/contracts` · 6 tenant-scoped Prisma client and RLS · 7 seed · 8 `packages/storage` ·
9 `apps/api` bootstrap · 10 rate limiting · 11 route-access assertion and OpenAPI.

**Tasks 12–16 remain:** 12 `packages/ui` · 13 `apps/web` · 14 CI checks (OpenAPI diff,
tenant-registry completeness) · 15 the two reusable skills · 16 ADRs, documentation, and the
full exit-criteria verification pass.

The execution ledger — every ruling with its cost if wrong, every review finding, per-task
briefs and reports, and the review diffs — lives in
`.superpowers/sdd/2026-08-20-phase-1-foundation/`. **That directory is gitignored and exists
only on the machine that built it.** `progress.md` is the file to read first; it ends with the
current pause state and the carry-forward rulings for Tasks 11–16.

Known outstanding, none of it blocking Task 12:

- Task 10's fourth fix round has not itself been reviewed. Recommendation on file: fold it into
  the whole-branch review rather than spend a fifth round.
- A short list of deferred residuals (Redis `EVALSHA`, `maxmemory-policy`, `pnpm format:check`
  not wired into CI, dead `packages/config/tsconfig/*` presets, a missing root `dev` script) is
  recorded in the ledger and assigned to Task 14 or Task 16.

### Phase 2 — Identity
Registration, email verification, login/logout, Argon2id, sessions, CSRF, password reset,
TOTP MFA with recovery codes, organisations, memberships, system roles and permissions,
permission guards, invitations, organisation switching, `/settings/security`.

*Exit:* the full authentication journey passes E2E; the authorization matrix test passes for
every existing endpoint; sessions revoke immediately.

### Phase 3 — SaaS core
Projects, assets, **asset ownership verification**, scope and scope rules with the
evaluation engine, the **global deny list**, tags, search, notifications, the append-only
audit log.

*Exit:* an unverified asset cannot be scheduled; scope evaluation passes its table-driven
suite; the cross-tenant isolation matrix passes for every resource; audit events are written
transactionally and cannot be updated or deleted.

### Phase 4 — Execution platform
BullMQ queues, worker orchestration, container isolation, job lifecycle with retry/timeout/
cancellation, worker-side re-validation, SSRF-guarded HTTP client, progress, SSE realtime,
worker health and metrics.

*Exit:* a scan runs end to end against a controlled local target; cancellation stops it;
timeout is enforced; an engine container provably cannot reach the database, Redis, storage,
or metadata endpoints; scope narrowed after enqueue is refused by the worker.

### Phase 5 — Web security engine
Real checks (security headers, TLS, cookies, CORS, information disclosure, open redirect,
technology fingerprinting, and further checks per
[`../scanners/architecture.md`](../scanners/architecture.md)); normalisation; verification;
fingerprinting and deduplication; evidence capture and storage; risk scoring; findings UI.

*Exit:* scanning a deliberately vulnerable local target produces true findings with real
evidence; a rescan deduplicates rather than duplicating; no fabricated results anywhere.

### Phase 6 — API security engine
OpenAPI/Swagger import, endpoint and parameter discovery, authenticated scanning, BOLA/IDOR
workflows, injection, SSRF, rate-limit checks, API inventory.

### Phase 7 — Pentest workspace
Engagements, engagement scope, methodology and test cases, manual findings, evidence upload,
assignment, comments, retests with `PASSED`/`FAILED`/`INCONCLUSIVE`, timeline.

### Phase 8 — Reports
Technical, executive, and retest reports generated from live data as real downloadable PDF
and HTML, queued and stored in object storage with authorised download.

### Phase 9 — Integrations
Outbound webhooks with signing, retry, backoff and delivery logs; GitHub, Jira, Slack;
integration framework decoupled from domain logic.

### Phase 10 — Billing
Stripe checkout, subscription lifecycle, webhook-driven state, entitlement projection,
usage metering, invoices, upgrade/downgrade/cancel, payment failure handling.

### Phase 11 — Enterprise
SAML/OIDC SSO, SCIM, custom roles, advanced audit, configurable retention, Terraform IaC,
platform administration.

### Phase 12 — Additional engines
SAST, dependency, container, cloud, network, mobile, LLM, performance, accessibility —
each behind the same engine contract.

## MVP definition

The smallest thing worth charging for is **Phases 1–5 plus 8**: a customer can register,
verify, create an organisation and project, register and verify an asset, define scope, run
a real web security scan, review real findings with real evidence, and generate a real
report. Phases 6, 7, 9, and 10 make it a business; 11 and 12 make it an enterprise product.
