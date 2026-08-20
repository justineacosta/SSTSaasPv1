# Phase 1 — Production foundation: design

**Date:** 2026-08-20
**Status:** Approved, not implemented
**Branch:** `feat/phase-1-foundation`
**Supersedes:** nothing. Extends the Phase 0 documentation tree in `.claude/`.

---

## 1. Purpose

Phase 1 turns an empty repository into a workspace that builds, tests, lints, boots, connects
to its backing services, and enforces tenant isolation at the data layer. It ships no product
features. Its value is that every phase after it inherits a foundation whose guarantees have
been run rather than described.

The authoritative scope is [`.claude/product/roadmap.md`](../../../.claude/product/roadmap.md)
§ "Phase 1 — Production foundation". This document is how that scope gets built.

### Exit criteria (from the roadmap, unchanged)

1. `pnpm install && pnpm build && pnpm test` passes from a clean clone.
2. The Docker Compose stack starts and reports healthy.
3. A migration applies against that stack.
4. CI is green.

A fifth criterion is added here because Phase 1 owns the control it establishes:

5. The tenant-isolation harness runs against a real Postgres and proves that Tenant A cannot
   read, update, or delete Tenant B's rows — through the client extension *and*, independently,
   through RLS when the extension is bypassed.

---

## 2. Context established before this document

Phase 0 settled the stack, the topology, the security model, the API conventions, the schema
design, and the design system. None of that is re-decided here. The documents that constrain
this build most directly:

| Document | Constrains |
|---|---|
| [`architecture/backend.md`](../../../.claude/architecture/backend.md) | Module structure, the cross-cutting pipeline order, layering |
| [`architecture/database.md`](../../../.claude/architecture/database.md) | Schema conventions, indexes, integrity, isolation at the data layer |
| [`architecture/storage.md`](../../../.claude/architecture/storage.md) | The storage adapter interface and key structure |
| [`security/tenant-isolation.md`](../../../.claude/security/tenant-isolation.md) | The three isolation layers and the resource registry |
| [`security/transport-and-headers.md`](../../../.claude/security/transport-and-headers.md) | Headers, CSP, cookies, CORS |
| [`security/abuse-prevention.md`](../../../.claude/security/abuse-prevention.md) | Rate-limit classes and fail-open/fail-closed behaviour |
| [`api/errors.md`](../../../.claude/api/errors.md) | The error envelope and the code union |
| [`api/conventions.md`](../../../.claude/api/conventions.md) | URLs, status codes, ID opacity, versioning |
| [`ui-ux/design-system.md`](../../../.claude/ui-ux/design-system.md) | Tokens, type scale, colour, density, motion |
| [`development/coding-standards.md`](../../../.claude/development/coding-standards.md) | TypeScript settings and the lint-enforced rules |
| [`development/testing.md`](../../../.claude/development/testing.md) | Test layers and what must be tested |
| [`product/permissions.md`](../../../.claude/product/permissions.md) | The role/permission matrix seeded in Phase 1 |

### Decisions taken at the start of this phase

| # | Decision | Rationale |
|---|---|---|
| D1 | Schema depth: **identity and tenancy tables** | Enough to build *and prove* the tenant-scoped client and RLS. Phase 2 adds auth logic to a schema that already exists, rather than inventing schema and behaviour simultaneously. |
| D2 | Branch: **`feat/phase-1-foundation`**, cut from the Phase 0 commit; Phase 0 merges to `main` separately | Keeps a large code phase out of a docs branch, per `coding-standards.md` §9. Phase 0's commit is an ancestor, so either merge order resolves cleanly. |
| D3 | Two reusable skills: **`sentinel-phase`**, **`sentinel-verify`** | Encode the resuming-work protocol and the honesty rule as executable process, usable from Phase 1 through 12. |
| D4 | Runtime: **pin Node 26**, `engines.node: ">=22"` | Host is v26.7.0; Node 26 reaches LTS in October 2026, before this product serves traffic. Zero drift between the developer machine and CI. Recorded as ADR-0012 with an explicit revisit trigger. |
| D5 | Build order: **thin vertical slice, then thicken** | CI is green from the first commit and stays green. Every layer arrives with its tests, so no status is ever claimed ahead of evidence. |

### Environment facts verified on 2026-08-20

Verified by direct invocation, not assumed:

```
node    v26.7.0        npm 11.19.0        pnpm 11.5.0
python  3.14.5         gh 2.93.0
docker  29.7.2 (Docker Desktop)   docker compose v5.4.0   daemon RUNNING
go      not installed  terraform  not installed
```

**The Docker daemon is now running.** `repository-audit.md` §3 and `roadmap.md` both record it
as down; that was true at audit time and is not true now. Both documents are corrected as part
of this phase. This clears the single blocking prerequisite for exit criteria 2, 3, and 5.

Go and Terraform remain absent. Neither is a Phase 1 dependency — Go engines are deferred by
ADR-0010, Terraform by Phase 11.

---

## 3. Deliverables

### 3.1 Workspace and tooling

```
package.json            private root; packageManager pnpm@11.5.0; engines.node ">=22"
pnpm-workspace.yaml     apps/*, packages/*
turbo.json              build, lint, typecheck, test, test:integration pipelines
.nvmrc                  26
tsconfig.base.json      strict + noUncheckedIndexedAccess + noImplicitOverride
                        + exactOptionalPropertyTypes + noFallthroughCasesInSwitch
eslint.config.js        flat config, type-aware, workspace-wide
.prettierrc             + .prettierignore
vitest.workspace.ts     unit and integration projects
.env.example            every variable, safe placeholder, comment saying what it is for
```

Root scripts implement the contract already published in
[`development/setup.md`](../../../.claude/development/setup.md) §Commands. Scripts whose
subject does not exist yet in Phase 1 — `dev:worker`, `test:e2e` beyond the smoke spec — are
**omitted rather than stubbed**, because a script that exits 0 without doing anything is a
false claim of capability.

### 3.2 `packages/config`

The only module permitted to read `process.env`.

- Zod env schema, split into shared / api / web / worker segments so each app validates only
  what it needs and an app cannot silently depend on another's variable.
- `loadEnv()` throws on the first failure with the offending variable named, at boot, per
  [`operations/environments.md`](../../../.claude/operations/environments.md) §3.
- `APP_ENV` (`development` | `test` | `staging` | `production`) distinct from `NODE_ENV`.
- Shared `tsconfig` presets: `base`, `library`, `nextjs`, `nest`.
- Shared ESLint presets: `base`, `react`, `node`.

### 3.3 `packages/observability`

- Pino, structured JSON, one logger factory per service name.
- **Structural redaction**: a key-name denylist (`password`, `token`, `secret`, `key`,
  `authorization`, `cookie`, `apiKey`, `mfaSecret`) applied to object keys before
  serialisation, plus a value-shape heuristic as a backstop. Not a regex over the rendered
  string — [`operations/monitoring.md`](../../../.claude/operations/monitoring.md) §2 is
  explicit that the regex approach is insufficient.
- `AsyncLocalStorage` request context carrying `requestId`, `traceId`, `organizationId`,
  `userId`, injected into every log line automatically.
- Development uses `pino-pretty`; test is silent unless the test fails; production emits JSON.
- The redaction serialiser is exported standalone so Phase 11 can reuse it for Sentry's
  `beforeSend` without reimplementation.

**Not in Phase 1:** OpenTelemetry tracing and metrics (Phase 4), Sentry (Phase 11).

### 3.4 `packages/contracts`

Small by design; it grows one slice per phase.

- `error-codes.ts` — the complete union from [`api/errors.md`](../../../.claude/api/errors.md)
  §3, as a `const` object plus inferred type.
- `error-envelope.ts` — the envelope schema, including the `VALIDATION_ERROR` field-error shape
  with dotted/bracketed `path`.
- `pagination.ts` — the `{ data, pagination, meta }` collection envelope.
- `ids.ts` — branded ID schemas and the prefix registry.
- `permissions.ts` — **every permission string and the full system-role matrix** from
  [`product/permissions.md`](../../../.claude/product/permissions.md). That document names this
  file as its machine-readable source of truth and requires a test asserting the two agree;
  that test is written in Phase 1.

### 3.5 `packages/db` — the load-bearing package

**Schema.** Identity and tenancy only:

`Organization`, `User`, `Membership`, `Session`, `Credential`, `Role`, `Permission`,
`RolePermission`, `Invitation`, `AuditEvent`, with their enums.

Conventions applied throughout, per
[`architecture/database.md`](../../../.claude/architecture/database.md) §1 and §5: `TEXT`
primary keys generated in application code; `createdAt`/`updatedAt` as `timestamptz`;
`organizationId` **directly** on every tenant-owned table with a leading index; foreign keys
with deliberate `ON DELETE`; the unique constraints named in §5 that apply to these tables.

`User` is global. `Membership` is what makes a user a tenant participant, which is why
authorization is always `(user, organization, permission)`.

**Identifiers.** Application-generated UUIDv7, rendered as prefixed opaque strings
(`org_01J8XK2P9V3QWERTY`). This reconciles `database.md` §1 ("UUIDv7, generated in application
code") with `api/conventions.md` §1 ("opaque prefixed strings; clients must not parse them").
The 128-bit UUIDv7 is encoded to 26-character Crockford base32 and prefixed per entity type.
Time-ordered for index locality, non-sequential to the eye, self-describing in logs. Recorded
as **ADR-0011**.

**Tenant-scoped client.** A Prisma `$extends` client extension that, for every tenant-owned
model:

- injects `organizationId` into `where` for `findMany`, `findFirst`, `count`, `aggregate`,
  `groupBy`, `update`, `updateMany`, `delete`, `deleteMany`;
- injects `organizationId` into `data` for `create` and `createMany`;
- **rewrites `findUnique` into `findFirst` with the tenant predicate** — the single most
  important line in the package, because `findUnique({ where: { id } })` otherwise bypasses
  isolation entirely;
- **throws** when no organisation is present in context.

The unscoped client is exported from exactly one module, and the ESLint rule forbidding its
import outside migrations, seeds, and platform admin is written in the same change.

**RLS.** A hand-written migration that enables row-level security on every tenant table with a
policy on `current_setting('app.organization_id', true)`, and creates a non-`BYPASSRLS`
application role. The request pipeline sets the setting per transaction. Two independent
mechanisms must both be wrong for a leak to occur — ADR-0006.

**Resource registry.** `tenant-resources.ts`: the table-driven list the cross-tenant harness
walks. Built now, in Phase 1, because
[`development/migrations.md`](../../../.claude/development/migrations.md) §5 makes registration
a precondition for every future tenant table, and a registry introduced later starts with a
backlog of unregistered tables.

**Seed.** Reference data only, and only what has a table:

- The 7 system roles: `OWNER`, `ADMIN`, `SECURITY_LEAD`, `MEMBER`, `VIEWER`, `AUDITOR`, `GUEST`.
- Every permission in `packages/contracts/src/permissions.ts`.
- The `RolePermission` grants matching the matrix.

CWE catalogue, OWASP categories, plan definitions, and the engine registry are **deferred to
the phases that create their tables**. No fake organisations, users, or findings — ever.

**Tests** (Vitest + Testcontainers, real Postgres 16):

| Assertion | Layer |
|---|---|
| `organizationId` injected on every listed operation | Extension |
| `findUnique` rewritten to a scoped `findFirst` | Extension |
| Throws when context is absent | Extension |
| Tenant A gets zero rows / 404 for every registered resource of Tenant B | Harness |
| A raw query bypassing the extension is still blocked | RLS |
| The application role is not `BYPASSRLS` | RLS |
| Seed is idempotent — running twice changes nothing | Seed |
| `permissions.ts` matches the `permissions.md` table exactly | Contracts |
| Generated IDs sort chronologically and are unique under concurrency | IDs |

### 3.6 `packages/storage` — a documented deviation

[`development/folder-structure.md`](../../../.claude/development/folder-structure.md) places the
storage adapter at `apps/api/src/infrastructure/storage`. Workers require it from Phase 5, and
no app may import another app. The adapter therefore has to be a package.

`packages/storage` implements the interface in
[`architecture/storage.md`](../../../.claude/architecture/storage.md) §4 exactly — `put`, `get`,
`head`, `delete`, `presignGet`, `presignPut`, `list` — over an S3-compatible client, with:

- key construction helpers that make the `org/{organizationId}/` prefix **non-optional**, so a
  key cannot be built without a tenant;
- SHA-256 computed at upload;
- no S3 SDK type exposed to application code.

`folder-structure.md` and `architecture/overview.md` §3 are corrected in the same commit, per
the documentation rule in `CLAUDE.md`.

Buckets `evidence`, `reports`, `uploads`, `exports` are created by the compose stack's MinIO
init step. Tests run against MinIO in Testcontainers — never a mock, because presign semantics
and content-type handling are precisely what a mock hides.

**Not in Phase 1:** lifecycle rules, cross-region replication, the reconciliation job.

### 3.7 `apps/api`

The complete cross-cutting pipeline from
[`architecture/backend.md`](../../../.claude/architecture/backend.md) §3, with exactly one
domain module behind it.

```
common/
  middleware/    request-id, security-headers + CSP nonce
  guards/        rate-limit  (auth, tenant, csrf, authz, entitlement: Phase 2+)
  pipes/         zod-validation
  interceptors/  logging, serialisation
  filters/       global exception -> error envelope
  decorators/    @Public, @RequirePermission (declared now, enforced Phase 2)
infrastructure/
  prisma/        tenant client provider, request-scoped
  redis/         client + health
  storage/       thin wiring over packages/storage
  config/        wiring over packages/config
modules/
  health/        /health/live, /health/ready, /health/detailed
```

**Pipeline order is asserted by a test**, because the order is a security property: tenant
resolution must precede authorization so a permission is always evaluated against a specific
organisation. The Phase 2 slots are present and empty, so filling them cannot accidentally
reorder the stages.

**Security headers** applied to every response, with the exact values in
[`security/transport-and-headers.md`](../../../.claude/security/transport-and-headers.md) §2.
CSP is nonce-based with `report-uri` wired from day one, enforcing in production and
report-only in development per `environments.md` §4.

**Rate limiting** is a Redis sliding window keyed per IP and per principal, with
`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers and `429` + `Retry-After`.
Limit classes come from configuration, seeded with the table in `abuse-prevention.md` §1.
Behaviour when Redis is unavailable: **fail closed on authentication endpoints, fail open on
read-only endpoints** — asserted by a test, because getting this backwards is either a lockout
or a credential-stuffing window.

**Error filter** produces the envelope for every error class, always including `requestId`,
never including a stack trace, a database error, or a constraint name.

**Two structural controls built now because retrofitting them is expensive:**

1. **The route access assertion.** At boot, every registered route is checked for an explicit
   access declaration; a route without one **crashes startup**. Health routes declare
   `@Public()`. From Phase 2 onward, forgetting authorization is a boot failure rather than a
   production discovery. `backend.md` §3 requires this and it only works if it exists before
   the routes do.
2. **OpenAPI generation and CI diff.** The schema is generated from the Zod contracts, served
   at `/api/v1/openapi.json`, committed, and diffed in CI. One module's worth of endpoints is
   the cheapest possible moment to establish the mechanism.

**Health checks.** `/health/live` checks the process and **nothing else** — a liveness probe
that checks Postgres restarts every instance at once during a database blip, turning a hiccup
into an outage. `/health/ready` checks Postgres, Redis, and storage. `/health/detailed`
reports migration state; queue depth and worker heartbeats are added in Phase 4.

**Not in Phase 1:** authentication, sessions, CSRF enforcement, authorization enforcement,
entitlements, and every domain module other than health. All Phase 2+.

### 3.8 `apps/web` and `packages/ui`

Next.js App Router with the route groups from
[`architecture/frontend.md`](../../../.claude/architecture/frontend.md) §1 — `(marketing)`,
`(auth)`, `(app)` — containing **placeholder pages, not mock product UI**. A convincing
screenshot of a product that does not exist is the specific illusion this codebase is built to
avoid.

- Tailwind v4, CSS-first, carrying the complete token set from
  [`ui-ux/design-system.md`](../../../.claude/ui-ux/design-system.md) §2–3: the cool-ink neutral
  ramp, the five-step severity ramp with its glyphs, status and intent tokens, the 1.2 type
  scale, the 8px grid, and the three density modes.
- Theming exactly per §7 — light on bare `:root`, dark redefined under both
  `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])` **and**
  `:root[data-theme="dark"]`, so the explicit toggle wins in both directions and the system
  default works without one.
- IBM Plex Sans, Sans Condensed, and Mono self-hosted through `next/font`, which is what keeps
  `font-src 'self'` true rather than aspirational. `tabular-nums` applied globally.
- Nonce-based CSP and the security headers in middleware.
- BFF routes only: `/api/csp-report`, `/api/health`.
- Providers: TanStack Query, theme, density.

`packages/ui` ships tokens plus a deliberately small primitive set — `Button`, `Input`,
`Label`, `Field`, `Card`, `Alert`, `Badge`, `Skeleton` — with the lint rule banning raw hex
values active from the first component. The severity spine (§4 of the design system) waits for
Phase 5, when there are findings to render; the design system itself says components land
alongside the features that need them.

### 3.9 Infrastructure

`infra/docker/docker-compose.yml`, referenced by a root `docker-compose.yml`:

| Service | Image | Port | Healthcheck |
|---|---|---|---|
| postgres | `postgres:16` | 5432 | `pg_isready` |
| redis | `redis:7` | 6379 | `redis-cli ping` |
| minio | `minio/minio` | 9000 / 9001 | `/minio/health/live` |
| minio-init | `minio/mc` | — | creates the four buckets, exits 0 |
| mailpit | `axllent/mailpit` | 1025 / 8025 | HTTP probe |
| vulnerable-target | OWASP Juice Shop | 8080 | HTTP probe — `--profile testing` only |

Every service has a healthcheck, because `docker compose up -d` returning is not the same as
the stack being usable, and exit criterion 2 is about the latter.

**Not in Phase 1:** production Dockerfiles for `api` and `web`. Deployment is Phase 11, and a
Dockerfile written eleven phases before it is deployed is a Dockerfile that will be rewritten.

### 3.10 CI

`.github/workflows/ci.yml`, on pull request and push:

```
setup (Node 26, pnpm 11.5.0, cache)
  -> install --frozen-lockfile
  -> lint
  -> typecheck
  -> test            (unit)
  -> test:integration (Testcontainers; Docker present on ubuntu-latest)
  -> build
  -> openapi-diff     (committed schema matches generated)
  -> registry-check   (every tenant-owned Prisma model is registered)
```

The two checks after `build` are the ones that keep the guarantees alive as the product grows.
`registry-check` reads the Prisma DMMF, finds every model carrying `organizationId`, and fails
if any is missing from `tenant-resources.ts`.

Deferred with reasons: **E2E** beyond one smoke spec — there are no user journeys until Phase 2.
**Container scanning** — there are no images until Phase 11. **The security suite as a separate
stage** — its two halves are the tenant-isolation harness (running here, inside
`test:integration`) and the authorization matrix (Phase 2, when routes have permissions).

### 3.11 Reusable skills

Committed to `.claude/skills/`, so every future session inherits them.

**`sentinel-phase`** — encodes
[`development/resuming-work.md`](../../../.claude/development/resuming-work.md): read
`roadmap.md`; **verify each claimed status by running it** rather than trusting it; build;
update `roadmap.md` in the same change that moves the status; write an ADR for any
architectural decision; end the session cleanly with a commit and a plain-words note on
anything half-finished.

**`sentinel-verify`** — the honesty rule as a runnable gate. Runs `lint`, `typecheck`, `test`,
`test:integration`, `build`; captures real output; maps results onto the §79 status vocabulary
(**Implemented / Partially Implemented / Not Implemented / Blocked**); and refuses to write
"Implemented" anywhere without captured evidence for it.

Both are written to be useful from Phase 1 through Phase 12 and beyond.

---

## 4. Build sequence

Nine steps. Each ends with CI green and its own tests passing; no step claims a status it
cannot demonstrate.

| # | Step | Proves |
|---|---|---|
| 1 | Workspace skeleton, tsconfig, ESLint, Prettier, Turbo, Vitest, CI, `.env.example` | CI is green before any product code exists |
| 2 | `packages/config` + `packages/observability` | Boot-time env validation crashes correctly; redaction drops secrets |
| 3 | Compose stack + `packages/db` schema and first migration | **Node 26 / Prisma compatibility — the earliest possible check on the riskiest assumption**; exit criteria 2 and 3 |
| 4 | Tenant client, RLS migration, resource registry, isolation harness | Exit criterion 5 |
| 5 | `packages/contracts` + the permission matrix and its conformance test | Contracts and docs cannot drift |
| 6 | `packages/storage` + MinIO integration tests | Storage adapter |
| 7 | `apps/api` pipeline, health module, OpenAPI, route assertion | Headers, CSP, rate limiting, error envelope, boot-time authorization guarantee |
| 8 | `packages/ui` tokens and primitives, `apps/web` shell and placeholders | Design system base |
| 9 | Full verification pass, docs, ADRs, roadmap | Exit criteria 1–5, all four documented |

Step 3 is deliberately early. If Prisma's native engine has no Node 26 build, D4 has to be
revisited, and that is far cheaper to discover before six packages depend on the runtime choice.

---

## 5. Risks

| Risk | Likelihood | Response |
|---|---|---|
| **Prisma native engine lacks a Node 26 build** | Medium | Checked at step 3, the earliest possible point. If it fails: try Prisma's Rust-free query compiler; if that also fails, revisit D4 to CI-on-24 and **say so** rather than working around it silently. |
| ESLint 9 flat config with type-aware linting across a workspace | Medium | Known-fiddly rather than uncertain. Budget time in step 1; the project-service approach avoids per-package parser config. |
| Zod → OpenAPI inside Nest | Medium | If the Nest integration fights, generate `openapi.json` from the contracts with a standalone script. The CI diff — the part that has value — works either way. |
| Testcontainers on Docker Desktop for Windows | Low | Exercised at step 3, before four packages depend on it. |
| Tailwind v4's CSS-first config vs. the token design | Low | `@theme` maps cleanly onto the CSS-custom-properties-on-`:root` model the design system already specifies. |
| Next.js / NestJS support for Node 26 | Low | Both track current Node closely. Surfaces at steps 7 and 8; same response as Prisma. |

---

## 6. Documentation changed by this phase

Per the documentation rule in `CLAUDE.md`, these ship **in the same commits** as the code that
invalidates them:

| Document | Change |
|---|---|
| `product/roadmap.md` | Docker unblocked; Phase 1 status moved, with evidence, at the end |
| `architecture/repository-audit.md` | Dated addendum recording the daemon now running — appended, not rewritten |
| `development/folder-structure.md` | `packages/storage` added |
| `architecture/overview.md` §3 | `packages/storage` added |
| `development/setup.md` | "Do not follow these steps" banner removed once the steps work |
| `decisions/README.md` | Index rows for ADR-0011 and ADR-0012 |
| **ADR-0011** (new) | Prefixed UUIDv7 identifiers |
| **ADR-0012** (new) | Node 26 runtime pin, with its revisit trigger |

---

## 7. Definition of done

Phase 1 is **Implemented** when, and only when, all of the following have been run and their
output captured:

- [ ] `pnpm install` succeeds from a clean clone with a frozen lockfile
- [ ] `pnpm lint` — zero errors
- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm test` — all unit tests pass
- [ ] `docker compose up -d` — every service reports healthy
- [ ] `pnpm db:migrate` — applies cleanly to an empty database
- [ ] `pnpm db:seed` — idempotent; a second run changes nothing
- [ ] `pnpm test:integration` — including the tenant-isolation harness and the RLS backstop
- [ ] `pnpm build` — every package and app builds
- [ ] CI green on the branch
- [ ] `roadmap.md` updated in the same change that moves the status
- [ ] ADR-0011 and ADR-0012 written and indexed

Anything not on that list is not claimed. If a box cannot be ticked, the roadmap records
**Partially Implemented** or **Blocked** with the specific reason, per the honesty rule.
