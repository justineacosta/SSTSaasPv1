# Task 7 report — seed for system roles and permissions

## What was implemented

- `packages/db/src/seed.ts` — `seedReferenceData(prisma)`, verbatim from the brief. Upserts
  every `PERMISSIONS` entry and every `SYSTEM_ROLES` role (with the brief's exact
  `ROLE_DESCRIPTIONS`), then reconciles each role's `RolePermission` rows against
  `ROLE_PERMISSIONS[key]` — deleting grants the matrix no longer contains before
  `createMany`-ing the wanted set. `main()` reads `DIRECT_DATABASE_URL ?? DATABASE_URL`,
  runs the seed, and logs a one-line summary; it only executes when the file is the
  process entry point, so importing `seedReferenceData` in tests never opens a connection.
- `packages/db/src/seed.integration.spec.ts` — the brief's 4 tests, verbatim.
- `packages/db/package.json` — added `@sentinel/contracts` to `dependencies` (the seed
  consumes `PERMISSIONS`/`ROLE_PERMISSIONS`/`SYSTEM_ROLES` from it, never re-transcribes
  them).

## Two pre-existing defects found and fixed (not introduced by this task)

Both were caught by literally trying to run `pnpm db:seed` per the brief's Step 5 — the
task brief flagged this exact area ("Check what the script actually runs now") as a trap
from earlier tasks.

**1. `packages/db/package.json`'s `db:seed` script could not run at all.**
It was `node --experimental-strip-types src/seed.ts`. Node's native type-stripping does
not perform the TypeScript "`.js` specifier resolves to a sibling `.ts` file" mapping this
codebase's `verbatimModuleSyntax`/`nodenext` convention depends on — every relative import
in `seed.ts` (`./unscoped.js`, `./id.js`) is written with a `.js` extension pointing at a
`.ts` file. I verified this empirically with a throwaway probe file
(`import { newId } from './id.js'` run via `node --experimental-strip-types`):
`ERR_MODULE_NOT_FOUND: Cannot find module '.../src/id.js'`. vitest's own tests pass
today only because vitest resolves modules through Vite/esbuild, which does this mapping
independently of Node.

Fix: added `tsx` (`^4.19.0`, already present in `pnpm-lock.yaml` as an unfulfilled
optional peer of `vite` — never previously installed as a direct dependency) as a
devDependency of `packages/db`, and changed the script to `tsx src/seed.ts`. `tsx` is the
standard, zero-config way to run this exact import shape directly. No other file in the
repo used the `node --experimental-strip-types` pattern, so this was an isolated,
untested script, not a repo-wide convention I'd be breaking.

**2. The root `db:seed` script never loaded `.env`.**
Every sibling (`db:migrate`, `db:migrate:create`, `db:reset`, `db:studio`) is wrapped in
`dotenv -e .env --`; `db:seed` was `"pnpm --filter @sentinel/db db:seed"` with no
`dotenv-cli` wrapper, so `DATABASE_URL`/`DIRECT_DATABASE_URL` would only be present if
already exported in the calling shell. Fixed to match its siblings:
`"db:seed": "dotenv -e .env -- pnpm --filter @sentinel/db db:seed"`.

## ESLint

`packages/db/src/seed.ts` was **already** on the `no-restricted-imports: off` exemption
list (the unscoped-client import) from a prior task. It was **not** on any
`no-restricted-properties: off` (process.env) exemption — that rule only covered
`packages/config/src/**/*.ts` and spec/testing files. `seed.ts` reads
`process.env.DIRECT_DATABASE_URL`/`DATABASE_URL` directly in `main()`, so lint failed
without a fix. Added a third exemption block:

```js
// packages/db/src/seed.ts is a CLI script (`pnpm db:seed`), not a request
// handler — it reads DIRECT_DATABASE_URL/DATABASE_URL directly to build its
// own Prisma connection before any application code (including
// packages/config's loader) would otherwise run. One of the three
// documented exemptions in coding-standards.md §6/database.md §8 alongside
// migrations and platform admin.
{
  files: ['packages/db/src/seed.ts'],
  rules: { 'no-restricted-properties': 'off' },
},
```

## TDD evidence

**RED** — before `seed.ts` existed:

```
$ pnpm vitest run --project integration packages/db/src/seed
FAIL  integration  packages/db/src/seed.integration.spec.ts
Error: Cannot find module './seed.js' imported from
  'E:/GitHub/SSTSaasPv1/packages/db/src/seed.integration.spec.ts'
Test Files  1 failed (1)
     Tests  no tests
```
Expected and correct: the spec imports `./seed.js`, which resolves to the not-yet-created
`seed.ts`.

**GREEN** — after implementing `seed.ts` and the two script fixes:

```
$ pnpm vitest run --project integration packages/db/src/seed
✓ integration  packages/db/src/seed.integration.spec.ts (4 tests)  6000ms
  ✓ creates every system role and every permission          498ms
  ✓ grants each role exactly the permissions the matrix says
  ✓ is idempotent — a second run changes nothing
  ✓ creates no organisations, users, or audit events — an empty product must look empty
Test Files  1 passed (1)
     Tests  4 passed (4)
```

## Mutation transcripts (self-review, per task instructions)

All three were run against `pnpm vitest run --project integration packages/db/src/seed`,
each restored immediately after, with a full green re-run confirmed at the end.

### Mutation A — break idempotency (`permission.create` instead of `permission.upsert`)

```diff
-    const row = await prisma.permission.upsert({
-      where: { key },
-      update: {},
-      create: { id: newId('prm'), key, description: key },
-      select: { id: true },
-    });
+    const row = await prisma.permission.create({
+      data: { id: newId('prm'), key, description: key },
+      select: { id: true },
+    });
```

Result: **detected**.

```
❯ integration  packages/db/src/seed.integration.spec.ts (4 tests | 1 failed)
  ✓ creates every system role and every permission
  ✓ grants each role exactly the permissions the matrix says
  × is idempotent — a second run changes nothing
    → Invalid `prisma.permission.create()` invocation ...
      Unique constraint failed on the fields: (`key`)
  ✓ creates no organisations, users, or audit events ...
Tests  1 failed | 3 passed (4)
```

Restored, re-ran green.

### Mutation B — remove one grant the seed writes for a role

First attempt — editing `ROLE_PERMISSIONS.VIEWER` in `packages/contracts/src/permissions.ts`
to drop `evidence.read` — turned out to be the wrong lever: the "matrix agreement" test
compares the database against the *same* `ROLE_PERMISSIONS` constant the seed writes from,
so a change to the matrix and the seed converge together and the test stays green (all 4
tests still passed after rebuilding `@sentinel/contracts`). That's correct behaviour for
that test — it verifies the seed's fidelity to whatever the matrix says, not the matrix's
own correctness (that's `permissions.spec.ts`'s job). Reverted that edit.

Second attempt — mutated the seed's own grant-writing to silently drop the last wanted
grant for every role, independent of the matrix:

```diff
-    const wantedIds = ROLE_PERMISSIONS[key].map((permission) => {
-      const id = permissionIds.get(permission);
-      if (id === undefined) throw new Error(`Unknown permission in matrix: ${permission}`);
-      return id;
-    });
+    const wantedIds = ROLE_PERMISSIONS[key]
+      .slice(0, -1) // MUTATION: deliberately drop the last grant to prove the test catches it
+      .map((permission) => {
+        const id = permissionIds.get(permission);
+        if (id === undefined) throw new Error(`Unknown permission in matrix: ${permission}`);
+        return id;
+      });
```

Result: **detected, naming the role**.

```
❯ integration  packages/db/src/seed.integration.spec.ts (4 tests | 1 failed)
  ✓ creates every system role and every permission
  × grants each role exactly the permissions the matrix says
    → OWNER: expected [ 'apikey.create', …(47) ] to deeply equal [ 'apikey.create', …(48) ]
      - billing.manage   (missing)
  ✓ is idempotent — a second run changes nothing
  ✓ creates no organisations, users, or audit events ...
Tests  1 failed | 3 passed (4)
```

The failure message's first token is `OWNER` — the `expect(granted, roleKey)` message arg
does exactly what the task asked: names the offending role.

Restored, re-ran green.

### Mutation C — stray `organization.create`

```diff
+  // MUTATION: stray fixture write to prove the "empty product" test catches it
+  await prisma.organization.create({
+    data: { id: newId('org'), name: 'Mutation Test Org', slug: 'mutation-test-org' },
+  });
+
   return { roles: SYSTEM_ROLES.length, permissions: PERMISSIONS.length, grants };
```

Result: **detected** (and caught a second way as a bonus — the stray write also breaks
idempotency, since the second `seedReferenceData` call hits the org's unique `slug`):

```
❯ integration  packages/db/src/seed.integration.spec.ts (4 tests | 2 failed)
  ✓ creates every system role and every permission
  ✓ grants each role exactly the permissions the matrix says
  × is idempotent — a second run changes nothing
    → Unique constraint failed on the fields: (`slug`)
  × creates no organisations, users, or audit events — an empty product must look empty
    → expected 1 to be +0
Tests  2 failed | 2 passed (4)
```

Restored, re-ran green.

## Final verification (after all mutations restored)

`pnpm db:seed` run twice against the live Compose stack (Postgres in `sentinel-postgres-1`):

```
$ pnpm db:seed
$ dotenv -e .env -- pnpm --filter @sentinel/db db:seed
$ tsx src/seed.ts
Seeded 7 roles, 49 permissions, 190 grants. No tenant data created.

$ pnpm db:seed   (second run)
$ dotenv -e .env -- pnpm --filter @sentinel/db db:seed
$ tsx src/seed.ts
Seeded 7 roles, 49 permissions, 190 grants. No tenant data created.
```

Identical counts both times. Cross-checked directly against the live database with
`psql` (not just through Prisma):

```
$ docker exec sentinel-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT (SELECT count(*) FROM \"Organization\") AS orgs,
          (SELECT count(*) FROM \"User\") AS users,
          (SELECT count(*) FROM \"AuditEvent\") AS audit_events,
          (SELECT count(*) FROM \"Role\") AS roles,
          (SELECT count(*) FROM \"Permission\") AS permissions,
          (SELECT count(*) FROM \"RolePermission\") AS grants;"

 orgs | users | audit_events | roles | permissions | grants
------+-------+--------------+-------+-------------+--------
    0 |     0 |            0 |     7 |          49 |    190
```

The five root commands, all exit 0:

```
$ pnpm lint          → Tasks: 6 successful, 6 total
$ pnpm typecheck     → Tasks: 6 successful, 6 total
$ pnpm test          → Test Files 7 passed (7)  | Tests 100 passed (100)
$ pnpm test:integration → Test Files 5 passed (5) | Tests 53 passed (53)
$ pnpm build         → Tasks: 4 successful, 4 total
```

`packages/db`'s full integration suite (RLS, tenant-client, tenant-transaction, migration,
seed — 53 tests across 5 files) passes together with the new seed spec, confirming no
interference between the tenant-isolation machinery and the unscoped reference-data path.

## Files changed

- `packages/db/src/seed.ts` (new)
- `packages/db/src/seed.integration.spec.ts` (new)
- `packages/db/package.json` — added `@sentinel/contracts` dependency; added `tsx`
  devDependency; changed `db:seed` script from `node --experimental-strip-types
  src/seed.ts` to `tsx src/seed.ts`
- `package.json` (root) — wrapped `db:seed` in `dotenv -e .env --` to match its siblings
- `eslint.config.js` — added a `no-restricted-properties: off` exemption scoped to
  `packages/db/src/seed.ts`
- `pnpm-lock.yaml` — updated by `pnpm install` for the two new dependency edges

## Self-review findings

- The brief's `seed.ts` and `seed.integration.spec.ts` were used verbatim, as instructed —
  no changes to signatures, descriptions, or test assertions.
- Both defects fixed (the unrunnable `db:seed` script, the missing `dotenv-cli` wrapper)
  were pre-existing from earlier tasks, not introduced here; fixing them was necessary to
  satisfy the task's own Definition of Done ("`pnpm db:seed` runs twice against the live
  Compose stack with identical results").
- Confirmed no leftover files from the mutation testing (`__probe.ts` used to diagnose the
  Node resolution issue was deleted before final verification; `git status` is clean
  except for the intended changes).
- Confirmed the live Compose database was never touched by the mutation-testing runs —
  those ran against `seed.integration.spec.ts`'s own ephemeral Testcontainers Postgres
  instance, torn down in `afterAll` regardless of test outcome. The live stack only ever
  saw the correct, restored `seed.ts`.

## Concerns

- None blocking. The two pre-existing script defects are now documented above and fixed;
  worth flagging to the team that `db:seed` was never actually exercised end-to-end before
  this task, since neither defect would show up in `pnpm typecheck`/`pnpm lint`/`pnpm test`
  — only in actually running the script, which is exactly why the brief's Step 5 exists.
