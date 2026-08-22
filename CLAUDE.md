# CLAUDE.md

Guidance for Claude Code and human engineers working in this repository.
Keep this file short. Deep documentation lives in [`.claude/`](.claude/README.md).

## Project identity

**Sentinel** — a multi-tenant SaaS platform for security testing, penetration-test
management, and vulnerability management. Customers register assets they own, prove
that ownership, define scope, run automated and manual security testing against that
scope, triage the resulting findings, retest them, and produce reports.

This product performs **authorised security testing against customer-owned assets
only**. Scope enforcement and proof-of-ownership are not features — they are the
core safety control of the entire platform. See
[`.claude/security/scope-controls.md`](.claude/security/scope-controls.md).

## Architecture in one paragraph

A pnpm + Turborepo monorepo. `apps/web` is a Next.js App Router frontend. `apps/api`
is a **modular monolith** NestJS REST API — one deployable, many bounded modules.
Long-running and dangerous work never runs in the API: it is queued to Redis/BullMQ
and executed by separate worker processes (`apps/worker-node`, `apps/worker-python`),
which run each scan engine inside a resource-capped, network-restricted ephemeral
container. PostgreSQL is the system of record via Prisma. Evidence and reports live in
S3-compatible object storage. Realtime updates reach the browser over SSE fed by a
Redis pub/sub fan-out. Stripe is the authority on billing state; the local database
holds a projection of it.

Full detail: [`.claude/architecture/overview.md`](.claude/architecture/overview.md).

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query, React Hook Form, Zod |
| API | NestJS, TypeScript, REST, OpenAPI |
| Database | PostgreSQL 16, Prisma |
| Queue | Redis 7, BullMQ |
| Workers | Node/TypeScript, Python (Go deferred — see ADR-0010) |
| Storage | S3-compatible (MinIO locally, R2/S3 in production) |
| Auth | Opaque server-side sessions, Argon2id, TOTP MFA |
| Billing | Stripe |
| Email | Resend |
| Testing | Vitest, Playwright, Testcontainers |
| Observability | OpenTelemetry, Sentry, structured JSON logs |

## Commands

Every command below exists in the root `package.json` and has been run. Anything
named in a phase plan but not listed here does not exist yet — see
[`.claude/development/setup.md`](.claude/development/setup.md) for the
not-yet-real list (`dev:worker`, `test:security`).

```
pnpm install            # install workspace
pnpm dev                # web + api, watch mode (workers arrive in Phase 4)
pnpm build              # build all packages
pnpm build:packages     # build packages/* only (turbo); test and check:* run this first
pnpm lint               # eslint across workspace
pnpm typecheck          # tsc --noEmit across workspace
pnpm format:check       # prettier --check — gated in CI
pnpm test               # vitest unit tests
pnpm test:integration   # integration tests (requires Docker)
pnpm test:e2e           # Playwright
pnpm check:specs        # every *.spec.* is claimed by exactly one Vitest project
pnpm check:openapi      # committed openapi.json matches what the contracts generate
pnpm check:registry     # tenant resource registry has not rotted
pnpm db:migrate         # prisma migrate dev
pnpm db:studio          # prisma studio
pnpm db:seed            # seed reference data (CWE/OWASP/plans) — never fake tenant data
docker compose up -d    # Postgres, Redis, MinIO, Mailpit
```

**Docker Desktop must be running** for anything touching the database, queue, or
storage. The daemon was not running at audit time.

## Critical security rules

These are not style preferences. Violating one is a release-blocking defect.

1. **No scan executes against an unverified, out-of-scope target.** Scope is checked
   twice: at job creation *and* again inside the worker immediately before execution.
   Never rely on the first check alone, and never on the frontend.
2. **Every tenant-owned query is scoped by `organizationId`.** Use the tenant-scoped
   Prisma client. A raw `prisma.finding.findMany()` without tenant scoping in request
   context is a defect, and CI fails the build for it.
3. **Authorization is server-side.** The frontend hides what a user cannot do; the
   API is what *prevents* it. Every endpoint declares a permission.
4. **Workers do not trust queue payloads.** Re-resolve tenant, project, asset, scope,
   entitlement, and cancellation state from the database before executing.
5. **Never store a raw secret.** Passwords → Argon2id. API keys, invitation tokens,
   session tokens, webhook secrets → hashed or encrypted at rest, shown once.
6. **Never log** passwords, tokens, session cookies, API keys, or evidence bodies.
   Use the redacting logger.
7. **Evidence is authorised on every access**, including presigned-URL issuance.
   Object storage buckets are never public.
8. **Stripe webhooks are the source of billing truth.** Never trust a client claim
   about plan or entitlement.
9. **All outbound scanner traffic is SSRF-guarded** — resolve DNS, reject private,
   loopback, link-local and metadata ranges, and re-check after redirects.
10. **Security-relevant actions write an audit event** in the same transaction as
    the change.

## Core development rules

- TypeScript strict everywhere. No `any` without a written justification comment.
- Validate every external input with Zod at the boundary. Types are not validation.
- Database integrity belongs in the database: foreign keys, unique constraints,
  check constraints. Application code is the second line, not the first.
- Multi-step writes run in a transaction.
- Every list endpoint paginates. No unbounded queries.
- No new N+1: use Prisma `include`/`select` deliberately, and assert query counts in
  integration tests for hot paths.
- Errors use the shared error envelope. Never leak internals to the client.
- API is versioned under `/api/v1`. Breaking a shipped contract requires a new version.

## Testing rules

A feature is not done until it has tests at the layer where it can actually fail:
domain logic → unit; API, authorization, and persistence → integration against a real
Postgres via Testcontainers; user journeys → Playwright. **Cross-tenant isolation
tests are mandatory** for every tenant-owned resource — the test asserts that Tenant A
receives 404 for Tenant B's IDs. Do not mock the thing you are trying to verify.

## Documentation rules

Stale documentation is a defect. When you change API behaviour, the schema, auth,
authorization, the scanner contract, worker behaviour, billing, deployment, or a
security control, update the matching `.claude/` document **in the same change**.
Significant or hard-to-reverse decisions get an ADR in
[`.claude/decisions/`](.claude/decisions/).

## Honesty rule

Never describe something as implemented, working, or production-ready unless it has
been run and verified. Use the status vocabulary from specification §79:
**Implemented / Partially Implemented / Not Implemented / Blocked**, and say exactly
what remains. A file that exists is not a feature that works.

## Resuming work in a new session

Phases are built one per session where convenient. A new session reads `CLAUDE.md` (loaded
automatically), then [`.claude/product/roadmap.md`](.claude/product/roadmap.md) for what is
actually built, then the phase's own documents. Saying "Start Phase N" is enough.

`roadmap.md` is the single source of truth for status and is updated **in the same change that
moves the status** — a stale roadmap makes a resuming session rebuild what exists or skip what
does not. Full protocol, including how to end a session cleanly:
[`.claude/development/resuming-work.md`](.claude/development/resuming-work.md).

Two project skills in [`.claude/skills/`](.claude/skills/) carry this protocol, and using them is
not optional:

- **Invoke `sentinel-phase` before starting, resuming, or finishing any phase *or numbered
  task*.** It encodes the protocol above as an ordered checklist. The user should not have to ask
  for it.
- **Invoke `sentinel-verify` before writing that anything is complete, implemented, working or
  passing, and before moving a status in `roadmap.md`.** It turns the claim into captured
  evidence.

Claude Code only discovers skills in directories that existed when the session started. **If
either name is missing from your skill list, say so before proceeding** — a control that is
silently absent is worse than one that is known to be missing.

## Where to read next

- [`.claude/README.md`](.claude/README.md) — documentation map
- [`.claude/architecture/overview.md`](.claude/architecture/overview.md) — system design
- [`.claude/architecture/repository-audit.md`](.claude/architecture/repository-audit.md) — Phase 0 audit
- [`.claude/security/overview.md`](.claude/security/overview.md) — security model
- [`.claude/product/roadmap.md`](.claude/product/roadmap.md) — phase plan and current status
- [`.claude/development/setup.md`](.claude/development/setup.md) — local setup
- [`.claude/development/resuming-work.md`](.claude/development/resuming-work.md) — picking up between sessions
