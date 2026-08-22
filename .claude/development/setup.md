# Local development setup

> **Status: Partially Implemented.** The root `package.json`, the compose stack, the migrations
> and the seed all exist and the "First run" block below has been run end to end. What it starts
> is a shell: two web pages, health probes, and an OpenAPI document — no authentication and no
> product. The commands listed under "Commands" are real; the ones under "Not yet real" are not.
> This banner was left claiming "No `package.json` or compose file exists yet" until Task 14.

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
pnpm dev                        # web + api, watch mode (workers arrive in Phase 4)
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

Everything in this block exists and has been run. Commands that do not exist yet are listed
separately below, because a documented command that does not run is the same defect class as a
false claim about a feature.

```
pnpm dev                 # web + api, watch mode (turbo persistent task)
pnpm dev:web             # frontend only  — http://localhost:3000
pnpm dev:api             # api only       — http://localhost:3001

pnpm build               # build all
pnpm lint                # eslint (packages via turbo, plus root scripts/)
pnpm format              # prettier --write
pnpm format:check        # prettier --check — gated in CI
pnpm typecheck           # tsc --noEmit (packages via turbo, plus root scripts/)

pnpm test                # vitest unit + ui
pnpm test:integration    # integration (needs Docker — uses Testcontainers)
pnpm test:e2e            # playwright

pnpm check:specs         # every *.spec.* is claimed by exactly one Vitest project
pnpm check:openapi       # committed openapi.json matches what the contracts generate
pnpm check:registry      # tenant resource registry has not rotted

pnpm db:migrate          # prisma migrate dev
pnpm db:migrate:create   # create without applying
pnpm db:reset            # DESTRUCTIVE — drop, recreate, migrate, seed
pnpm db:studio
pnpm db:seed
```

**Not yet real.** These are named in the phase plans and will arrive with the code they run:

- `pnpm dev:worker` — Phase 4. `apps/worker-node` and `apps/worker-python` do not exist, so
  `pnpm dev` starts web and api only.
- `pnpm test:security` — the tenant-isolation and authorization-matrix suites, Phases 2–3.
  `pnpm check:registry` enforces the *registration* half of that today
  ([`testing.md`](testing.md) §3); the generated assertions need resources to assert over.

`pnpm dev:api` runs `tsc --watch` and `node --watch dist/main.js` side by side rather than
executing TypeScript directly: Nest resolves providers from `emitDecoratorMetadata`, and Node's
type-stripping emits no metadata, so an un-compiled API starts with dependency injection that
cannot resolve anything.

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

Everything CI runs, in the order CI runs it:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm check:specs
pnpm test:integration        # Docker Desktop must be running
pnpm build && pnpm check:openapi && pnpm check:registry
pnpm test:e2e
```

`check:openapi` and `check:registry` read built output, so they go after `pnpm build`.
See [`pull-request-rules.md`](pull-request-rules.md) and [`testing.md`](testing.md) §6.
