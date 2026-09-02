# Local development setup

> **Status: Implemented — every instruction on this page works.** The "First run" block has been
> run end to end, most recently as part of Phase 1's exit-criteria pass on 2026-08-22, including
> from a genuine clean clone. The commands listed under "Commands" are real; the ones under
> "Not yet real" are not, and are labelled with the phase that brings them.
>
> **What this sets up is a shell, and that is a statement about the product, not about these
> steps:** two web pages, health probes, and an OpenAPI document — no authentication, no product.
> Phase 1 being Implemented means its foundation is built and verified, not that anything here is
> usable by a customer. This banner was left claiming "No `package.json` or compose file exists
> yet" until Task 14, and read "Partially Implemented" until Phase 1 closed.

## Prerequisites

| Tool | Version | This host (verified 2026-08-22) |
|---|---|---|
| Node.js | ≥ 22 LTS | **v26.7.0** — OK. Pinned to 26 by `.nvmrc` ([ADR-0012](../decisions/ADR-0012-node-26-runtime-pin.md)) |
| pnpm | ≥ 9 | **11.5.0** — OK |
| Docker Desktop | Recent | **Running** — server 29.7.2, `docker compose` v5.4.0 |
| Python | ≥ 3.11 | **3.14.5** — OK |
| Go | ≥ 1.22 | **go1.27.0 — installed and working** (`go mod init` + `go run .` verified). Go engines remain **deferred by decision**, not by a missing toolchain: [ADR-0010](../decisions/ADR-0010-engine-contract.md) makes the engine contract language-agnostic, and no Go code exists here. |
| Terraform | — | **Not installed.** Blocks IaC *execution* only; Phase 11 owns it. |

**Start Docker Desktop before anything else.** Postgres, Redis, MinIO, and Mailpit all run in
containers; nothing involving the database, queue, or storage works without the daemon. It was
not running when the Phase 0 audit was taken; it is running now
([`../architecture/repository-audit.md`](../architecture/repository-audit.md) §7).

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

### Two database roles must exist before `pnpm db:migrate`

`docker compose up -d` creates them, because `infra/docker/postgres/init/01-app-role.sql` is
mounted as a Postgres init script and runs when the data volume is first initialised. **That is
the only time it runs.** A volume created before a role was added to that file will not have it,
and the migration that needs it fails.

| Role | What it is | Attributes |
|---|---|---|
| `sentinel_app` | The least-privileged role the API process connects as. Every RLS policy applies to it. | `LOGIN`, no `SUPERUSER`, no `BYPASSRLS` |
| `sentinel_org_lookup` | Owns `user_organizations(text)` and nothing else — ADR-0020. | `NOLOGIN NOINHERIT BYPASSRLS` |

**Neither can be created by a migration**, and the reasons differ. `sentinel_app` is referenced
by the Phase 1 row-level-security migration, which runs before any migration could have created
it; `sentinel_org_lookup` needs `BYPASSRLS`, which requires superuser. Both are out-of-band
provisioning steps — carry-forward ruling 96 for the first, ADR-0020's consequences for the
second — and the same is true of the first production deployment, which needs both `CREATE ROLE`
statements run by an operator before the migration history is applied.

If `pnpm db:migrate` fails with `role "sentinel_org_lookup" does not exist`, the volume predates
Task 13. Either run the init script by hand as a superuser:

```bash
docker compose exec -T postgres psql -U sentinel -d sentinel   < infra/docker/postgres/init/01-app-role.sql
```

or recreate the volume (`docker compose down -v && docker compose up -d`), which destroys all
local data.

The migration does not assume the role exists. It raises a named `undefined_object` naming the
role and the statement that creates it, rather than failing at `ALTER FUNCTION ... OWNER TO` with
a message about a role nobody has heard of.

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

pnpm build:packages      # build packages/* only, via turbo (no Next build)
pnpm test                # vitest unit + ui
pnpm test:integration    # integration (needs Docker — uses Testcontainers)
pnpm test:e2e            # playwright — one smoke spec, 5 tests, chromium only

pnpm check:specs         # every *.spec.* is claimed by exactly one Vitest project
pnpm check:openapi       # committed openapi.json matches what the contracts generate
pnpm check:registry      # tenant resource registry has not rotted

pnpm db:migrate          # prisma migrate dev
pnpm db:migrate:create   # create without applying
pnpm db:reset            # DESTRUCTIVE — drop, recreate, migrate, seed
pnpm db:studio
pnpm db:seed
```

**`pnpm test`, `pnpm test:integration`, `check:openapi` and `check:registry` build the workspace
packages first**, via `pnpm build:packages` (`turbo run build --filter=./packages/*`). They have
to: several specs and both check scripts import `@sentinel/contracts`, `@sentinel/observability`,
`@sentinel/storage` and `@sentinel/db` **by package name**, which resolves to each package's
`dist/` — and `dist/` does not exist after a fresh `pnpm install`, because the root `postinstall`
runs only `prisma generate`. Before this was wired in, `pnpm test` failed on 10 spec files from a
clean clone while passing on any developer's warm tree; CI survived only because `pnpm lint` and
`pnpm typecheck` are turbo tasks with `dependsOn: ["^build"]` and happened to run earlier in the
job. Turbo caches, so on a warm tree the extra step is a cache hit measured in milliseconds; the
filter excludes `apps/*`, so this does not drag the slow Next build into `pnpm test`.
`pnpm check:specs` needs no build — it reads `vitest.workspace.ts` and the filesystem, nothing
else.

**`pnpm test:e2e` is real but small.** One spec file (`apps/web/e2e/smoke.spec.ts`), 5 tests,
`chromium` only — console errors, both colour schemes, no horizontal overflow at a narrow
viewport, the security-header table with a fresh CSP nonce, and the CSP report collector. It runs
in CI. It is not a journey suite; there are no journeys yet (Phase 2).

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
startup** with a message naming the variable, rather than failing mysteriously later. A
consequence worth knowing: a server already running when a new variable is added keeps its
launch-time environment, so it fails validation until you restart it.

**One variable has no default, and it is the only one: `MFA_SECRET_ENCRYPTION_KEY`.** It is the
AES-256-GCM key that encrypts `MfaFactor.secretEncrypted`, added by Phase 2 Task 11. Every other
API variable carries a default so an existing environment keeps booting; a default here would be
a shipped encryption key, which is the same defect as a shipped password and harder to notice
because the product would work perfectly. The consequence is practical: **an existing `.env`
predating Task 11 will not boot the API until this line is added**, and `cp .env.example .env` is
the shortest fix. The value must be base64 for exactly 32 bytes — any other decoded length is
refused at boot naming the variable, rather than throwing `Invalid key length` out of a native
module at the first user who enrols. Generate one with `openssl rand -base64 32`.

One variable is not obvious from its name. **`E2E_PORT` (3100) is the port the Playwright
suite starts its own server on, and it is deliberately not `WEB_PORT`.**
`apps/web/playwright.config.ts` keeps `reuseExistingServer` so consecutive local runs do not
pay for a rebuild, which means Playwright attaches to whatever is already listening on that
port. While that port was `WEB_PORT`, a `pnpm dev` left running was what the suite tested —
`APP_ENV=development`, so a report-only CSP and a different application from the one CI runs.
Separate ports make the collision impossible instead of something to remember. `pnpm dev` and
`pnpm start` still bind `WEB_PORT`; only `start:e2e` passes the launcher's `--e2e-port` flag.

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
| E2E fails on a report-only CSP | Something other than the suite's own server is on `E2E_PORT`. The suite pins `APP_ENV=test` and always enforces; the assertion in `smoke.spec.ts` says so. |

## Before you open a pull request

Everything CI runs, in the order CI runs it:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm check:specs
pnpm test:integration        # Docker Desktop must be running
pnpm build && pnpm check:openapi && pnpm check:registry
pnpm test:e2e
```

The order above mirrors CI's, and CI's order is what makes the timings sensible — it is no longer
what makes the commands *correct*. `check:openapi` and `check:registry` read built output, and
each now builds the packages it needs itself rather than relying on an earlier `pnpm build`
having happened. Verified 2026-08-22 from a cold tree (every `dist/` and every turbo cache
removed): `pnpm test`, `pnpm test:integration`, `pnpm check:openapi` and `pnpm check:registry`
each exit 0 when run on their own. `pnpm test:e2e` was **not** re-verified cold.

See [`pull-request-rules.md`](pull-request-rules.md) and [`testing.md`](testing.md) §6.
