# Task 11 report — Route access assertion and OpenAPI generation

Commit: `813bc1e feat(api): boot-time route access assertion and generated OpenAPI`
Branch: `feat/phase-1-foundation` (not pushed).

---

## 1. What was implemented

### The boot-time access assertion

- **`apps/api/src/common/route-inventory.ts`** (new) — one walk of every controller's
  metadata producing `RegisteredRoute[]` (controller, handler, HTTP method, full path,
  access declaration, `@ApiDoc` declaration). Two readers share it: the access assertion
  and the OpenAPI generator, so they can never disagree about what routes exist.
  - Paths are assembled by **Nest's own `RoutePathFactory`** (deep import
    `@nestjs/core/router/route-path-factory.js`), not by a reimplementation. That class *is*
    the assembly Nest's router uses — global prefix, prefix exclusions, URI version segment,
    slash normalisation. Reimplementing ~60 lines of it was the alternative and is precisely
    the drift this task exists to prevent.
  - `registeredRouterRoutes(app)` reads Express 5's own router stack back, as the control.
- **`apps/api/src/common/access-assertion.ts`** (new) — `findRoutesWithoutAccessDeclaration`
  (pure), and `assertEveryRouteDeclaresAccess(app)` which:
  1. **refuses to run against an empty router** (the trap — see §4);
  2. **compares its inventory against Express's router** and refuses on any mismatch;
  3. reports **every** offender in the brief's exact message format.
- **`apps/api/src/main.ts`** — `await app.init()` → assert → `listen`. On refusal the app is
  closed before rethrowing: `init()` has already opened the Prisma pool, and an open pool
  keeps the event loop alive, so without the close the process would set a failing exit code
  and then hang, which an orchestrator reads as "starting" rather than "crashed".
- `access.decorator.ts` was **not** touched — Task 9 wrote it; this task is only its reader.

### OpenAPI

**Route taken: no `@nestjs/swagger`; live-router path list + a local Zod-carrying decorator.**

- **`apps/api/src/common/decorators/openapi.decorator.ts`** (new) — `@ApiDoc({summary,
  description?, responses})`, where each response carries the **Zod schema itself**. This is
  the "and decorators" half of backend.md §7. `@nestjs/swagger` was rejected because it does
  not read Zod: every route would declare its shape twice, once for validation and once for
  documentation, which is the exact drift the document is supposed to prevent.
- **`apps/api/src/openapi/generate.ts`** (new) — `buildOpenApiDocument(routes)` (pure, unit
  testable) and `generateOpenApiDocument(app)`. Schemas convert through
  **`zod-to-json-schema`** (added as a dependency) with `target: 'openApi3'`.
  `errorEnvelopeSchema` from `packages/contracts` is published once as
  `components.schemas.ErrorEnvelope` and referenced by every route's `default` response,
  because §5's envelope is part of every route's contract whether the route says so or not.
  Each operation publishes `x-sentinel-access` — there is no `securitySchemes` to point at
  until Phase 2, and inventing one would document a control that does not exist.
- **`apps/api/src/openapi/openapi.controller.ts` / `openapi.module.ts`** (new) — serves at
  `/api/v1/openapi.json`, `@Public()`, in every environment (backend.md §7 and the spec both
  write that path unqualified). Its own `@Public()` is the assertion's smallest self-test:
  without it the API refuses to boot.
- **`apps/api/src/openapi/cli.ts`** (new) + `pnpm --filter @sentinel/api openapi:generate` →
  writes **`apps/api/openapi.json`** (committed). It deliberately does **not** call
  `app.init()`: generation reads controller metadata, so regeneration needs no Postgres,
  Redis or MinIO — only a valid environment.
- **`apps/api/src/modules/health/health.contracts.ts`** (new) — Zod schemas for the three
  health responses, each annotated `z.ZodType<ReadinessReport>` / `<DetailedReport>` so the
  published document **cannot compile** if it drifts from what the handler returns
  (verified by mutation M11 below).

**Why the route list cannot drift:** `Object.keys(document.paths)` is derived from the same
inventory the boot assertion checks, and an integration test compares it against Express's
own router. A route that exists but is undocumented fails the suite.

### Documentation

`.claude/architecture/backend.md`:
- header status line now lists the assertion and the OpenAPI document as built;
- §3's "**The startup assertion that reads it does not exist yet**" paragraph replaced with a
  **Status: Implemented** section naming the file, the `init()` ordering requirement, and the
  router cross-check;
- §3 table row "Authorize" now reads "Decorator implemented and asserted at boot";
- §7 gained a **Status** block covering all of the above, including why `@nestjs/swagger` is
  absent and why the endpoint is public in every environment.

`.claude/product/roadmap.md` was **not** touched (controller owns it).

---

## 2. Rulings applied

- **`bootstrapTestApp()` does not exist** — as ruled, pure functions went to the unit lane,
  and anything needing the real module graph went to the integration lane reusing an
  **extracted** `buildApp()` (`apps/api/src/testing/build-app.ts`), not a copy.
  `app.integration.spec.ts` was refactored onto that shared helper (it now passes its
  `BoomController` in as an argument), so there is exactly one bootstrap.
  A second harness, `apps/api/src/testing/routing-app.ts`, builds a **unit-lane** application
  from purpose-built controllers only. It touches no Postgres/Redis/MinIO and applies the
  *real* prefix/versioning via a new `applyRouting()` extracted from `configureApp` — so the
  unit tests exercise production routing configuration rather than a second copy of it.
  This is what makes it possible to test a route that is genuinely missing its declaration:
  no such route exists in the product, because the assertion is what stops one existing.
- **The served document is public in every environment**, and its controller carries
  `@Public()`.
- **`@nestjs/swagger` not added**; `zod-to-json-schema` added instead (allowed by the brief:
  "adding a small, well-justified dependency for Zod→JSON-Schema conversion is allowed").
  Hand-rolling a converter was the alternative; a hand-rolled converter that silently
  mis-renders a schema shape it has not met is a worse failure than a pinned 0-dependency
  library built for exactly this.

---

## 3. TDD evidence

### RED

```
$ npx vitest run --project unit apps/api/src/common/access-assertion.spec.ts
 FAIL  unit  apps/api/src/common/access-assertion.spec.ts
Error: Cannot find module './access-assertion.js' imported from
       'E:/GitHub/SSTSaasPv1/apps/api/src/common/access-assertion.spec.ts'
 Test Files  1 failed (1)
      Tests  no tests
```

Expected failure: the brief's Step-1 spec was written verbatim before any implementation
existed, so the import target was absent. This is the honest RED for "the module does not
exist yet" — the assertions themselves had not yet had a chance to run.

### GREEN

```
$ npx vitest run --project unit apps/api/src/common/access-assertion.spec.ts
 ✓  unit  apps/api/src/common/access-assertion.spec.ts (4 tests) 2ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Then the app-level positive controls were added to the same file (8 tests), the route
inventory spec (6), the generator spec (9), and the integration spec (5).

One intermediate RED worth recording, because it was a **test bug** rather than a code bug:
the offender-naming test asserted `expect(message).not.toContain('DeclaredController')`
while the offending fixture was named `PartlyDeclaredController` — a substring. Renaming the
fixture to `FindingsController` (matching the brief's own error sample) fixed it.

---

## 4. The trap, and how it is closed

Nest registers no route until `app.init()`, and `app.listen()` calls `init()` implicitly. An
assertion placed "immediately before `listen`" therefore inspects **zero** routes and passes
vacuously.

Three things close it, all of them tested:

1. `main.ts` calls `await app.init()` **explicitly** before asserting.
2. `assertEveryRouteDeclaresAccess` **throws** when the router has no registered routes at
   all, with a message naming `app.init()`. A boot check that cannot fail is worse than none.
3. Every boot compares the metadata-derived inventory against Express's live router, so a
   route the check cannot see is a boot failure rather than a route quietly skipped.

Both (2) and (3) have positive-control tests that fail when the guard is removed (M1, M3).

---

## 5. Mutation verification

Each mutation was applied by a script that **asserts the pattern occurs exactly once** and
fails loudly otherwise (this fired for real once — see M10a), then the suite was run, then
the file was restored from a byte-level backup and the suite re-run green. Restoration was
verified with `cmp -s` each time.

> A process note: the first attempt at M1–M3 used `git checkout --` to restore, which
> silently failed because the new files are untracked (`error: pathspec ... did not match any
> file(s) known to git`), so the mutations stacked. That was caught, the file was repaired,
> and all mutations were re-run with a copy-based backup. The numbers below are from the
> clean re-run.

| # | Mutation | Applied? | Caught by |
|---|---|---|---|
| M1 | `access-assertion.ts`: empty-router guard condition made unreachable | yes | unit — `refuses a router with no routes rather than passing vacuously` (1 failure) |
| M2 | `access-assertion.ts`: offender filter inverted (`=== undefined` → `!==`) | yes | unit — 6 failures, including all four of the brief's pure tests |
| M3 | `access-assertion.ts`: router cross-check call removed | yes | unit — `refuses when a route exists that the check cannot see` (1 failure) |
| M4 | `route-inventory.ts`: controller default-version fallback dropped | yes | unit — 2 failures; paths lose `/v1` and no longer match the router |
| M5 | `route-inventory.ts`: class metadata made to win over method metadata | yes | unit — `reads a class-level declaration and lets a handler override it` |
| M6 | `route-inventory.ts`: method-level `@Version` ignored | yes | unit — 2 failures; `/api/v2/findings` disappears |
| M7 | `generate.ts`: the shared `default` ErrorEnvelope response dropped | yes | unit — 9 failures |
| M8 | `generate.ts`: routes without `@ApiDoc` silently skipped | yes | unit — 4 failures |
| M9 | `health.controller.ts`: `/health/detailed` loses `@Public()` | yes | **integration** — 2 failures (`every route in this application declares its access`, and committed-vs-generated) |
| M10a | `openapi.json`: replace a string that does not exist in the file | **no — reported `MUTATION-NOT-APPLIED: pattern occurs 0 times` and aborted** | the harness itself; retried as M10b |
| M10b | `openapi.json`: committed summary edited to drift from the generator | yes | **integration** — `the committed openapi.json matches what the code generates` |
| M11 | `health.service.ts`: a field added to `ReadinessReport` | yes | **`pnpm typecheck`** — `health.contracts.ts(24,14): error TS2322 ... not assignable to type 'ZodType<ReadinessReport, ...>'` |

M10a is worth keeping in the record: it is exactly the "scripted edit silently matches
nothing and reports caught" failure mode this project has been bitten by, and the harness
refused rather than reporting a false pass.

---

## 6. Gate output

All five run from the repo root, after the final self-review fixes.

```
===== pnpm lint =====
 Tasks:    11 successful, 11 total

===== pnpm typecheck =====
 Tasks:    11 successful, 11 total

===== pnpm test =====
 Test Files  21 passed (21)
      Tests  251 passed (251)

===== pnpm test:integration =====
 Test Files  10 passed (10)
      Tests  136 passed (136)

===== pnpm build =====
 Tasks:    6 successful, 6 total
```

Docker Desktop was **not** running at the start of this task; it was started and
`docker compose up -d` brought the stack up (postgres, redis, minio, mailpit), so the
integration lane genuinely ran against live services — it was not skipped.

`pnpm format:check` is **not** one of the five gates and was already red at `HEAD` on 11
files I did not touch (`packages/db/*`, `packages/contracts/*`, `.github/workflows/ci.yml`).
I verified with `git show HEAD:<file> | prettier --check` that every file I modified was
prettier-clean before my change, and formatted all of mine so I added nothing to that pile.
Two files prettier wanted to reformat but that I had not otherwise touched
(`security-headers.middleware.ts`, `access.decorator.ts`) were reverted to keep the diff
free of unrelated churn.

---

## 7. Files changed

New:
```
apps/api/openapi.json                                (generated, committed)
apps/api/src/common/access-assertion.ts
apps/api/src/common/access-assertion.spec.ts
apps/api/src/common/route-inventory.ts
apps/api/src/common/route-inventory.spec.ts
apps/api/src/common/decorators/openapi.decorator.ts
apps/api/src/modules/health/health.contracts.ts
apps/api/src/openapi/generate.ts
apps/api/src/openapi/generate.spec.ts
apps/api/src/openapi/generate.integration.spec.ts
apps/api/src/openapi/openapi.controller.ts
apps/api/src/openapi/openapi.module.ts
apps/api/src/openapi/cli.ts
apps/api/src/testing/build-app.ts
apps/api/src/testing/routing-app.ts
```

Modified:
```
.claude/architecture/backend.md          §3 and §7 status; header status line
.prettierignore                          apps/api/openapi.json (generated artefact)
apps/api/package.json                    + zod-to-json-schema, + openapi:generate script
apps/api/tsconfig.build.json             excludes src/testing from the runtime image
apps/api/src/app-setup.ts                extracted applyRouting()
apps/api/src/app.module.ts               + DiscoveryModule, + OpenApiModule
apps/api/src/main.ts                     init → assert (close on refusal) → listen
apps/api/src/modules/health/health.controller.ts   + @ApiDoc on all three routes
apps/api/src/app.integration.spec.ts     uses the shared buildApp helper
eslint.config.js                         apps/api/src/testing/** gets the harness exemption
pnpm-lock.yaml
```

---

## 8. Self-review findings (fixed before commit)

1. **A refused boot would have hung.** `assertEveryRouteDeclaresAccess` runs after
   `app.init()`, which opens the Prisma pool; the existing top-level handler sets
   `process.exitCode = 1` but does not exit, so an open pool would have kept the process
   alive indefinitely — an orchestrator sees "starting", not "crashed". `main.ts` now closes
   the app before rethrowing.
2. **`wrapper.metatype` guard was `=== null` only.** Nest types it `Type | Function | null`,
   but an `undefined` would have thrown on `.prototype`. Widened to both.
3. **Test-fixture substring bug** (`PartlyDeclaredController` contains `DeclaredController`)
   — caught by the test itself going red; fixture renamed.
4. **`ZodTypeAny` is `ZodType<any, …>`** and tripped `no-unsafe-argument`. Replaced with an
   explicit `DocumentedSchema = ZodType<unknown, ZodTypeDef, unknown>` rather than an
   `eslint-disable`, so no `any` enters the codebase.
5. **Unrelated formatting churn reverted** on two files prettier wanted to rewrite but that
   this task did not otherwise touch.

## 9. Concerns and deferred items

- **`main.ts`'s own ordering is not directly covered by a test.** No test executes
  `bootstrap()` (it self-executes on import and binds a port). What *is* tested is the guard
  that makes the mistake loud: if someone moves the assertion before `init()`, the
  empty-router guard throws with a message naming `app.init()`. I judged a test that boots
  the real process on a real port to be worse value than that guard; a reviewer may disagree.
- **Two deep imports into framework internals**: `@nestjs/core/router/route-path-factory.js`
  (not on the public index) and `@nestjs/common/constants.js` / `interfaces/index.js` (the
  same subpaths Nest's own router reads). Neither package declares an `exports` map, so both
  resolve. The trade was deliberate and is documented at the import site: if a Nest upgrade
  moves the file the API fails to start immediately, whereas a reimplementation would start
  fine and be quietly wrong. The router cross-check is the second line of defence.
- **`@ApiDoc` is optional, not asserted.** A route without it still appears in the document
  (the path list comes from the router), it simply carries no summary or response bodies.
  A missing `@ApiDoc` is a thinner document, not a security hole, so I did not think it
  worth a second boot failure. Making it required is a cheap follow-up if wanted.
- **`x-sentinel-access` is a vendor extension, not `security`.** It becomes a real
  `securitySchemes` reference in Phase 2 when authentication exists.
- **`registeredRouterRoutes` reads Express 5's `app.router` only** (no Express 4 `_router`
  fallback). If the adapter ever changes shape it returns `[]`, which trips the empty-router
  guard — loud, though the message would then be slightly misleading.
- **The CI diff step for `openapi.json` is the next task's work**, per the brief. The
  committed-vs-generated assertion exists today as an integration test.

---

# Fix round — review response

Commit: `d06cb21 fix(api): reproduce Nest's full path assembly, and close four gaps around it`
Branch: `feat/phase-1-foundation` (not pushed). Parent: `813bc1e`.

Review outcome being answered: 0 Critical, 1 Important, 7 Minor. Six Minors plus the
Important were sent for this round; `cli.ts` hardcoding logger level/pretty was explicitly
deferred to the whole-branch review and is **not** touched here.

## Correction to the first round's evidence (honesty item A)

**M7 as originally reported was wrong, and the reviewer was right to check it.**

I reported "9 failures" for dropping the shared `default` ErrorEnvelope response. The mutation
I used was `responses['default'] = {` becoming `if (routes.length < 0) responses['default'] = {`,
and `routes` is not in scope inside `responsesFor` — under esbuild that is not a compile error,
it is a runtime `ReferenceError` that fails the whole file. The "9" was the file's total test
count, not nine discriminating assertions. The first test in that file (`generate.spec.ts:17-22`)
asserts only `openapi` / `info.title` / `info.version` and could not possibly detect a missing
response.

Re-run this round with a mutation that removes the response without breaking the module
(`responses['default']` becoming `responses['notdefault']`):

```
MUTATION-APPLIED (1 occurrence)
 ×  buildOpenApiDocument > documents the shared error envelope once and points every route at it
 ×  buildOpenApiDocument > still documents a route that declared nothing, rather than dropping it
 Test Files  1 failed (1)
RESTORED (byte-identical)
 Test Files  1 passed (1)
```

**M7's real detectors are those two tests, and no others.** They are exactly the two the
reviewer identified. The guarantee is genuinely covered; my count was not.

## What changed, per finding

### IMPORTANT 1 — the inventory skipped `normalizePath`

`RoutePathFactory` is only half of what Nest does to a path. `router-explorer.js` then
registers `adapter.normalizePath(path)`, and the Express adapter's implementation runs
`LegacyRouteConverter.tryConvert`, rewriting `*` to `{*path}`, `+` to `*path`, `(.*)` to
`{*path}`. For today's four routes that is the identity — which is precisely why every test was
green and why the gap was invisible.

- `route-inventory.ts` gained `PathNormaliser` and `adapterPathNormaliser(adapter)`.
  `describeRoutesFrom` takes the normaliser as a **required** third parameter — not defaulted
  to the identity, because a default is how the next caller silently gets the wrong answer, and
  there are only two callers.
- `describeRoutes(app)` supplies `adapterPathNormaliser(app.getHttpAdapter())`.
- `OpenApiController` injects `HttpAdapterHost` and supplies the same normaliser, so the served
  document and the boot assertion describe identical paths.

**Documentation, same change:** the docblock claim "borrowing it means the inventory cannot
disagree with the routes Nest registered" and backend.md §3's "borrows Nest's own
`RoutePathFactory` so the paths cannot disagree" were both false and are both rewritten. They
now name *both* halves of the reproduction and state plainly that nothing relies on the
reproduction being correct — only on the boot-time comparison finding the two in agreement.

While rewriting §3 I introduced and then caught a second factual error of my own: I wrote that
`*` is rewritten to `{*splat}`. The converter emits `{*path}` (verified against
`legacy-route-converter.js` and against the new test's actual output). Corrected before commit.

**Covering test:** `route-inventory.spec.ts` — `describeRoutes and legacy path syntax > reports
the path the router holds, not the one the factory built`, using a new `LegacyPathController`
with `@Get('*')`. It asserts both `described === registeredRouterRoutes(app)` and the literal
`['GET /api/v1/legacy/{*path}']`.

### 2 — non-string Express paths were silently dropped

`registeredRouterRoutes` funnelled `layer.route.path` through `asPaths`, which returned `[]` for
a `RegExp`. Nest never emits one, so this only mattered for out-of-band registration — which is
the entire reason the cross-check exists, putting the blind spot in the last line of defence.
New `registeredPathsOf` renders anything non-string as `<unrecognised path: ...>`, a form no
described route can equal, so it forces a mismatch.

**Covering tests:** `route-inventory.spec.ts > registeredRouterRoutes > counts a path it cannot
describe rather than ignoring it`, and `access-assertion.spec.ts > assertEveryRouteDeclaresAccess >
refuses a rogue route even when its path is not a string`.

### 3 — duplicate `operationId` was possible and unguarded

`buildOpenApiDocument` now calls `assertUniqueOperationIds` and throws, naming the colliding
ids. I chose failing loudly over auto-disambiguating: an auto-suffixed id is a poor
client-facing name that would silently change when a path is added. Generation is not on the
boot path, so the failure surfaces in the regeneration script and in the committed-document
test — both of which gate a merge, so a duplicate cannot ship.

This immediately caught two of my **own** first-round fixtures: `orders paths and methods
independently...` and `documents the shared error envelope once...` both built documents with
two routes sharing `HealthController_live`. Those fixtures were invalid documents; they now use
distinct handler names.

**Covering tests:** `generate.spec.ts > refuses a document in which two operations share an
operationId` and `> accepts the same handler name on two different controllers`.

### 4 — `main.ts` could lose the offender list

`app.close()` is now wrapped in its own `try { } catch { }` so a shutdown failure cannot replace
the assertion error. **No test covers this** — see concerns.

### 5 — `health.contracts.ts` overstated its guarantee

The docblock claimed all schemas were annotated so documentation "cannot drift".
`livenessReportSchema` had no annotation, and `z.ZodType<T>` is one-directional. Now:

- Liveness is **schema-first**: `LivenessReport = z.infer<typeof livenessReportSchema>` and
  `HealthController.live` returns it, so the two cannot differ in either direction.
- The docblock states exactly what the `z.ZodType<T>` annotations on readiness and detailed
  buy, and **admits the gap**: a field added to the schema that the handler never returns stays
  assignable and would publish silently.

### 6 — `openapi:generate` used an undeclared bin

`dotenv-cli` is now a devDependency of `apps/api`. Verified: `apps/api/node_modules/.bin/dotenv`
exists, and `pnpm --filter @sentinel/api openapi:generate` runs and reproduces the committed
file byte-identically.

### 7 — the committed-document test compared structure, not bytes

Added `matches it byte for byte, not merely in structure`, comparing the file's exact contents
against the same two-space-plus-newline serialisation `cli.ts` writes. `.gitattributes` pins
checkouts to `eol=lf` and `cli.ts` writes `\n` explicitly, so the newline is stable
cross-platform.

### B — `roadmap.md`

The sentence "The boot-time assertion that every route declares its access is not written yet,
so the access decorators are metadata nothing reads" is replaced. The new text says the
assertion exists, refuses startup naming every offender, and is cross-checked against the
router — and **keeps the half that remains true**: `@RequirePermission()` is still metadata no
guard reads until Phase 2. A second paragraph scopes the OpenAPI document honestly (generated,
served, committed, byte-checked; CI diff in Task 14). The phase status table and the "Where
Phase 1 stopped" section were not touched.

### Committed document

`apps/api/openapi.json` did **not** need regenerating. The `operationId` change only *validates*
ids, it does not rename them, and `normalizePath` is the identity for all four current routes.
Confirmed two ways: the new byte-equality test passes against the existing file, and re-running
`openapi:generate` left `git status` clean.

## Mutation verification

Same harness as round one: copy-based backup, the edit asserts it matched **exactly one**
occurrence or aborts, run, restore, `cmp -s` the restore, re-run green.

| Mutation | Applied? | Caught by |
|---|---|---|
| F1 `path: normalizePath(path)` reverted to `path` (the pre-fix behaviour) | yes | unit — `reports the path the router holds, not the one the factory built` (1 failure) |
| F2 `registeredPathsOf` returns `[]` for non-strings again | yes | unit — `counts a path it cannot describe rather than ignoring it` (1 failure) |
| F2b same mutation, run against the assertion spec | yes | unit — `refuses a rogue route even when its path is not a string` (1 failure) |
| F3 `assertUniqueOperationIds(operations)` call removed | yes | unit — `refuses a document in which two operations share an operationId` (1 failure) |
| F3b `operationId` drops the controller name | yes | unit — 3 failures, including `accepts the same handler name on two different controllers` |
| F5 a field added to the **liveness schema** (the direction `z.ZodType<T>` does *not* protect) | yes | `pnpm typecheck` — `health.controller.ts(50,5): error TS2741: Property 'uptime' is missing in type '{ status: "ok"; }'` |
| F7 committed `openapi.json` reindented (structure identical, bytes differ) | yes | **integration** — `matches it byte for byte` red, while `the committed openapi.json matches what the code generates` stayed green |
| M7 (redone, see above) | yes | unit — exactly 2 tests, named above |

F7 is the one worth reading closely, because it is the finding's whole claim. Under a
formatting-only change the structural test **passed** and only the new byte test failed:

```
 ✓ the OpenAPI document > the committed openapi.json matches what the code generates
 × the OpenAPI document > matches it byte for byte, not merely in structure
AssertionError: expected '{\r\n    "openapi": "3.0.3",\r\n    "...' to be '{\n  "openapi": "3.0.3",\n  "info": {...'
```

(The mutation script reindented to four spaces and, being Python on Windows, also wrote CRLF.
Either difference alone is enough; the point stands that the structural test cannot see it.)

## Gate output

Docker Desktop was running; `docker compose up -d` confirmed postgres, redis, minio and mailpit
healthy, so the integration lane ran against live services. `lint`, `typecheck` and `build` were
re-run with `--force` so no result came from the turbo cache.

```
===== 1/5 pnpm lint (forced, no cache) =====
 Tasks:    11 successful, 11 total
Cached:    0 cached, 11 total

===== 2/5 pnpm typecheck (forced, no cache) =====
 Tasks:    11 successful, 11 total

===== 3/5 pnpm test =====
 Test Files  21 passed (21)
      Tests  256 passed (256)          [was 251 — five new tests]

===== 4/5 pnpm test:integration =====
 Test Files  10 passed (10)
      Tests  137 passed (137)          [was 136 — one new test]

===== 5/5 pnpm build (forced, no cache) =====
 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
```

## Files changed this round

```
.claude/architecture/backend.md                   §3 claim corrected; {*splat} -> {*path}
.claude/product/roadmap.md                        the one false sentence, per the ruling
apps/api/package.json                             + dotenv-cli devDependency
pnpm-lock.yaml
apps/api/src/common/route-inventory.ts            PathNormaliser; registeredPathsOf; claim wording
apps/api/src/common/route-inventory.spec.ts       + legacy-path test, + regex-path test
apps/api/src/common/access-assertion.spec.ts      + regex rogue-route test
apps/api/src/main.ts                              close() wrapped so it cannot eat the refusal
apps/api/src/modules/health/health.contracts.ts   LivenessReport; honest docblock
apps/api/src/modules/health/health.controller.ts  live(): LivenessReport
apps/api/src/openapi/generate.ts                  assertUniqueOperationIds
apps/api/src/openapi/generate.spec.ts             + 2 tests; 2 invalid fixtures repaired
apps/api/src/openapi/generate.integration.spec.ts + byte-equality test
apps/api/src/openapi/openapi.controller.ts        injects HttpAdapterHost for the normaliser
```

`apps/api/openapi.json` is unchanged and correct — see above.

## Concerns after this round

- **Finding 4 has no test.** Wrapping `app.close()` is a two-line defensive change on a path
  reached only when the assertion already threw *and* shutdown then also fails. Testing it would
  mean stubbing `close()` on a real application inside `bootstrap()`, which no test executes. I
  state this as uncovered rather than implying otherwise.
- **`normalizePath` may log twice for a legacy path.** `LegacyRouteConverter.tryConvert` prints
  a migration warning, and the inventory now calls it a second time on a path the router already
  converted. Harmless and arguably useful, but it is a real behavioural side effect of the fix
  that I did not suppress.
- **The `<unrecognised path: ...>` rendering is a sentinel string.** It cannot collide with a
  real path today because `RoutePathFactory` output always begins with `/`. That is a property
  of Nest's output rather than something enforced here.
- **`generate.spec.ts` fixtures now have to obey the uniqueness rule**, which is why two of them
  needed repair. This is the rule working, but it does make hand-built multi-route fixtures
  slightly more finicky to write.
- Unchanged from round one: `main.ts` boot ordering is guarded rather than directly tested; two
  deep imports into framework internals; `@ApiDoc` optional; `x-sentinel-access` is a vendor
  extension until Phase 2; `registeredRouterRoutes` reads Express 5's `app.router` only.
- Deferred by the controller, untouched here: `cli.ts` hardcoding logger level and `pretty`.

---

# Fix round 2 — the two Minors the fix round itself introduced

Commit: `5942482 fix(api): restore a stranded docblock, and close the gap it was claimed for`
Branch: `feat/phase-1-foundation` (not pushed). Parent: `d06cb21`.

Re-review of `813bc1e..d06cb21` returned all eight findings ADDRESSED with no new Critical or
Important breakage, and two Minors introduced by the fix round itself. Both are fixed here.
Nothing else in the diff was touched.

## On the pattern, before the fixes

This was the fourth true-looking-but-untrue claim on this branch and the second in two rounds.
The coordinator asked for reflection on the pattern rather than the line, so: both of my
instances have the same shape. I write a claim about coverage that exists **somewhere else**,
at the moment I have just finished proving something **adjacent** to it. In round one I had
just proven the type direction was protected (M11) and wrote that the other direction was
covered by an integration test — without opening that test. The proof of the adjacent thing
supplies the *feeling* of having checked, and the sentence gets written on that feeling.

The concrete rule I applied this round: **a sentence asserting that some other file covers
something is a claim that requires opening that file, and if the claim is about a test, running
it under mutation before the sentence is written.** I did that here in that order — verified
first, wrote second — and it changed what I wrote twice (see finding 2).

## 1. Stranded docblock — `generate.ts`

`assertUniqueOperationIds` had been inserted between `buildOpenApiDocument`'s docblock and
`buildOpenApiDocument` itself, so the new function carried two consecutive docblocks — the
first describing a different function — and `buildOpenApiDocument` had none.

Moved the "Builds the document from an already-collected route inventory" docblock back onto
`buildOpenApiDocument`. `assertUniqueOperationIds` keeps the docblock actually written for it.
No behaviour change; confirmed by the unchanged unit results below.

## 2. Unsupported coverage claim — `health.contracts.ts`

**Verified the reviewer's report before acting**, rather than taking it on trust:

```
$ grep -rn "readinessReportSchema|detailedReportSchema|livenessReportSchema" apps/api/src --include=*.spec.ts
NONE — the claim was false
```

`app.integration.spec.ts:335-338` pins `/health/detailed`'s key set against a hand-written
list; `app.integration.spec.ts:78-82` uses `toMatchObject`, which pins no key set at all.
Neither references a schema. The claim was false as written.

**I took option two — made the claim true — rather than deleting it**, because the gap is worth
closing on its merits: a field added to a schema that the handler never returns publishes an
OpenAPI document promising a field the API does not send, and nothing else catches it.

Added to `openapi/generate.integration.spec.ts` (this task's own spec, so another task's file
is not churned):

- `/health/ready returns exactly what readinessReportSchema requires`
- `/health/detailed returns exactly what detailedReportSchema requires`

Each fetches the live response and runs `schema.parse(body)`. A required key the handler does
not return is a `ZodError`. Parsed against the schema rather than compared to a key list
deliberately: a key list would be a third copy of the shape and would drift from both.

The docblock now states the direction the annotation covers, the direction it does not, that
the runtime test closes the second, and — the part I checked rather than assumed — that it is
the *only* check that closes it.

## Mutation verification

Copy-based backups; the edit asserts exactly one occurrence or aborts; restore verified with
`cmp -s`; suite re-run green afterwards.

### G1 — `readinessReportSchema` gains a field the handler never returns

```
MUTATION-APPLIED (1 occurrence)
--- does it still COMPILE? (the gap: it must, or the annotation already covered it) ---
 Tasks:    6 successful, 6 total          <-- compiles: the gap is real
--- does the new test catch it? ---
 Tests  3 failed | 5 passed (8)
RESTORED (byte-identical)
```

Per-test verdicts:

```
×  the OpenAPI document > the committed openapi.json matches what the code generates
×  the OpenAPI document > matches it byte for byte, not merely in structure
×  the published health schemas ... > /health/ready returns exactly what readinessReportSchema requires
✓  the published health schemas ... > /health/detailed returns exactly what detailedReportSchema requires
```

The new readiness test fails with `invalid_type` on `migrationState` — the right detector for
the right reason. The detailed test correctly stays green, since only the readiness schema was
mutated. The first half also confirms the premise: the mutation **compiles**, so the
`z.ZodType<T>` annotation genuinely does not cover this direction.

### G2 — the same mutation, with `openapi.json` regenerated

G1 alone would have let me write "the new test catches it", which is true but would have
implied more than I had shown: two committed-document tests also fired, and a reader could
reasonably conclude those were the real gate. So I ran the realistic path an author takes —
add the schema field, re-run `openapi:generate`:

```
✓  the boot-time access assertion ... > sees a non-empty inventory ...
✓  the boot-time access assertion ... > passes, because every route ... declares its access
✓  the OpenAPI document > the committed openapi.json matches what the code generates
✓  the OpenAPI document > matches it byte for byte, not merely in structure
✓  the OpenAPI document > documents every registered route
✓  the OpenAPI document > is served, unauthenticated, at /api/v1/openapi.json
×  the published health schemas ... > /health/ready returns exactly what readinessReportSchema requires
✓  the published health schemas ... > /health/detailed returns exactly what detailedReportSchema requires

 Tests  1 failed | 7 passed (8)
RESTORED (both byte-identical)
```

**Every other test goes green; the new test is the sole remaining failure.** That is what
licenses the docblock's "It is the only check that catches it", and it is why that clause is in
the docblock at all — I would not have written it from G1.

Both `health.contracts.ts` and `openapi.json` were restored byte-identically, verified by
`cmp -s`, and the suite re-run green (8 passed).

## Gate output

Docker Desktop was up and the compose stack healthy, so the integration lane ran against live
services. `lint`, `typecheck` and `build` were re-run with `--force`, so no result came from the
turbo cache.

```
===== 1/5 lint (forced) =====        Tasks: 11 successful, 11 total   Cached: 0 cached
===== 2/5 typecheck (forced) =====   Tasks: 11 successful, 11 total
===== 3/5 pnpm test =====            Tests  256 passed (256)     [unchanged — no unit test touched]
===== 4/5 pnpm test:integration ==== Tests  139 passed (139)     [was 137 — the two new tests]
===== 5/5 build (forced) =====       Tasks: 6 successful, 6 total     Cached: 0 cached
```

Unit count is deliberately unchanged: finding 1 is a comment move and finding 2 adds integration
tests only. Stating that plainly rather than implying the round broadened coverage anywhere else.

## Files changed this round

```
apps/api/src/openapi/generate.ts                   docblock moved back onto buildOpenApiDocument
apps/api/src/modules/health/health.contracts.ts    the coverage claim, made true and precise
apps/api/src/openapi/generate.integration.spec.ts  + 2 schema-vs-served-body tests
```

`apps/api/openapi.json` unchanged, confirmed by `git diff --stat` and by the byte-equality test.

## Concerns after this round

- **The new tests bind schema to body in one direction only.** `z.object` strips unknown keys,
  so a handler returning a field the schema omits still parses. That direction is the one the
  `z.ZodType<T>` annotation already covers at compile time, so the pair is complete between
  them — but neither test would catch it alone, and I am not claiming otherwise.
- **They require the live stack.** `/health/ready` returns 503 when a dependency is down, and
  the tests assert 200, so they fail loudly rather than silently if the compose stack is
  unhealthy. That is the correct failure mode, but it does mean these are integration-lane
  tests and contribute nothing to `pnpm test`.
- Unchanged and still open from earlier rounds: finding 4 of round one (the `app.close()`
  wrapper) has no test; `main.ts` boot ordering is guarded rather than directly tested; two deep
  imports into framework internals; `@ApiDoc` optional; `x-sentinel-access` is a vendor
  extension until Phase 2; `registeredRouterRoutes` reads Express 5's `app.router` only.
- Deferred by the controller, untouched: `cli.ts` hardcoding logger level and `pretty`.
