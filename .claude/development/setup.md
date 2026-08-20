# Local development setup

> **Status: Not Implemented.** No `package.json` or compose file exists yet — these are built
> in Phase 1. This document is the target contract, written now so Phase 1 has a specification
> to satisfy. **Do not follow these steps expecting them to work today.**

## Prerequisites

| Tool | Version | This host (2026-08-20) |
|---|---|---|
| Node.js | ≥ 22 LTS | **v26.2.0** — OK |
| pnpm | ≥ 9 | **11.5.0** — OK |
| Docker Desktop | Recent | Installed (29.7.2), **daemon not running** |
| Python | ≥ 3.11 | **3.14.5** — OK |
| Go | ≥ 1.22 | **Not installed** — only needed for Go engines, deferred ([ADR-0010](../decisions/ADR-0010-engine-contract.md)) |

**Start Docker Desktop before anything else.** Postgres, Redis, MinIO, and Mailpit all run in
containers; nothing involving the database, queue, or storage works without the daemon.

## First run

```bash
git clone https://github.com/justineacosta/SSTSaasPv1.git
cd SSTSaasPv1
pnpm install

cp .env.example .env            # placeholders are safe defaults for local only
docker compose up -d            # postgres, redis, minio, mailpit
pnpm db:migrate                 # apply migrations
pnpm db:seed                    # reference data only — CWE, OWASP, roles, plans
pnpm dev                        # web + api + workers, watch mode
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| OpenAPI | http://localhost:3001/api/v1/openapi.json |
| Mailpit (all outbound mail) | http://localhost:8025 |
| MinIO console | http://localhost:9001 |
| Prisma Studio (`pnpm db:studio`) | http://localhost:5555 |

There are **no seeded user accounts.** Register through the UI; the verification email lands in
Mailpit. Seeding fake tenants would make an empty product look populated, which is exactly the
illusion this codebase is meant to avoid.

## Commands

```
pnpm dev                 # everything, watch mode
pnpm dev:web             # frontend only
pnpm dev:api             # api only
pnpm dev:worker          # workers only

pnpm build               # build all
pnpm lint                # eslint
pnpm format              # prettier
pnpm typecheck           # tsc --noEmit

pnpm test                # vitest unit
pnpm test:integration    # integration (needs Docker — uses Testcontainers)
pnpm test:e2e            # playwright
pnpm test:security       # tenant isolation + authorization matrix

pnpm db:migrate          # prisma migrate dev
pnpm db:migrate:create   # create without applying
pnpm db:reset            # DESTRUCTIVE — drop, recreate, migrate, seed
pnpm db:studio
pnpm db:seed
```

## Vulnerable test target

`docker compose --profile testing up -d` starts a deliberately vulnerable application at
`http://localhost:8080`, used by engine integration tests and safe to scan because it is local
and is registered as a pre-verified asset in the test fixtures.

**Never point a local scan at a host you do not own.** The global deny list blocks our own
infrastructure and private ranges, but the discipline matters more than the guard rail.

## Environment variables

`.env.example` documents every variable with a safe placeholder. Local values are for local
only, and `.env` is git-ignored. Never copy a staging or production secret into a local file
([`../security/secrets.md`](../security/secrets.md)).

Config is validated by a Zod schema at boot: a missing or malformed variable **crashes
startup** with a message naming the variable, rather than failing mysteriously later.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dockerDesktopLinuxEngine` not found | Docker Desktop is not running. Start it. |
| `ECONNREFUSED 5432` | Postgres container not up: `docker compose up -d postgres` |
| Migration fails on a fresh clone | Stale volume: `docker compose down -v` then `pnpm db:migrate` |
| Emails not arriving | They are in Mailpit, not your inbox: http://localhost:8025 |
| Integration tests hang | Docker daemon down — Testcontainers needs it |
| Scan stays `QUEUED` | Worker not running (`pnpm dev:worker`), or Redis down |
| `Tenant context missing` | A repository was called outside a request context; pass `TenantContext` |

## Before you open a pull request

`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` — all green.
See [`pull-request-rules.md`](pull-request-rules.md).
