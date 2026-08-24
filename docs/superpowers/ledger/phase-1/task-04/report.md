# Task 4 report: Compose stack, database schema, prefixed UUIDv7 IDs, first migration

## Status: DONE_WITH_CONCERNS

(Concerns are minor packaging/tooling deviations from the brief's literal text, not
functional gaps — see "Deviations from the brief" below.)

## What was implemented

- `infra/docker/docker-compose.yml` — Postgres 16, Redis 7, MinIO, Mailpit, and a
  `--profile testing` Juice Shop target, every long-running service health-checked.
- `infra/docker/postgres/init/01-app-role.sql` — creates the least-privileged
  `sentinel_app` role (no superuser, no BYPASSRLS), grants CRUD on existing and
  future tables/sequences. Shared verbatim by Compose and the Testcontainers harness.
- Root `docker-compose.yml` — `include:` pointing at the infra file.
- `packages/db/` — new package:
  - `prisma/schema.prisma` — `Organization`, `User`, `Credential`, `Session`, `Role`,
    `Permission`, `RolePermission`, `Membership`, `Invitation`, `AuditEvent`, exactly
    as specified (fields, enums, indexes, `onDelete` behaviour, tenant-owned models
    carrying `organizationId` directly with a leading index).
  - `src/id.ts` — `newId`, `parseIdPrefix`, `ID_PREFIXES`, Crockford base32 UUIDv7
    encoding, as specified.
  - `src/unscoped.ts` — `createUnscopedPrismaClient`, as specified.
  - `src/index.ts` — re-exports the ID API.
  - `src/id.spec.ts`, `src/migration.integration.spec.ts` — the brief's tests (one
    line of `migration.integration.spec.ts` adjusted for Windows; see below).
  - `package.json`, `tsconfig.json`, `tsconfig.build.json` — package.json scripts
    match the brief; `build` uses `tsc -p tsconfig.build.json` per the established
    per-package tsconfig split (Task 1–3 convention overriding the brief's single
    `tsconfig.json` reference), matching `packages/config`/`packages/observability`.
  - `packages/db/prisma/migrations/20260820111003_init_identity_and_tenancy/` — the
    first migration, applied to the local Compose Postgres.
  - `packages/db/scripts/sync-env.mjs` — new, not in the brief; see deviations.
- Root `package.json` — added the five `db:*` passthrough scripts verbatim from the
  brief.
- `.gitignore` — added `packages/db/generated/`.
- `pnpm-workspace.yaml` — approved the build scripts pnpm flagged during install
  (`@prisma/client`, `@prisma/engines`, `prisma` — needed for the query-engine
  postinstall fetch; `cpu-features`, `ssh2`, `protobufjs` — transitive native-binding
  builds of `@testcontainers/postgresql` via `dockerode`, needed for the migration
  integration test's Docker control channel). Traced each with `pnpm why` before
  approving; none are unexpected.

`packages/db/src/unscoped.ts` did **not** need a new ESLint override — Task 1–3 had
already added `packages/db/src/unscoped.ts` (and `seed.ts`, `tenant-client.ts`) to
the `no-restricted-imports: off` block in `eslint.config.js` in anticipation of this
task.

## The Prisma-on-Node-26 result — stated plainly

**Prisma's native query engine works on Node 26. No fallback was needed.**

- Node.js: v26.7.0
- pnpm: 11.5.0
- prisma / @prisma/client: 6.19.3 (brief pinned `^6.3.0`; pnpm resolved the current
  6.x)
- `prisma generate` completed in ~100ms on the first attempt, no errors.
- The generated client was then explicitly loaded and instantiated at runtime (not
  just generated) to rule out a load-time failure the generate step alone wouldn't
  catch — succeeded, no crash.
- `prisma -v` confirms the engine in use: `Query Engine (Node-API) : libquery-engine
  ... (at ...\@prisma\engines\query_engine-windows.dll.node)` — the native binary
  engine, not the WASM/queryCompiler fallback.
- `prisma migrate dev` created and applied the first migration against the local
  Compose Postgres without incident.
- The only native-binding failure during `pnpm install` was `ssh2`'s **optional**
  crypto acceleration addon (`cpu-features`/`ssh2`, pulled in transitively by
  `dockerode` via `@testcontainers/postgresql`) — its C++ binding doesn't build
  against Node 26's V8 API (`v8::Context::GetIsolate` removed). pnpm logs this as
  "Failed to build optional crypto binding" and install still exits 0; `ssh2` falls
  back to its pure-JS crypto path. This is unrelated to Prisma and never on the path
  used locally (we talk to Docker over the named pipe, not SSH), and the migration
  integration test (which exercises Testcontainers end-to-end) passed cleanly. Flagging
  it for completeness, not as a blocker.

No escalation steps (queryCompiler/driverAdapters, `.nvmrc` reversion) were needed.
This is direct evidence for ADR-0012 in the user's favour of staying on Node 26 with
the native engine — I have not written that ADR; the instructions were explicit that
decision is not mine to make.

## TDD evidence

**RED** — `pnpm vitest run --project unit packages/db` before `id.ts` existed:
```
FAIL  packages/db/src/id.spec.ts [ packages/db/src/id.spec.ts ]
Error: Cannot find module './id.js' imported from '.../packages/db/src/id.spec.ts'
```
Expected failure — the module didn't exist yet.

**GREEN** — after implementing `id.ts`:
```
✓ unit  packages/db/src/id.spec.ts (6 tests) 49ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```

Each test asserts something implementation-breaking would falsify: wrong `newId`
format/length breaks test 1; a non-time-ordered source or a collision-prone counter
breaks tests 2–3; renaming or dropping a prefix breaks test 4; a broken/absent
`parseIdPrefix` breaks tests 5–6.

## The migration integration test — two real fixes, both platform/version issues, not logic changes

The brief's `migration.integration.spec.ts` as written doesn't run on this Windows
host, for two independent reasons unrelated to the migration logic itself:

1. `execFileSync('pnpm', [...])` fails with `spawnSync pnpm ENOENT` on Windows — pnpm
   resolves to a `.cmd`/`.ps1` shim there, which `execFileSync` cannot invoke without
   a shell. Fixed by switching to `execSync('pnpm exec prisma migrate deploy', {...})`
   (single command string, always shell-executed, no interpolated/untrusted input, so
   no injection concern — commented in the source).
2. The brief's regex `/migrations? (have been )?applied|No pending migrations/i`
   doesn't match Prisma 6.19.3's actual output text, `"All migrations have been
   **successfully** applied."` — the word "successfully" sits between "have been" and
   "applied". Fixed by adding an optional `(successfully )?` group.

Both are shown to matter: I ran the test after each individual fix and watched it
fail for exactly the stated reason before moving to the next fix.

```
✓ integration  packages/db/src/migration.integration.spec.ts (1 test) 5225ms
  ✓ migrations > apply cleanly to an empty database  1762ms
Test Files  1 passed (1)
     Tests  1 passed (1)
```

What would make this test fail: a broken migration SQL file, a schema/migration
mismatch, the `01-app-role.sql` init script erroring inside the container, or
`sentinel_app` privileges being wrong in a way that blocks schema application. Real
coverage, not decoration.

## docker compose ps

```
$ docker compose up -d
...
$ docker compose ps -a --format 'table {{.Service}}\t{{.Status}}'
SERVICE      STATUS
mailpit      Up 12 minutes (healthy)
minio        Up 12 minutes (healthy)
minio-init   Exited (0) 12 minutes ago
postgres     Up 12 minutes (healthy)
redis        Up 12 minutes (healthy)
```
Matches exit criterion 2 exactly: postgres/redis/minio/mailpit healthy, minio-init
exited 0.

(Note: the Compose project resolved to `sstsaaspv1`, not `sentinel` — `include:` in
the root `docker-compose.yml` does not propagate the included file's `name:` field;
Compose derives the project name from the including file's directory instead. Purely
cosmetic — container/network naming — no functional effect. Documenting it in case a
later task greps for a `sentinel-*` container name.)

## Migration applying to an empty database

Applied for real against the local Compose Postgres (not just the Testcontainers
copy):
```
$ pnpm --filter @sentinel/db db:migrate --name init_identity_and_tenancy
Applying migration `20260820111003_init_identity_and_tenancy`
The following migration(s) have been created and applied from new schema changes: ...
Your database is now in sync with your schema.
```
Verified independently with `psql`: 11 tables (10 models + `_prisma_migrations`),
and `sentinel_app` confirmed `rolsuper=f`, `rolbypassrls=f`, `rolcanlogin=t`.

Re-running `pnpm --filter @sentinel/db db:migrate` afterwards is idempotent:
`"Already in sync, no schema change or pending migration was found."`

## Four root commands

All exit 0, run together at the end for a final check:

```
$ pnpm lint       → 4/4 tasks successful (turbo, cached)
$ pnpm typecheck  → 4/4 tasks successful (turbo, cached)
$ pnpm test       → 4 files, 57 tests passed (id.spec.ts's 6 among them)
$ pnpm build      → 3/3 tasks successful (turbo, cached); prisma generate ran as part
                     of @sentinel/db's build
$ pnpm test:integration → 1 file, 1 test passed
```

## Files changed (`git add -A -n` dry run)

```
.gitignore
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
docker-compose.yml
infra/docker/docker-compose.yml
infra/docker/postgres/init/01-app-role.sql
packages/db/package.json
packages/db/prisma/migrations/20260820111003_init_identity_and_tenancy/migration.sql
packages/db/prisma/migrations/migration_lock.toml
packages/db/prisma/schema.prisma
packages/db/scripts/sync-env.mjs
packages/db/src/id.spec.ts
packages/db/src/id.ts
packages/db/src/index.ts
packages/db/src/migration.integration.spec.ts
packages/db/src/unscoped.ts
packages/db/tsconfig.build.json
packages/db/tsconfig.json
```
`packages/db/generated/`, `packages/db/dist/`, `packages/db/node_modules/`, and the
local `packages/db/prisma/.env` sync artifact are correctly excluded by `.gitignore`
(verified via the dry-run add above).

## Deviations from the brief — flagged, not hidden

1. **`ID_PREFIXES` gained two keys, `fnd` and `scn`.** The brief's `id.spec.ts` calls
   `newId('fnd')` and `newId('scn')`, but the brief's `id.ts` `ID_PREFIXES` object
   only lists `org, usr, mbr, ses, crd, rol, prm, inv, aud, req` — `fnd`/`scn` aren't
   in it. Since `IdPrefix = keyof typeof ID_PREFIXES`, the test as given does not
   typecheck against the id.ts as given: `tsc --noEmit` would fail with `Argument of
   type '"fnd"' is not assignable to parameter of type 'IdPrefix'`. This is a genuine
   contradiction inside the brief, not an implementation choice I introduced. I added
   `fnd: 'fnd'` (finding) and `scn: 'scn'` (scan) — plausible Phase-2+ entity types,
   following the exact `key === value` pattern of every other entry — so both the
   literal test file and strict `noUnusedLocals`-adjacent typecheck hold. I did not
   change any of the ten prefixes the brief did specify. Worth a second pair of eyes
   given the instruction to use the brief's values verbatim.
2. **`packages/db/scripts/sync-env.mjs`, new file, and five `db:*` scripts prefixed
   with `node scripts/sync-env.mjs &&`.** Not in the brief. Root cause: Prisma's CLI
   loads `.env` from next to `schema.prisma` (or cwd), never from the workspace
   root — and `pnpm --filter @sentinel/db db:migrate` runs with `packages/db` as cwd.
   Running the brief's literal `"db:migrate": "prisma migrate dev"` after `cp
   .env.example .env` at the root, exactly as Step 7 instructs, fails with `P1012:
   Environment variable not found: DIRECT_DATABASE_URL` — confirmed by reproducing it
   verbatim before making any change. I considered a symlink (unreliable on this
   Windows host — `ln -s` silently produced a plain copy, not a real symlink) and a
   `dotenv-cli` dependency (a new package for one problem) before settling on this:
   copy the root `.env` into the gitignored `packages/db/prisma/.env` immediately
   before any db:* script that needs a live connection. Root `.env` stays the single
   file a developer edits; `db:generate` and `db:seed` are untouched since neither
   needs the fix (`db:generate` demonstrably works with no `.env` present at all —
   schema validation for `generate` doesn't require the env vars to resolve; `db:seed`
   is Task 7's concern and uses a different mechanism entirely).
3. **`migration.integration.spec.ts`**: `execFileSync` → `execSync`, and the assertion
   regex gained an optional `(successfully )?` group. Both are Windows/Prisma-6.19.3
   reality, not logic changes — detailed above under TDD evidence.

None of these touch the schema (models, fields, enums, indexes, constraints,
`onDelete` behaviour are all exactly as specified), the Compose stack, or the
init SQL, which were used verbatim.

## Self-review

- Every model, field, enum, and index from the brief is present and unchanged.
  Diffed the written `schema.prisma` against the brief's text line by line.
- `Membership`, `Invitation`, `AuditEvent` all carry `organizationId` directly with a
  leading index (`@@index([organizationId, ...])` first in each list) — confirmed by
  re-reading each model block.
- `sentinel_app` privilege check done independently via `psql`, not just trusted from
  the init SQL text — `rolsuper=f`, `rolbypassrls=f`.
- Ran each of the six ID tests against a mental "what breaks this" check (see TDD
  evidence) and the one integration test the same way — none are assertions that
  always pass regardless of implementation.
- Checked `packages/db/dist/` after build: only `id.*`, `index.*`, `unscoped.*` —
  no `.spec.js` leaked into the build output.
- Checked for `console.*`, bare `process.env`, and `: any` under `packages/db/src/` —
  the only `process.env` hit is the permitted one in the integration spec.
- File sizes: largest source file is `schema.prisma` at 226 lines, well under the
  ~300-line guidance; all `.ts` sources are small.
- `git add -A -n` dry run confirms nothing under `generated/`, `dist/`,
  `node_modules/`, or the local `prisma/.env` sync artifact would be staged.

## Concerns

- Item 1 above (`fnd`/`scn` added to `ID_PREFIXES`) is a judgment call resolving a
  real contradiction in the brief, not a preference — please confirm the two
  additional prefixes are acceptable, or tell me the intended resolution if it's
  different (e.g., the test was meant to use two of the ten already-listed prefixes
  instead, which would mean editing the test rather than the registry).
- Item 2 (`sync-env.mjs`) changes how five `db:*` scripts work under the hood. It's
  transparent and inspectable, but if there's a project convention I'm not aware of
  for this kind of monorepo/Prisma env problem (e.g., you'd rather use `dotenv-cli`,
  or accept a manually-maintained `packages/db/.env`), say so and I'll swap it.
- `docker compose ps` shows the project name as `sstsaaspv1` rather than `sentinel`
  (cosmetic — see note above) because `include:` doesn't propagate the included
  file's `name:`. Not fixed since fixing it (e.g. `COMPOSE_PROJECT_NAME` or moving
  `name:` to the root file) wasn't asked for and the brief's root file is a one-line
  `include:` verbatim from the spec.
- Did not touch `.claude/product/roadmap.md` or any architecture docs — the brief's
  file list didn't include them for this task, and nothing about the schema,
  Compose topology, or the ID scheme changed from what those documents presumably
  already describe from planning. If roadmap status tracking is meant to be updated
  per-task rather than per-phase, let me know and I'll do it.
