# Task 4 fix report — addressing code review

Responds to the review of commit `947ff4d`. One Critical, three Important, and
several minor findings. All fixed except I3 (ruling: defer to Phase 2, document
now) and the five items explicitly marked deferred by the reviewer.

## C1 — clean checkout didn't lint/typecheck — FIXED

**Root cause confirmed as described.** `packages/db/generated/` is gitignored;
`turbo.json`'s `dependsOn: ["^build"]` on the `lint`/`typecheck` tasks means
"dependencies' build," not the package's own — so nothing regenerates the
Prisma client before `@sentinel/db:lint` runs `eslint src`, which needs
`../generated/client/index.js` to resolve for `unscoped.ts`. CI runs `lint`
before `build` (confirmed by reading `.github/workflows/ci.yml`), so this goes
red on a true fresh clone.

**Fix:** added a root-level `postinstall` script:
```json
"postinstall": "pnpm --filter @sentinel/db db:generate"
```
This is a lifecycle script of the workspace root project itself, not of a
third-party dependency — pnpm's `allowBuilds`/`onlyBuiltDependencies` gate
(the same one that silently skips esbuild/prisma/etc.'s own scripts) applies
only to packages under `node_modules`, never to the root importer's own
scripts. It ran automatically, ungated, on every `pnpm install` I tested,
including `--frozen-lockfile`.

**Proof — exact CI sequence, on a genuinely clean checkout:**
```
rm -rf node_modules packages/{config,db,observability}/node_modules \
       packages/{config,db,observability}/dist packages/db/generated \
       .turbo packages/{config,db,observability}/.turbo
```
Then, in CI's literal order (`install → lint → typecheck → test →
test:integration → build`):

```
$ pnpm install --frozen-lockfile
...
. postinstall$ pnpm --filter @sentinel/db db:generate
. postinstall: $ prisma generate
. postinstall: ✔ Generated Prisma Client (v6.19.3) to .\generated\client in 90ms
...
Done in 15.7s using pnpm v11.5.0
```
`packages/db/generated/client` existed immediately after install, before any
turbo task ran.

```
$ pnpm lint       → LINT_EXIT:0        (4/4 tasks, 0 cached — real execution)
$ pnpm typecheck  → TYPECHECK_EXIT:0
$ pnpm test       → TEST_EXIT:0        (60 tests)
$ pnpm test:integration → INTEGRATION_EXIT:0  (4 tests)
$ pnpm build      → BUILD_EXIT:0
```
All five green, all with 0-cached turbo runs (proving they actually executed,
not replayed from a stale cache) except where a prior step in the same
sequence had already warmed that specific task.

One caveat, found while re-verifying and worth recording honestly: pnpm's
"already up to date" fast path skips lifecycle scripts (including
`postinstall`) if `node_modules` already satisfies the lockfile — so a
developer who deletes only `packages/db/generated/` (leaving `node_modules`
untouched) and runs a bare `pnpm install` will see it skip regeneration. This
never happens in this repo's actual CI (no `node_modules` cache step in
`ci.yml` — every run starts from zero `node_modules`, so `pnpm install
--frozen-lockfile` always does real install work and always fires
`postinstall`), which is the scenario C1 is about. For the narrower local-dev
case, `pnpm --filter @sentinel/db db:generate` (or `pnpm install --force`)
regenerates it directly. Flagging this rather than quietly hoping it doesn't
come up.

## I1 — migration test didn't cover privileges — FIXED

Added three `it` blocks to `migration.integration.spec.ts`, run against the
same Testcontainers instance after `migrate deploy` (moved into `beforeAll` so
every test can rely on migrations already being applied, removing the
same-file ordering dependency the single-test version had):

1. `sentinel_app is not a superuser and cannot bypass row-level security` —
   queries `pg_roles` as the container superuser, asserts `rolsuper` and
   `rolbypassrls` are both `false`.
2. `sentinel_app can select, insert, update, and delete on a migrated table` —
   connects as `sentinel_app` itself (new `sentinelAppUrl()` helper builds its
   connection string from the container's host/port/database — its
   credentials are fixed by `01-app-role.sql`), creates/updates/reads/deletes
   an `Organization` row.
3. `sentinel_app cannot create objects in the public schema` — same
   connection, asserts `CREATE TABLE` rejects.

**Proof — stripped the file down to just role creation + `GRANT CONNECT` +
`GRANT USAGE` (removing the `GRANT SELECT/INSERT/UPDATE/DELETE` and the whole
`ALTER DEFAULT PRIVILEGES` block), reran:**
```
✓ apply cleanly to an empty database
✓ sentinel_app is not a superuser and cannot bypass row-level security
× sentinel_app can select, insert, update, and delete on a migrated table
  → PostgresError { code: "42501", message: "permission denied for table Organization" }
✓ sentinel_app cannot create objects in the public schema
```
Restored the real file (`diff` against the committed version confirmed
byte-identical), reran — all 4 pass. `execFileSync`→`execSync` from the prior
round is untouched.

## I2 — Postgres healthcheck reported healthy before init finished — FIXED

Added `-h 127.0.0.1` to the healthcheck in
`infra/docker/docker-compose.yml`:
```yaml
test: ['CMD-SHELL', 'pg_isready -U sentinel -d sentinel -h 127.0.0.1']
```
Commented inline with why: `pg_isready` with no `-h` defaults to the unix
socket, which the entrypoint's temporary init server also listens on before
`01-app-role.sql` runs; `-h 127.0.0.1` forces TCP, which is refused until the
real server is up.

## I3 — Membership unique index wrong shape for soft-delete — RULING APPLIED, NO CODE CHANGE

Per the coordinator's ruling: defer the fix (partial unique index, hand-written
migration) to Phase 2 / Task 16, document the gap now. Added an explicit
comment directly above `@@unique([organizationId, userId])` in
`schema.prisma` naming the wrong-shape constraint, the exact failure mode
(remove-then-re-add raises a duplicate-key error — reviewer verified live),
why Prisma's schema language can't express the fix (partial index), and where
the fix belongs (Task 16). No schema/migration change — deliberately, since
nothing in Phase 1 sets `Membership.deletedAt`.

## M4 — AuditEvent docstring overclaimed a control — FIXED

Old text asserted UPDATE/DELETE "are revoked ... and blocked by a trigger" —
false; `sentinel_app` holds full CRUD on it. Reworded to present tense that
matches reality and names when the gap closes:
```
/// Intended to be append-only. As of this migration, `sentinel_app` still
/// holds UPDATE and DELETE on this table — revoking them (and adding the
/// blocking trigger) is Phase 3 work per security/audit.md §2, not yet done.
/// Do not rely on database-level append-only enforcement before then.
```

## M8 — published ports open to the LAN — FIXED

All six services in `infra/docker/docker-compose.yml` now bind
`127.0.0.1:PORT:PORT` instead of `PORT:PORT`: postgres, redis, minio (both
9000/9001), mailpit (both 1025/8025), and `vulnerable-target` (8080, behind
`--profile testing`) — the last one called out specifically in a comment,
since it is a real unpatched vulnerable app and was previously reachable by
the whole LAN when the testing profile was up.

## M10 — Compose project name resolved to `sstsaaspv1`, not `sentinel` — FIXED

`include:` does not propagate the included file's `name:` field — moved
`name: sentinel` to the root `docker-compose.yml`, removed it from
`infra/docker/docker-compose.yml`. Verified: tore down the old
`sstsaaspv1`-named stack (`docker compose -p sstsaaspv1 down -v`), brought the
stack up fresh, and `docker compose ls` now reports:
```
sentinel   running(4)   E:\GitHub\SSTSaasPv1\docker-compose.yml
```

## M1 — parseIdPrefix registry guard untested — FIXED

Added `rejects a syntactically valid but unregistered prefix` — builds
`xyz_<26 valid Crockford chars>` from a real generated ID's body (so it passes
the charset regex, unlike the brief's fixture which contains I/O/U and never
reaches the registry check) and asserts `undefined`. Also added `rejects a
well-formed identifier preceded by extra characters` for the leading-garbage
case.

**Proof:** changed `return candidate in ID_PREFIXES ? (candidate as IdPrefix)
: undefined;` to `return candidate as IdPrefix;` in `id.ts`. Reran:
```
× rejects a syntactically valid but unregistered prefix
  → expected 'xyz' to be undefined, received "xyz"
```
8/9 other tests stayed green, confirming this is the only one guarding that
line. Restored `id.ts` (`diff` against committed version: identical), reran —
9/9 pass.

## M2 — chronological-sort test too weak — FIXED

Added `sorts chronologically across many same-millisecond generations`:
generates 1000 IDs in a tight loop and asserts `[...ids].sort()` equals
generation order. Kept the original 5ms-gap test alongside it (still a valid,
if weaker, check).

**Proof:** swapped the last two characters of the Crockford alphabet in
`id.ts` (`...TVWXYZ` → `...TVWXZY`) — same charset, wrong encoding order.
Reran:
```
✓ sorts chronologically as a string, which is what gives index locality   (the OLD test — still green, confirming the weakness)
× sorts chronologically across many same-millisecond generations
  → array diff showing out-of-order runs at every point where the encoding hit Y/Z
```
Restored `id.ts` (diff-confirmed identical to committed), reran — 9/9 pass.

## Approach change — sync-env.mjs replaced with dotenv-cli

Deleted `packages/db/scripts/sync-env.mjs` and the local
`packages/db/prisma/.env` artifact it produced. `packages/db/package.json` is
now byte-for-byte the brief's original text again (`db:migrate` etc. are back
to plain `prisma migrate dev` with no wrapper).

The env-loading fix now lives entirely in the root `package.json`:
```json
"db:migrate": "dotenv -e .env -- pnpm --filter @sentinel/db exec prisma migrate dev",
"db:migrate:create": "dotenv -e .env -- pnpm --filter @sentinel/db exec prisma migrate dev --create-only",
"db:reset": "dotenv -e .env -- pnpm --filter @sentinel/db exec prisma migrate reset --force",
"db:studio": "dotenv -e .env -- pnpm --filter @sentinel/db exec prisma studio",
"db:seed": "pnpm --filter @sentinel/db db:seed"
```
`dotenv-cli@^7.4.0` added as a root devDependency (pure JS, no native build,
no `allowBuilds` entry needed — confirmed by the install log). `dotenv -e
.env` loads the root `.env` and injects it into `process.env` before `pnpm
--filter @sentinel/db exec prisma migrate dev` runs prisma with `packages/db`
as its cwd and its own local dependencies resolved.

**Verified working:**
```
$ pnpm db:migrate
$ dotenv -e .env -- pnpm --filter @sentinel/db exec prisma migrate dev
Datasource "db": PostgreSQL database "sentinel", schema "public" at "localhost:5432"
Already in sync, no schema change or pending migration was found.
```
Also re-ran a real apply (against the freshly recreated `sentinel`-named
Compose stack, after `down -v`): migration `20260820111003_init_...` applied
cleanly, `sentinel_app` confirmed `rolsuper=f`/`rolbypassrls=f` again on the
new instance.

## Deferred, no action taken

M3 (`sentinel_app` holds `arwd` on `_prisma_migrations`), M5 (AuditEvent
cascades on org delete), M6 (`Session.activeOrganizationId` — no FK/index),
M7 (`updatedAt` has no DB default), M9 (`redis-cli ping` liveness idiom) — per
the coordinator, recorded for the whole-branch review, not fixed here.

## Final verification (current state, after restoring all mutated files)

```
docker compose ls
  sentinel   running(4)   E:\GitHub\SSTSaasPv1\docker-compose.yml
docker compose ps -a --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
  mailpit      Up  (healthy)     127.0.0.1:1025->1025/tcp, 127.0.0.1:8025->8025/tcp
  minio        Up  (healthy)     127.0.0.1:9000-9001->9000-9001/tcp
  minio-init   Exited (0)
  postgres     Up  (healthy)     127.0.0.1:5432->5432/tcp
  redis        Up  (healthy)     127.0.0.1:6379->6379/tcp

pnpm lint             → exit 0  (4/4 tasks)
pnpm typecheck        → exit 0  (4/4 tasks)
pnpm test             → exit 0  (4 files, 60 tests)
pnpm test:integration → exit 0  (1 file, 4 tests)
pnpm build            → exit 0  (3/3 tasks)
```

## Files changed in this fix pass

```
docker-compose.yml                              (M10: name: moved here)
infra/docker/docker-compose.yml                 (I2: -h 127.0.0.1; M8: loopback ports; M10: name: removed)
package.json                                    (C1: postinstall; dotenv-cli swap)
packages/db/package.json                        (reverted to brief-verbatim — sync-env removed)
packages/db/prisma/schema.prisma                (I3: comment on @@unique; M4: AuditEvent docstring)
packages/db/scripts/sync-env.mjs                (deleted)
packages/db/src/id.spec.ts                      (M1, M2: new tests)
packages/db/src/migration.integration.spec.ts   (I1: privilege assertions; beforeAll restructure)
pnpm-lock.yaml                                  (dotenv-cli)
```

## Self-review of this fix pass

- Every proof was run by actually breaking the thing the test is supposed to
  catch, watching it go red for the stated reason, then restoring and
  confirming green — not just re-reading the code.
- Diffed every "restore" (`01-app-role.sql`, `id.ts` twice) against the
  committed version with `diff` to make sure the mutation didn't leave a
  stray change behind.
- C1's proof used a full wipe (`node_modules`, `dist`, `.turbo`, `generated`)
  across all three packages, not just `packages/db/generated/` — closer to
  what an actual CI runner starts from, and it's what caught the
  "already up to date" caveat I disclosed above rather than glossing over it.
- Did not touch anything on the deferred list (M3/M5/M6/M7/M9) or re-litigate
  I3 beyond the documentation the ruling asked for.
