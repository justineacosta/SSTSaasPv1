# System architecture — overview

> **Status: Designed. Not Implemented.** This document describes the target
> architecture agreed in Phase 0. No application code exists yet. Each section notes
> the phase that builds it.

## 1. Shape of the system

Sentinel is a **modular monolith with detached workers**. One API deployable contains
many bounded modules; everything slow, untrusted, or dangerous is pushed onto a queue
and executed by worker processes isolated from the API and from each other.

This is a deliberate rejection of a microservice topology. The reasoning is recorded
in [ADR-0001](../decisions/ADR-0001-overall-architecture.md); in short, the domain is
highly relational — an organisation owns projects, which own assets, which have scope,
which constrain scans, which produce findings, which carry evidence — and splitting
that across services buys distribution problems while selling away transactions and
referential integrity. The one axis that genuinely *must* be isolated is execution of
security testing against hostile targets, and that is exactly what we isolate.

```
                        +----------------------+
                        |   Cloudflare edge    |
                        |   CDN / WAF / TLS    |
                        +-----------+----------+
                                    |
              +---------------------+---------------------+
              |                                           |
   +----------v----------+                    +-----------v----------+
   |      apps/web       |  --- REST /v1 ---> |      apps/api        |
   |  Next.js App Router |  <-- SSE stream -- |  NestJS monolith     |
   |  marketing + app    |                    |  modules, guards     |
   +---------------------+                    +---+----------+-------+
                                                  |          |
                              +-------------------v--+  +----v---------+
                              |    PostgreSQL 16     |  |   Redis 7    |
                              |  system of record    |  | cache/pubsub |
                              +----------------------+  +----+---------+
                                                             | BullMQ
                              +------------------------------+----------+
                              |                                         |
                   +----------v----------+                  +-----------v---------+
                   |  apps/worker-node   |                  | apps/worker-python  |
                   |  web / API engines  |                  |  analysis engines   |
                   +----------+----------+                  +-----------+---------+
                              |  spawn ephemeral capped containers      |
                              +--------------------+--------------------+
                                                   |
                                        +----------v----------+
                                        | normalise -> verify |
                                        | dedupe -> risk score|
                                        +----------+----------+
                                                   |
                              +--------------------+--------------------+
                              |                    |                    |
                    +---------v--------+ +---------v--------+ +---------v--------+
                    |   PostgreSQL     | | S3/R2 evidence   | |  Redis pub/sub   |
                    | findings, audit  | | reports,artifacts| | realtime events  |
                    +------------------+ +------------------+ +------------------+
```

## 2. Deployable units

| Unit | Runtime | Scaling | Trust posture |
|---|---|---|---|
| `apps/web` | Node (Next.js) | Horizontal, stateless | Renders only; holds no authority |
| `apps/api` | Node (NestJS) | Horizontal, stateless | Enforces all authn/authz; holds DB credentials |
| `apps/worker-node` | Node | Horizontal by queue depth | Handles hostile target output |
| `apps/worker-python` | Python | Horizontal by queue depth | Same |
| Engine containers | Ephemeral, one per job | N/A | **Fully untrusted.** No secrets, capped CPU/memory/time, restricted egress |
| `apps/scheduler` | Node | **Single leader** | Periodic work: SLA sweeps, retention, usage rollups, webhook retries |

Everything except the scheduler is horizontally scalable with no sticky state. The
scheduler elects a leader through a Redis lock, so running duplicate instances is safe.

## 3. Package layout

```
apps/
  web/              Next.js — marketing site + authenticated application
  api/              NestJS modular monolith
  worker-node/      BullMQ consumer, TypeScript engines
  worker-python/    BullMQ consumer, Python engines
  scheduler/        leader-elected periodic jobs
packages/
  db/               Prisma schema, migrations, tenant-scoped client, seeds
  contracts/        Zod schemas + inferred types shared by web/api/workers
  engine-sdk/       TypeScript implementation of the engine contract
  ui/               design system (shadcn primitives + product patterns)
  observability/    logger, tracing, metrics, redaction
  config/           env parsing/validation, tsconfig + eslint presets
workers/
  python-sdk/       Python implementation of the engine contract
infra/
  docker/           Dockerfiles, compose stacks
  terraform/        IaC (Phase 11)
docs/               public-facing product and API documentation
.claude/            internal engineering documentation (this tree)
```

`packages/contracts` is the spine. Request and response shapes, engine job payloads,
finding shapes, and realtime event payloads are defined once as Zod schemas and
consumed by the frontend, the API, and the workers. A shape change that breaks a
consumer breaks the typecheck — that is the point.

## 4. The request lifecycle

Every authenticated API request passes the same pipeline, in this order:

```
request-id + trace context
  -> rate limit (per IP, then per principal)
  -> authenticate (session cookie OR API key) -> Principal
  -> resolve tenant (organisation) + membership -> TenantContext
  -> CSRF check (cookie-authenticated unsafe methods only)
  -> validate body/query/params with Zod
  -> authorize (permission declared by the route, evaluated server-side)
  -> entitlement check (plan limits, quotas)
  -> handler, using a tenant-scoped Prisma client
  -> audit event written in the same transaction as the mutation
  -> serialise through a response DTO (never a raw Prisma model)
```

Two properties matter more than the rest. **Tenant resolution happens before
authorization**, so a permission is always evaluated against a specific organisation
rather than globally. And **the Prisma client handed to the handler is already bound
to that organisation**, so a handler cannot query another tenant's rows even if the
author forgets to filter. See [`../security/tenant-isolation.md`](../security/tenant-isolation.md).

## 5. The scan lifecycle

This is the pipeline the entire product exists to run.

```
POST /api/v1/scans
  |- authenticate, authorize scan.create
  |- entitlement: concurrent scan limit, monthly scan quota
  |- resolve project + asset within tenant
  |- assert asset.ownershipVerifiedAt IS NOT NULL       <- abuse control
  |- evaluate every target against Scope rules          <- abuse control
  |- validate engine config against that engine's JSON schema
  \- transaction: create Scan(QUEUED) + ScanTargets + audit event
        \- after commit: enqueue BullMQ job {scanId, orgId}

worker receives job
  |- RELOAD scan from the database by id                <- never trusts the payload
  |- RECHECK organisation active and not suspended
  |- RECHECK asset ownership still verified
  |- RECHECK scope still permits every target           <- second enforcement point
  |- RECHECK not cancelled, entitlement still valid
  |- mark RUNNING, emit scan.started
  |- launch engine in a capped ephemeral container
  |     |- engine emits progress -> scan.progress events
  |     \- engine emits raw results + artifacts
  |- normalise raw results into the canonical Finding shape
  |- verify (re-confirm the signal, drop unverifiable low-confidence noise)
  |- fingerprint and deduplicate against existing findings
  |- upload evidence artifacts to object storage
  |- compute risk (CVSS + asset criticality + exposure + confidence)
  |- transaction: upsert Findings, insert Occurrences, write audit events
  \- mark COMPLETED/FAILED, emit scan.completed, fan out notifications
```

The two scope checks are not redundancy for its own sake. Time passes between enqueue
and execution: scope can be narrowed, an asset deleted, an organisation suspended, a
subscription lapsed. The worker check is the authoritative one, because it is the check
adjacent to the packet leaving the machine. Detail:
[`../security/scope-controls.md`](../security/scope-controls.md).

## 6. Realtime data flow

Workers never talk to browsers. A worker publishes an event to a Redis channel keyed by
organisation; every API instance subscribes; a browser holds an SSE connection to
whichever API instance it reached; the API filters events against that connection's
authenticated tenant and permissions before writing them to the stream. A user
therefore cannot receive an event for an organisation they do not belong to, and adding
API instances requires no sticky sessions. Detail: [`realtime.md`](realtime.md).

## 7. Deliberately not in the architecture

- **Microservices** — ADR-0001.
- **GraphQL** — REST plus OpenAPI, because the consumers are a first-party frontend and
  enterprise CI integrations that want stable, documented, versioned endpoints.
- **JWTs for user sessions** — opaque server-side sessions, so revocation is immediate.
  See [ADR-0005](../decisions/ADR-0005-authentication-model.md).
- **Client-side authorization as a control** — it exists only as a UX affordance.
- **One service per scan engine** — engines are plugins behind a single contract
  ([ADR-0010](../decisions/ADR-0010-engine-contract.md)) executed by shared workers.

## 8. Where each phase lands

| Phase | Builds | Primary docs |
|---|---|---|
| 0 | Audit, architecture, documentation tree | this tree |
| 1 | Monorepo, CI, config, logging, DB, Redis, storage, design system base | `../development/setup.md` |
| 2 | Auth, MFA, orgs, memberships, RBAC, invitations | `../security/authentication.md` |
| 3 | Projects, assets, scope, tags, notifications, audit log | `../product/feature-map.md` |
| 4 | Queue, worker orchestration, job + scan lifecycle, realtime | `workers.md`, `queues.md` |
| 5 | Web security engine, normalisation, findings, evidence, risk | `../scanners/` |
| 6 | API security engine | `../scanners/` |
| 7 | Engagements, test cases, manual findings, retests | `../product/feature-map.md` |
| 8 | Reports | `storage.md` |
| 9 | Webhooks and integrations | `integrations.md` |
| 10 | Stripe billing, entitlements, usage | `billing.md` |
| 11 | SSO, SCIM, retention, IaC, enterprise controls | `../operations/` |
| 12 | Additional engines | `../scanners/adding-engines.md` |
