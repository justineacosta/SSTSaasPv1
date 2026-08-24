# SDD ledger — plan: docs/superpowers/plans/2026-08-20-phase-1-foundation.md

Spec: docs/superpowers/specs/2026-08-20-phase-1-foundation-design.md (read; binding authority)
Branch: feat/phase-1-foundation
Branch base (merge-base with main): e1bc10d
Plan committed at: 59bb8ed

## Setup rulings

Ruling: Work in place on `feat/phase-1-foundation` rather than a separate git worktree —
the user explicitly chose this branch in this directory, docker-compose bind paths and the
Docker Desktop stack are tied to `e:\GitHub\SSTSaasPv1`, and the branch is not main so the
worktree skill's actual guard (never implement on main without consent) is satisfied.
Cost if wrong: the user's working tree is occupied during execution; recoverable by
`git worktree add` at any point since all work is committed.

## Pre-flight conflict scan

### Cross-task: shared files and interfaces

| A | B | A produces | B consumes | Finding |
|---|---|---|---|---|
| 1 | 4, 13, 14 | root `package.json` scripts | db:*, test:e2e, check:* appended | Clean — sequential appends |
| 1 | 7 | `eslint.config.js` overrides | seed.ts needs `process.env` | **F1** — spec-file override block omits `no-restricted-properties` |
| 1 | 12 | `vitest.workspace.ts` (node env) | packages/ui needs jsdom | **F2** — inline projects; a per-package vitest.config.ts is not picked up |
| 1 | 14 | unit include globs `packages/*/src`, `apps/*/src` | `scripts/*.spec.ts` | **F3** — `scripts/` matches no include glob; the test would never run |
| 1 | 1 | flat config lints `**/*` type-aware | `eslint.config.js` is JS, in no tsconfig | **F4** — projectService errors on root JS config files |
| 4 | 6 | `packages/db/src/index.ts` | extended with tenant exports | Clean — plan states the extension explicitly |
| 4 | 7 | `db:seed` script → `src/seed.ts` | file created in Task 7 | Minor — script is not invoked in Task 4; no build break |
| 4 | 6, 7 | Prisma models, `newId` | harness, tenant client, seed | Clean |
| 5 | 7 | `PERMISSIONS`, `ROLE_PERMISSIONS`, `SYSTEM_ROLES` | seed grants | Clean — 5 precedes 7 |
| 5 | 9, 11 | `ErrorCode`, `Permission`, envelope | filter, `@RequirePermission` | Clean — 5 precedes both |
| 6 | 7 | `startPostgresHarness()` → `{ownerUrl, appUrl, stop}` | seed integration test | Clean |
| 6 | 14 | `TENANT_OWNED_MODELS` | registry completeness check | Clean |
| 9 | 10 | `DomainError(code, msg, status, details?)` | rate-limit 429 | Clean |
| 9 | 11 | `main.ts`, `@Public()` on health routes | assertion consumes the decorator | **F5** — Task 9 *uses* `@Public()`; Task 11 *creates* it |
| 9 | 9 | `setGlobalPrefix('api')` + `VERSION_NEUTRAL` health | test asserts `GET /health/live` | **F6** — global prefix would make it `/api/health/live` |
| 10 | 11 | `__test` routes for fail-open/closed | boot assertion requires a declaration | **F7** — untest-declared routes would crash boot at Task 11 |
| 11 | 14 | `generateOpenApiDocument`, `openapi.json` | `check:openapi` | Clean |
| 12 | 13 | tokens + primitives | web shell | Clean |
| 8 | — | `.claude/folder-structure.md`, `overview.md` | — | Clean — sole writer |
| 15 | — | `CLAUDE.md`, `.claude/README.md` | — | Clean — sole writer |
| 16 | — | `roadmap.md`, `repository-audit.md`, `setup.md`, ADRs | — | Clean — sole writer |

### Per-task self-consistency

| Task | Tests vs code it specifies | Files created vs later touched | Finding |
|---|---|---|---|
| 1 | n/a — no tests | consistent | F4 above |
| 2 | test imports match exports exactly | consistent | Clean |
| 3 | `createLogger({stream})` in test; `stream` in `CreateLoggerOptions` | consistent | Clean |
| 4 | id spec matches `newId`/`parseIdPrefix`/`ID_PREFIXES` | consistent | Minor: `Invitation @@unique([organizationId,email])` blocks re-invite after revoke — Phase 2 concern, deferred |
| 5 | matrix test parses the real doc; impl transcribes it | consistent | Clean |
| 6 | extension + RLS assertions match the implementation | consistent | Minor: `upsert` scopes `where`/`create` but not `update` — the scoped `where` already constrains it |
| 7 | seed test matches `seedReferenceData` signature | consistent | Clean (top-level await in seed.ts is fine; nothing CJS imports it) |
| 8 | key + adapter tests match both interfaces | consistent | Clean |
| 9 | filter test matches `AllExceptionsFilter`; integration matches middleware | consistent | F5, F6 |
| 10 | config test matches `RATE_LIMIT_CLASSES` shape | consistent | F7 |
| 11 | pure-function test matches `findRoutesWithoutAccessDeclaration` | consistent | Clean |
| 12 | token test parses the CSS the task writes | consistent | F2 |
| 13 | header test matches `buildSecurityHeaders` | `src/` beside `app/` is legal in Next | Clean |
| 14 | pure-function tests match both exported helpers | consistent | F3 |
| 15 | n/a — documentation | consistent | Clean |
| 16 | n/a — verification pass | consistent | Clean |

### Rulings on the findings

**F1** Ruling: Task 1's `**/*.spec.ts` ESLint override also sets
`'no-restricted-properties': 'off'`. Test harnesses legitimately read `process.env` to build
child-process environments (Task 4's migration spec, Task 6's harness). The rule exists to keep
env reading out of *application* code; a test file is not application code.
Cost if wrong: a test could read env directly where it should take a parameter — visible in review.

**F2** Ruling: Task 12 does **not** add `packages/ui/vitest.config.ts`. It adds
`environmentMatchGlobs: [['packages/ui/**', 'jsdom']]` to the `unit` project in
`vitest.workspace.ts`. `defineWorkspace` with inline project objects does not discover
per-package configs, so the file the plan describes would be silently ignored and the component
tests would fail in a `node` environment with a confusing DOM error.
Cost if wrong: component tests run in the wrong environment; fails loudly and immediately.

**F3** Ruling: Task 1's `unit` project include list gains `scripts/**/*.spec.ts`. Without it
Task 14's registry-check tests exist and never run, which is worse than not writing them —
they would read as coverage that is not there.
Cost if wrong: none material; a broader glob at most picks up other root-level specs, which is
what we want anyway.

**F4** Ruling: Task 1's flat config adds a JS-only block for root config files
(`eslint.config.js`, `*.config.js`, `*.config.mjs`) that applies `js.configs.recommended`
without the type-aware `recommendedTypeChecked` rules, since those files are in no tsconfig
project. Alternative considered and rejected: adding them to a tsconfig, which pollutes the
build graph for two config files.
Cost if wrong: root config files get slightly weaker linting than source. Acceptable.

**F5** Ruling: **Task 9 creates `access.decorator.ts`** with `@Public()` and
`@RequirePermission(permission: Permission)` plus `ACCESS_METADATA_KEY`. Task 11 keeps the
*assertion* (`findRoutesWithoutAccessDeclaration`, `assertEveryRouteDeclaresAccess`) and the
OpenAPI work, and no longer creates the decorators. The decorators are trivial metadata
setters and Task 9's health controller cannot compile without them; the ordering in the plan
is simply wrong. The spec (§3.7) requires both to exist in Phase 1 and does not assign them
to a particular commit, so nothing in the binding authority is contradicted.
Cost if wrong: none — the same code ships, one task earlier.

**F6** Ruling: Task 9 uses `setGlobalPrefix('api', { exclude: [{ path: 'health/(.*)', method: RequestMethod.ALL }] })`
so health probes answer at `/health/live`, `/health/ready`, `/health/detailed`.
`.claude/operations/monitoring.md` §5 and `.claude/architecture/backend.md` §8 both write these
paths without the `/api/v1` prefix, and an orchestrator's probe config should not have to know
the API's versioning scheme. The plan's own integration test asserts the unprefixed path.
Cost if wrong: probe URLs differ from a future deployment manifest; a one-line change.

**F7** Ruling: Task 10's `APP_ENV === 'test'` fixture routes must carry `@Public()`. Without it
they are undeclared routes, and Task 11's boot assertion — correctly — crashes the app in the
test environment. Carried into Task 10's dispatch.
Cost if wrong: Task 11's integration tests fail loudly at boot. Self-revealing.

**Deferred minors (not blocking, surfaced to the final review):**
- Task 4: `Invitation @@unique([organizationId, email])` prevents re-inviting an address whose
  earlier invitation was revoked. Correct behaviour is a partial unique index over live rows.
  Phase 2 owns invitations; recorded so it is not discovered by a customer.
- Task 4/7/14: `node --experimental-strip-types` — TypeScript stripping is unflagged from Node
  23 onward, so the flag is at best redundant on Node 26. Implementers use whatever the runtime
  accepts.

## Task progress

### Task 1 — Workspace skeleton, tooling, green CI

Base: 92aad0f · Implementer agent: a5c761b95628f41b7 (sonnet)
Task 1: implementer DONE — commit 12831ef, all five verification commands exit 0.
Task 1: implementer adaptations accepted — `--passWithNoTests` CLI flag (config-level option
  does not work with `--project` filtering on vitest 3.2.7, reproduced by the reviewer);
  R3 glob extended to `vitest.workspace.ts` / `*.config.ts` (same parsing failure, same
  mechanism); `allowBuilds` for esbuild + unrs-resolver in pnpm-workspace.yaml (pnpm 11
  install-time build gate; both are genuine transitive deps of vitest and eslint).
Task 1: review — spec ✅, quality Approved, 1 Important + 1 Minor.
  Important: eslint.config.js root-config block omits `languageOptions.globals`, so `no-undef`
  misfires on `process`/`console` in root-level config files. Reviewer verified the security
  surface is unaffected (packages/config still lints clean) but Task 13's playwright.config.ts
  would hit it. → fix round 1.
  Minor (deferred): vitest.workspace.ts deprecation warning — the brief mandates that file;
  migration to `test.projects` is future work.
Task 1: ⚠️ resolved by controller — "CI green on GitHub Actions" cannot be verified because
  nothing is pushed. Ruling: not a Task 1 gap. Pushing is an outward-facing action requiring
  the user's consent, and exit criterion 4 is owned by Task 16. Local equivalents of every CI
  step pass. Cost if wrong: a CI-only failure (runner OS, cache, missing service) surfaces
  later than it could.
Task 1: fix round 1/5 (1 addressed, 0 open — languageOptions.globals added to the root-config
  block, `globals@15.15.0` in devDependencies; commits 12831ef..d770e0f). Re-reviewer verified
  independently with its own probes: no-undef no longer fires on process/console, no-console and
  no-restricted-properties still do, no-undef still fires on `window`, and the glob is root-only
  so globals.node cannot leak into packages/** or apps/**.
Task 1: complete (commits 92aad0f..d770e0f, review clean)

### Task 2 — packages/config

Base: d770e0f
Task 2: implementer DONE_WITH_CONCERNS — commit 9fd13c6, 6/6 tests pass, four root commands
  exit 0. Concerns: (a) fixed a real Task 1 eslint.config.js defect — projectService could not
  resolve spec files excluded from each package's build tsconfig — using `allowDefaultProject`;
  (b) added `ignoreRestSiblings` to no-unused-vars (the brief's own test destructures to omit);
  (c) dropped an unused `import { z }` from the brief's verbatim test.
Task 2: Ruling: replace `allowDefaultProject` with a per-package tsconfig split —
  `tsconfig.json` (includes specs; used by editor, ESLint projectService, and `typecheck`) plus
  `tsconfig.build.json` (excludes specs; the only thing that emits). Why: typescript-eslint
  forbids `**` in allowDefaultProject globs, so the workaround reaches only specs directly under
  `src/`, and Tasks 9, 10, 11, 12 and 13 all place specs in subdirectories — each would hit the
  same error and each would append another glob. It also closes a hole the workaround left: the
  package tsconfig excluded specs from `typecheck` as well as from `build`, so no test file was
  being type-checked at all. Cost if wrong: one extra tsconfig per package; cheap and reversible.
  Concerns (b) and (c) accepted as correct.
Task 2: ruling applied and proved — commit 390dcc4. Nested-spec probe: ESLint clean (no
  project-service error), `typecheck` fails on a deliberate type error in a nested spec, `build`
  still succeeds and dist/ has no spec output. Reviewer reproduced all three independently.
Task 2: review — spec ✅, quality NOT APPROVED, 1 Critical.
  Critical: load-env.ts interpolates Zod's `issue.message`, and `invalid_enum_value` embeds the
  received value verbatim — so NODE_ENV, APP_ENV, LOG_LEVEL and STORAGE_FORCE_PATH_STYLE all
  leak their invalid value into EnvValidationError.message, contradicting the class docstring.
  Compounding: the brief's own guard test is vacuous — its DATABASE_URL input passes validation,
  so the bare try/catch never reaches its assertion. Green whether or not the property holds.
Task 2: Ruling: overrule the plan's test text. The spec's requirement (errors name variables,
  never values) is binding; the plan's test does not implement it. Fix by construction, not by
  audit: build detail lines from `issue.code` + `issue.path` only, never `issue.message`, with an
  owned code→explanation map; for enum/literal failures name the EXPECTED options only. Replace
  the vacuous test with a sentinel property test over every key of apiEnvSchema that also asserts
  at least one key threw, so the loop cannot degenerate into no-ops. Why: auditing which Zod
  codes are safe today is a check that expires silently on the next Zod upgrade. Cost if wrong:
  slightly less detailed validation messages than Zod's defaults.
Task 2: ⚠️ resolved by controller — reviewer could not independently re-verify the RED run for
  the six-test file (pre-commit state leaves no artifact). Transcript is specific, and the
  base-commit RED (`Cannot find module './load-env.js'`) is a genuine right-reason failure.
  Accepted; not a gap.
Task 2: fix round 1/5 (1 addressed, 0 open — describeIssue() builds detail from issue.code and
  safe structural fields only; zero live reads of issue.message; sentinel property test over
  every apiEnvSchema key plus a targeted APP_ENV test; the DATABASE_URL test now genuinely
  throws; commits 390dcc4..294f2eb). Re-reviewer independently checked the whole error surface
  (message, own enumerable props, JSON.stringify, toString, stack, cause) and reproduced the
  non-vacuity proof by reverting the one line — both new tests failed naming exactly the four
  z.enum fields, then restored byte-identical with sha256 match.
Task 2: complete (commits d770e0f..294f2eb, review clean)

### Task 3 — packages/observability

Base: 294f2eb
Convention now established for every later package: `tsconfig.json` (includes specs; editor +
ESLint projectService + `typecheck`) and `tsconfig.build.json` (excludes specs; the only emitter).
Task 3: implementer DONE_WITH_CONCERNS — commit d856973, 21/21 tests, four root commands exit 0.
Task 3: Ruling: accept removal of 'credential' from SECRET_KEY_FRAGMENTS. The plan's own
  nested-key test requires the `credential` container to stay walkable while `passwordHash`
  inside it is redacted, which is impossible with 'credential' in the fragment list, and the
  source list in monitoring.md §2 does not contain it. Plan was internally inconsistent;
  resolved toward the source document. Cost if wrong: a key literally named `credential` holding
  a secret directly would rely on the value-shape backstop instead of the name denylist.
Task 3: Ruling: close both Pino bypasses the implementer found — a secret in the `msg` string
  and a secret in `Error.message` both skip formatters.log. Add `hooks.logMethod` applying
  substring redaction to `msg`, and a custom `err` serializer redacting message and stack
  (keeping the stack, since redact() drops nested stacks specifically because the serializer is
  where they are wanted). Substring replacement, not whole-value, so an operator can still read
  what happened. Export the text redactor for Task 9's error filter to reuse. Why: monitoring.md
  §2 says "never logged: credentials of any kind" without qualifying argument position, and a
  redaction layer with a documented bypass is worse than none — it produces confident reviewers.
  Cost if wrong: logMethod hook adds per-call regex work on the msg string; measurable only at
  very high log volume, and revisitable.
Task 3: Ruling: keep the try/catch around property reads (I required it). Logging is on the
  error path; a logger that throws while reporting a failure hides the original failure.
Task 3: pretty:true transport path — implementer to report whether redaction survives the worker
  thread. If not, that is a separate ruling; pretty-printing is development-only.
Task 3: msg + err.message/stack gaps closed (commit 1bb5d72); `redactSecretsInText` exported for
  Task 9. pretty:true transport verified safe on all three paths by real stdout capture — no gap.
Task 3: Ruling: fix the third gap the implementer found — `logger.error(err)` and
  `logger.error({ err })` with no message argument still leak err.message into the top-level
  `msg`, because pino derives msg from the raw error after the logMethod hook runs. Fix by
  PREEMPTION, not by replicating pino's fallback: when there is exactly one argument and it is
  an Error (or an object whose `err` is an Error), call through with an explicit redacted msg so
  the fallback never fires. Only those two shapes need it. Why: `logger.error(err)` is the most
  common way anyone logs an error, so this is the highest-traffic path of the three — worse than
  the two already fixed, which at least required someone to hand-format a string. Cost if wrong:
  a bare-Error log line's msg is produced by us rather than pino; asserted byte-identical for
  secret-free messages.
Task 3: third gap closed by preemption (commit 4058db6). `errorKey` confirmed unreadable at hook
  time (private Symbol, no public accessor) — hardcoded 'err' with a note. Child-logger
  inheritance checked: no gap.
Task 3: Ruling: printf-style interpolation (`logger.info('token=%s', secret)`) gets a PARTIAL
  fix only — apply the value-shape backstop to each trailing interpolation argument, document
  the residual in createLogger's docblock, and stop. Why: unlike the previous three gaps, this
  one has no key name to inspect, so it cannot be made structurally safe at any effort level; an
  opaque high-entropy string in an unnamed position is indistinguishable from a scan ID.
  Explicitly NOT interpolating the format string ourselves — that means reimplementing pino's
  %s/%d/%j/%o semantics, and the cure is worse than the residual. Cost if wrong: a secret that
  matches none of the known shapes, passed printf-style, reaches the log.
Task 3: deferred (for final-review triage) — a lint rule banning printf-style logger calls is the
  real fix for that class, in the spirit of coding-standards.md §6. Belongs with the lint work,
  not Task 3's fourth fix round.

## Session note

USER REQUEST (mid-execution): pause after the current task completes. Task 3's review is the
last work before handing back. Tasks 4-16 are held, not abandoned; resume by dispatching Task 4
against base = Task 3's final commit.
Task 3: printf backstop applied (commit 7836f50), residual documented in createLogger's docblock.
Task 3: Ruling: authorize ONE final round for the two gaps found on the closing sweep, then
  review regardless. (a) `formatters.bindings` running redact() — `logger.child({apiKey})`
  currently bypasses redaction entirely and, unlike every other gap, leaks on EVERY subsequent
  line rather than once; child loggers will be the standard way this codebase attaches
  organizationId/requestId, so children will be everywhere. (b) text-scan the message in
  redact()'s `instanceof Error` branch, so a nested error gets the same treatment as a top-level
  `err`. Why this is not scope creep after capping the printf case: both are one-line
  applications of the already-tested redactor to existing code paths — no new mechanism, no pino
  internals. Cost if wrong: two more lines of hook code and four more tests.
Task 3: INTERRUPTION — the final-round agent was killed mid-work by a session usage limit
  (reset since). Recovery state verified by the controller, not assumed: HEAD still 7836f50,
  nothing from the round committed; both authorized changes present but uncommitted
  (formatters.bindings in logger.ts, redactSecretsInText on the Error branch in redaction.ts);
  `pnpm typecheck` green and 27/27 observability tests passing, so the tree was left working
  rather than half-broken. Lost work was the four tests, the RED/GREEN proof, the
  double-redaction probe, the report update, and the commit. Agent resumed on exactly those.
  Note: the agent's in-code comment already asserts the double-redaction conclusion; it was
  interrupted just as it said it was about to probe it, so the resume explicitly requires
  confirming or correcting that comment.
Task 3: commit 5e5d66c — nested-Error text-scan works (2 tests, RED/GREEN). BUT the
  formatters.bindings fix authorized last round does NOT work: implementer read pino's source and
  found child bindings bypass it. Controller verified independently in
  pino@9.14.0/lib/proto.js — both branches of child() (fast path L98-107, options path L142-153)
  assign `resetChildingsFormatter = bindings => bindings` BEFORE calling asChindings, so a
  root-level formatters.bindings can never see child bindings, by construction. Implementer also
  caught its own in-code comment asserting a verification it had not performed and corrected it,
  and declined to write the two specified tests because they would have been permanently red or
  quietly unrealistic. Both calls correct.
Task 3: Ruling: one final change, with the design supplied rather than researched — wrap `child`
  as an own property on the logger instance, redacting bindings before delegating. Pino builds
  children with Object.create(this), so a single own property is inherited by every descendant
  and `this` binds correctly at each level; no recursion needed. Keep formatters.bindings (it
  still covers the root logger's base bindings) but correct its comment, which currently claims
  coverage the code does not have. Why a fifth round after twice saying "last": this is a
  supplied six-line design verified against pino's implementation, not an investigation, and the
  alternative is shipping a security package whose highest-severity path leaks on every line of
  every child logger. Escape hatch given: if the design does not work as sketched, revert to the
  documented-gap state and go to review with an honest residual rather than iterate again.
Task 3: child() wrapper works (commit 5bcc473); implementer verified standard child, grandchild,
  two-argument form and pretty:true against a real built logger before writing tests.
Task 3: review (opus, ~40 probes against the compiled package) — spec ❌, quality NOT APPROVED.
  C1 logger.error(err, undefined) leaks the raw message — preemption gated on argument count
    rather than on "no string message present"; Task 9's filter will produce exactly this shape.
  C2 own-enumerable toJSON resurrects the whole redacted subtree at any depth and through child
    bindings — defeats key-name matching, not just the value backstop.
  C3 non-string Error.message crashes the logger — redactSecretsInText has no type guard; plain
    pino does not crash here, so this is introduced by us, on the error path.
  I4 throwing-getter guard misses the top level — formatters.log rest-destructures before
    redact() runs, invoking getters outside the try/catch.
  I5 (residual) caller-registered err serializer receives the raw Error.
  I6 (residual) a secret in a KEY NAME is emitted verbatim.
  Coverage-list items 1 and 2 overstate coverage — reviewer flagged this as serious, correctly:
    a wrong coverage claim is worse than a known gap because it stops anyone looking again.
  Verified sound under probing: Symbol keys, prototype chains and prototype getters, err.cause,
    AggregateError, depth boundary (fails closed), circular graphs, null-prototype objects,
    BigInt, %o interpolation, no ReDoS, and the entire wrapChild surface.
Task 3: Ruling: fix C1, C2, C3, I4; promote M9 (the spread order lets a log field shadow
  requestId and the comment claims the opposite — a lying comment is the defect class this task
  keeps hitting) and M8-Date (Date serialising to {} is a real regression against stock pino).
  C3 fails CLOSED to REDACTED rather than String(text), because a hostile toString throws and
  returns us to the same crash. Document I5/I6 as residuals; move the printf note into
  createLogger's docblock where ruling 4 put it. Require logger-level crash-safety tests: every
  such property is currently tested against redact() directly and never through createLogger,
  which is precisely why I4 survived six rounds.
Task 3: deferred to final review — M7 (shared non-circular refs mislabelled [circular]),
  M10 (four denylist fragments dead after underscore-stripping; monitoring.md source comment
  inaccurate in both directions), M11 (duplicate test).
Task 3: fix round 1/5 (5 addressed, 1 open; commits 5bcc473..fbbf0c8). C1, C2, I4, M9, M8-Date
  all verified ADDRESSED by direct reproduction against the compiled logger. Re-reviewer also
  checked and upheld the implementer's judgement on rewriting the circular-reference test: the
  extra nesting level on a self-referencing top-level object is a cosmetic consequence of I4's
  guarded walk creating a new rest object — no crash, no recursion, no leak.
  STILL OPEN — C3: the crash moved one layer earlier rather than closing. `pino.stdSerializers.err`
  reads `.stack`, whose lazy V8 accessor runs Error.prepareStackTrace -> Error.prototype.toString()
  -> ToString(message); a Symbol message throws per spec and a hostile toString propagates, both
  before redactSecretsInText's guard is reached. Escapes logger.error() to the caller from
  logger.ts:80.
Task 3: Ruling: wrap the stdSerializers.err call in try/catch and fail closed to
  { type, message: REDACTED, stack: REDACTED }, being defensive in the fallback too since
  error.name can itself be a hostile getter. Also correct two docs: the new C2 comment groups URL
  with Date as "nothing legitimate is lost", which is false (URL still collapses to {}), and
  coverage item 2 now reads as claiming the top-level err path no longer crashes. Explicitly NOT
  fixing URL behaviour — record it as a residual. Why the doc corrections matter as much as the
  code: this task has spent six rounds removing comments that overstated coverage, and adding a
  new one in the fix that removes the last batch would be the same defect.
Task 3: after the next scoped re-review, Task 3 CLOSES either way — anything still open gets
  parked with a written ruling rather than a seventh round.
Task 3: fix round 2/5 (1 addressed, 0 open; commits fbbf0c8..027d8f7). C3 closed. The
  implementer corrected BOTH the reviewer's and the controller's diagnosis by reading the actual
  escaping stack trace: stdSerializers.err does not throw — pino-std-serializers' isErrorLike
  check (typeof err.message === 'string') is false, so it short-circuits and returns the raw
  Error; the throw came one statement later, destructuring `.stack` on a V8 error whose stack was
  never materialised. Re-reviewer independently reproduced this (serialized === err proves the
  call returned normally) and captured the trace. Widened try/catch covers it.
  Re-reviewer probed Symbol / hostile toString / hostile Symbol.toPrimitive / null / undefined /
  BigInt messages, hostile stack, name and constructor getters, via both logger.error(err) and
  logger.error({err},'msg'), plus nested errors — none threw. Confirmed the catch does NOT fire
  on healthy input, so no wholesale-swallow regression.
Task 3: complete (commits 294f2eb..027d8f7, review clean after 2 review fix rounds and 5 earlier
  pre-review concern rounds)

## PAUSED at user request — 2026-08-20

State: Tasks 1-3 complete and reviewed clean. HEAD 027d8f7 on feat/phase-1-foundation.
Nothing pushed to GitHub. Phase 0 still unmerged to main. roadmap.md still says Phase 1 is
"Not Implemented" — correct, because Task 16 owns that status move and has not run.
Resume by: dispatching Task 4 with base = 027d8f7. Briefs for Tasks 2 and 3 already extracted;
task-4-brief.md not yet generated.
Carry into Task 4's dispatch: the per-package tsconfig split convention (tsconfig.json includes
specs, tsconfig.build.json excludes and is the only emitter), and the F5/F6 pre-flight rulings
for Tasks 9-10 when those come up.

## Pushed to GitHub — 2026-08-20 (user instruction: "Push everything to github main")

main fast-forwarded e1bc10d..027d8f7 (17 commits, 121 files) and pushed. feat/phase-1-foundation
also pushed with upstream tracking; work continues there, not on main.
Controller noted once that coding-standards.md §9 forbids committing directly to main and that
this bypassed the PR flow chosen earlier; user instructed directly, so proceeded. Clean
fast-forward, not a force-push, therefore reversible.
Pre-push secret scan: no .env / .pem / .key / credentials tracked; no live-credential patterns
(sk_live_, AKIA…, ghp_, PEM headers) in tracked non-md files. The eyJhbGci… hits are the fake
JWT fixture the redaction tests assert against. .superpowers/ confirmed untracked.

CI: GREEN on main (run 32359572904) — every step succeeded on Node 26 / ubuntu-latest:
  install --frozen-lockfile, Lint, Typecheck, Unit tests, Integration tests, Build.
  This resolves the ⚠️ items parked in Tasks 1 and 2 ("CI green on GitHub Actions cannot be
  verified because nothing is pushed"). Exit criterion 4 now has real evidence.
  HONEST CAVEAT: the "Integration tests" step is green but currently vacuous — no
  *.integration.spec.ts exists yet, so it passes via --passWithNoTests. It becomes a real gate at
  Task 4, which is also the first time Testcontainers runs on the GitHub runner. Do not read
  today's green as proof that Testcontainers works in CI.

### Task 4 — Compose stack, db schema, prefixed UUIDv7 IDs, first migration

Base: 027d8f7 · Implementer agent: a78920b2121da18eb (sonnet)
Environment note: Docker Desktop had stopped since session start; controller relaunched it and
  waited for the daemon rather than blocking the user.
Task 4: implementer DONE_WITH_CONCERNS — commit 947ff4d. 6/6 ID tests, 1/1 migration integration
  test, 57/57 workspace unit tests, four root commands exit 0.
Task 4: *** PRISMA ON NODE 26 WORKS *** — Prisma/@prisma/client 6.19.3 on Node v26.7.0, native
  Node-API query engine generates, loads and migrates with no fallback. This is the plan's §5
  headline risk and the evidence ADR-0012 needs. Caveat: Windows only
  (query_engine-windows.dll.node); Linux/CI confirmation arrives on the next push.
Task 4: review (opus, verified against the LIVE database rather than schema text) — spec ✅,
  quality NOT APPROVED.
  C1 (Critical): branch does not lint or typecheck on a clean checkout. packages/db/generated/ is
    gitignored; turbo's dependsOn ^build means DEPENDENCIES' build, not the package's own, and CI
    runs Build last. Reviewer proved it by deleting generated/ and also confirmed @prisma/client's
    postinstall does not cover it. Our green CI could not have caught this — it ran on 027d8f7,
    before packages/db existed.
  I1: the migration test does not cover the init SQL's privileges at all — reviewer deleted every
    GRANT and the whole ALTER DEFAULT PRIVILEGES block and the test still passed. Migrations run
    as the container superuser. The implementer's report claim to the contrary is wrong.
  I2: pg_isready without -h uses the unix socket, which the entrypoint's temporary init server
    also listens on — measured 6 seconds of "healthy" before sentinel_app existed.
  I3: Membership @@unique([organizationId,userId]) is a full unique index on a soft-deleting
    table; remove-then-re-add raises duplicate-key. Verified live.
  Verified sound: all 19 indexes with tenant columns LEADING, 11 FKs with intended ON DELETE, all
    unique constraints, timestamptz/UTC throughout, sentinel_app rolsuper=f rolbypassrls=f,
    ALTER DEFAULT PRIVILEGES proven to reach post-migration tables (reviewer created one), MinIO
    buckets private (unauthenticated GET → 403), ID encoding correct/total/order-preserving over
    200k samples plus both boundary values.
Task 4: Ruling on I3: DEFER the fix to Phase 2, document it now. Prisma cannot express a partial
  unique index in schema, so the correct form needs a hand-written migration plus drift
  management; nothing in Phase 1 sets deletedAt on a Membership; Phase 2 owns membership
  management and is where the migration belongs. Required: a comment on the @@unique naming the
  partial-index fix and the flow it breaks, plus a roadmap note at Task 16 — it must not be
  DISCOVERED in Phase 2. Cost if wrong: Phase 2 hits a duplicate-key error on remove-then-re-add
  and fixes it there, which is where the fix belongs anyway.
Task 4: Ruling: accept fnd/scn prefix additions. The brief genuinely contradicts itself — its own
  test calls newId('fnd') and IdPrefix is keyof typeof ID_PREFIXES. In a TDD brief the test file
  is the normative artefact; rewriting it to fit the code would be editing the evidence.
  ID_PREFIXES is a pure string registry with no coupling to Prisma models. (Controller note: my
  pre-flight scan missed this contradiction.)
Task 4: Ruling: replace sync-env.mjs with dotenv-cli. The workaround is legitimate and NOT a
  secrets.md violation (the copy is gitignored; the root .env is itself uncommitted), but the
  reviewer verified `dotenv -e .env -- pnpm --filter @sentinel/db exec prisma …` works and it
  removes a class of problem for one devDependency: no second on-disk copy of credentials
  protected only by a glob, no unlinted script outside `eslint src`, no file a developer can edit
  and silently lose. Escape hatch: if it does not work cleanly, keep the script and say so —
  this is a preference, not a correctness issue.
Task 4: also fixing M4 (AuditEvent docstring claims a control that does not exist — present tense
  trips the honesty rule), M8 (published ports bound to 0.0.0.0, including a deliberately
  vulnerable Juice Shop under --profile testing — indefensible default for this product),
  M10 (compose project name), M1 and M2 (both proven weak by mutation: deleting the
  registry-membership guard and swapping Y/Z in ALPHABET each leave all tests green).
Task 4: deferred to final review — M3 (sentinel_app holds arwd on _prisma_migrations), M5
  (AuditEvent cascades on organization delete), M6 (Session.activeOrganizationId has no FK or
  index), M7 (updatedAt has no DB default — raw-SQL inserts must supply it; matters for Task 7),
  M9 (redis-cli ping is the liveness idiom).
Task 4: fix round 1/5 (all addressed, 0 open; commits 947ff4d..02db24f). Re-reviewer
  mutation-tested the three findings previously proven weak rather than reading them:
  I1 — stripped the GRANT/ALTER DEFAULT PRIVILEGES block, the new CRUD assertion went red with
    permission denied 42501, restored, green.
  M1 — reverted the registry guard, exactly the new unregistered-prefix test failed.
  M2 — swapped Y/Z in ALPHABET; the OLD 5ms-gap test stayed green (confirming its documented
    weakness) while the new 1000-ID same-millisecond test failed.
  C1 — full clean-checkout reproduction: wiped node_modules, all dist/.turbo, and generated/,
    then ran the exact CI order; postinstall produced generated/client BEFORE any turbo task, and
    lint/typecheck ran with 0 cached tasks, proving real execution rather than stale artifacts.
  sync-env swap confirmed: packages/db/scripts/ gone, no packages/db/prisma/.env on disk, root
    .env is the single credential copy, and `pnpm db:migrate` exercised end-to-end.
  Loopback binding confirmed not to break service-to-service traffic (minio-init reaches
  minio:9000 over the Docker network; all four buckets created).
Task 4: complete (commits 027d8f7..02db24f, review clean)
Task 4: environment note carried forward — `cpu-features` (transitive via ssh2/dockerode, used by
  Testcontainers) fails its MSVC native build on this Windows host. Install still exits 0 and
  everything works; pre-existing and out of scope, but worth knowing if Testcontainers misbehaves
  later.

### Task 5 — packages/contracts

Base: 02db24f
Task 5: implementer DONE — commit 0990cbb. 14/14 contracts tests, 74/74 workspace, four root
  commands exit 0. Matrix matched permissions.md on first transcription; implementer
  mutation-verified by flipping MEMBER/finding.accept_risk.
Task 5: review — spec ✅, quality APPROVED. No Critical or Important findings.
  Reviewer hand-checked all 49 permissions x 7 roles against the document including the four
  deliberate oddities, confirmed ERROR_CODES is exactly the 36 codes in api/errors.md §3, and
  mutation-tested the matrix across SEVEN failure shapes rather than the one the implementer
  tried: removed grant, first-column (OWNER) cell, last-column (GUEST) cell, whole permission
  removed, invented permission added, role order changed, and a P cell reclassified. All caught.
  Also confirmed the parser strips **bold** emphasis (the AUDITOR row uses it), throws rather than
  silently proceeding if the header is missing, stops at the table end, and cannot under-read;
  and that idSchema rejects wrong prefix, Crockford-excluded characters, off-by-one length, and
  embedded newlines (JS `$` without /m is strict end-of-string).
Task 5: deferred to final review — implementer's report says "39 codes" where the actual and
  correct count is 36 (prose only, shipped file is right); parseMatrix locates the table via
  findIndex on the first matching header, so a second same-shaped table in the doc would be
  silently ignored (not exploitable today).
Task 5: complete (commits 02db24f..0990cbb, review clean)

### Task 6 — Tenant-scoped Prisma client, RLS, resource registry, isolation harness

Base: 0990cbb
THIS IS THE TASK PHASE 1 EXISTS FOR — exit criterion 5.
Task 6: implementer DONE_WITH_CONCERNS — commit 17989c8 (14 files, +596/-7). 74 unit + 21
  integration passing (4 migration + 11 tenant-client + 6 RLS); lint/typecheck/build exit 0.
  All four control-removal drills detected as required: findUnique rewrite removed -> a real
  cross-tenant row leaked; no-context guard removed -> silent empty result instead of a throw;
  AuditEvent policy dropped -> backstop test broke; FORCE dropped from Membership -> caught.
Task 6: *** REAL VULNERABILITY FOUND AND FIXED BEYOND THE BRIEF *** — update/updateMany/upsert
  scoped only `where`, not `data`, so a caller could re-parent its own row into another tenant by
  passing data.organizationId. Implementer verified the exploit worked BEFORE fixing it and added
  a regression test. The brief (and therefore the plan, and therefore my pre-flight scan) missed
  this. Also added createManyAndReturn / updateManyAndReturn — Prisma 6.19 operations absent from
  the brief's scoped sets, which were previously fail-closed by throwing.
Task 6: OPEN CONCERNS (not yet reviewed):
  (1) The FORCE drill detects via pg_class.relforcerowsecurity metadata, not behaviourally — no
      test role is a non-superuser table owner, so the actual owner-bypass scenario FORCE exists
      to prevent is never exercised.
  (2) *** A NAMED SECURITY CONTROL IS INERT REPO-WIDE *** — eslint.config.js:59 restricts the
      group ['**/unscoped', '@sentinel/db/unscoped'], which does NOT match './unscoped.js'. This
      repo is ESM and every relative import carries the .js suffix, so the rule matches nothing.
      ADR-0006 and security/tenant-isolation.md §2 both name this lint rule as part of Layer 1.
      Pre-existing since Task 1, outside Task 6's file list. Controller confirmed by inspection.
      MUST be fixed — a control everyone believes exists and doesn't is worse than none.
  (3) The RLS spec behaviourally tests only AuditEvent, not Membership or Invitation.

## PAUSED at user request (second pause) — Task 6 committed but NOT YET REVIEWED

State: HEAD 17989c8, working tree clean, lint/typecheck pass, no agents running.
4 commits unpushed (Tasks 4, 5, 6 + fixes). origin/main still at 027d8f7 (Tasks 1-3).
Resume by: dispatching the Task 6 review (opus — this is the isolation task), package
  0990cbb..17989c8, then the fix round for the three concerns above.
Task 6: review (opus, 30+ live attack probes against the real client on Compose Postgres, both
  owner and sentinel_app roles) — spec ✅, quality NOT APPROVED. FOUR Criticals, all executed.
  C1 nested WRITES through a non-tenant root are unscoped: db.user.update({data:{memberships:
    {create|update|updateMany|deleteMany}}}) performed cross-tenant create, update AND delete.
    Root cause: tenant-client.ts:78 inspects only the top-level model.
  C2 nested READS leak, including Invitation.tokenHash. Worse variant: a correctly-scoped
    membership.findMany({include:{user:{include:{memberships:true}}}}) returned org B's row — the
    handler did everything right and still leaked.
  C3 Organization is unregistered, so tenant A can list, rename and DELETE any other tenant
    through the mandatory scoped client. RLS does not catch it either: sentinel_app holds DELETE
    on Organization, Organization has no policy, and ON DELETE CASCADE runs OUTSIDE RLS. One call
    defeats both layers — the exact scenario tenant-isolation.md says cannot happen.
  C4 layers 1 and 2 CANNOT BE COMPOSED. The base client in every tenant-client test is
    rolsuper=t rolbypassrls=t, so layer 1 is proven only where layer 2 is off. Against the real
    sentinel_app role the scoped client returns 0 rows (nothing sets app.organization_id).
    withTenantTransaction returns a tx with $extends omitted, so the scoped client cannot be
    layered onto it. As shipped you get layer 1 OR layer 2, never both.
  M1 fail-closed on unknown operations has ZERO coverage — reviewer flipped the catch-all throw to
    fail-open and all 21 integration tests stayed green.
  M2 findUnique escapes interactive transactions (rewrites through the captured outer base client).
  M3 findUnique by compound unique key is broken entirely — merges organizationId as a sibling of
    the compound object. Membership@@unique([organizationId,userId]) and
    Invitation@@unique([organizationId,email]) are exactly Phase 2's lookups.
  M4 the append-only trigger makes organisation deletion impossible for EVERY role, including the
    owner — it fires on ON DELETE CASCADE. Blocks offboarding, GDPR erasure and test teardown.
  M5 lint rule confirmed inert ('./unscoped.js' unmatched); and fixing it will break lint because
    Task 6's own tenant-transaction.ts imports from './unscoped.js' and is not exempted.
  N1 null organizationId bypasses the guard (checks '' and undefined only).
  N3 RLS spec behaviourally covers AuditEvent only; reviewer ran the missing Membership/Invitation
    cases and they PASS — the policies are correct, only the tests are thin.
  N4 doc status banners now overclaim given C3/C4.
  N5 Task 14's DMMF check keyed on organizationId can never flag Organization — the model that
    leaks hardest. Registry needs a tenant-root concept.
  Confirmed sound: the data-injection fix is real (reviewer reproduced the re-parenting exploit),
  the sanctioned eslint-disable was REMOVED rather than widened, FORCE is load-bearing (reviewer
  built a non-superuser owner and demonstrated the bypass), and all RLS policies are correct
  (cmd=ALL, both USING and WITH CHECK).
Task 6: fix round 2/5 (all 12 findings + FORCE test ADDRESSED; commits 17989c8..59b1d8d).
  Re-reviewer confirmed each behaviourally on the real sentinel_app connection. C4's
  extend-then-transact fix verified genuine and load-bearing (GUC is transaction-scoped across 12
  iterations; concurrent txs each saw only their own org). 134/134 tests.
  Implementer correctly identified that the CONTROLLER'S OWN findUnique design sketch could not
  work — Prisma's extension callback receives only {model,operation,args,query} with no reference
  to the invoking client — and redesigned as fetch-then-check, which fixed M3 as a side effect.
  BUT: findings remain.
  NEW CRITICAL: cross-tenant destruction via FK cascade. tx.user.delete() over sentinel_app inside
    withTenantTransaction(orgA) destroyed tenant B's Membership — tenant A could SEE one row and
    DELETED two. RI cascades run below RLS. Round 2's author knew this (its own migration comment
    says so) but applied the reasoning to AuditEvent.organizationId only.
  IMPORTANT: run-and-check reads row[checkField] off the PROJECTED result, so findUnique with a
    narrow select/omit returns null for rows the tenant owns. Fail-closed but new in round 2, and
    select is what CLAUDE.md's N+1/DTO rules push developers toward. No test covers it.
  IMPORTANT: findUniqueOrThrow is an existence oracle wherever layer 2 is absent — cross-tenant
    throws MissingTenantContextError while a genuine miss throws P2025. The uniformity on the app
    path is supplied by RLS, not by layer 1.

## PLAN MODE — plan approved (C:\Users\Sam\.claude\plans\dynamic-frolicking-newt.md)

Controller enumerated every FK into a tenant-owned table and found EXACTLY ONE unremediated
cascade: Membership_userId_fkey -> User (global) ON DELETE CASCADE. Everything else is already
RESTRICT or parented by the tenant root with DELETE revoked.

Task 6: Ruling (user-confirmed): Membership.userId -> onDelete: Restrict. Deleting a User then
  fails while any membership exists, so account deletion must remove each membership first and
  every removal passes through layer 1 + layer 2. Deliberately NOT revoking DELETE ON "User" from
  sentinel_app — self-serve account deletion is a legitimate Phase 2 flow and blocking it until
  Phase 11 builds a platform-admin path is the wrong trade for a SaaS product. Cost if wrong:
  Phase 2's delete-my-account needs a per-organisation loop or a privileged path.
Task 6: Ruling (user-confirmed): document the relation-connect limitation as a house rule rather
  than teaching the extension to normalise `data.organization.connect`. Forcing the scalar
  organizationId into data makes Prisma's connect form fail loudly with "Unknown argument
  organizationId". Documenting beats adding logic to the single most security-critical file in the
  codebase — a file that has already produced four Criticals. Cost if wrong: Phase 2 handlers must
  use scalar FK style on tenant-owned models.
Task 6: Ruling: make the class STRUCTURAL, not a one-off. Task 14's check-tenant-registry.ts gains
  a second rule — no FK into a tenant-owned table, from a parent that is not itself tenant-scoped,
  may be ON DELETE CASCADE. Reads onDelete from the DMMF. Also closes N5: a check keyed on the
  organizationId column can never flag Organization, the model that leaked hardest, so every model
  must be accounted for by exactly one of tenant-owned / tenant-root / deliberately-global.
  Why: fixing one FK leaves the next to be found by a reviewer or a customer.
Task 6: Ruling: correct roadmap.md:28 NOW, not at Task 16. It still says "No application code
  exists ... nothing else" while four working packages are pushed to main. That breaks CLAUDE.md's
  roadmap rule and is exactly the failure resuming-work.md warns about — a resuming session would
  rebuild what exists.

Task 6: fix round 3/5 dispatched (base 59b1d8d) — FK cascade Critical (Membership.userId ->
  Restrict + migration), select/omit projection defect, findUniqueOrThrow existence oracle, and
  four documentation corrections including roadmap.md:28. Task 14 will carry the structural
  FK-cascade CI rule; controller carries that into Task 14's dispatch rather than widening round 3.
Task 6: fix round 3/5 (commits 59b1d8d..8bf2173). CRITICAL CLOSED. Reviewer drill-verified by
  reverting Membership_userId_fkey to CASCADE on a live DB — tenant B's membership was destroyed —
  then restoring and watching the probe go green. Independently swept pg_constraint and confirmed
  the controller's enumeration: no FK into a tenant-owned table from a non-tenant-scoped parent is
  CASCADE. select/omit fix verified across 21 projection cases on BOTH connections plus two
  control-removal drills, and the widening did not open a cross-tenant hole. All doc corrections
  landed. 100 unit + 48 integration.
  PARTIAL — the oracle: class and code now identical everywhere, but message and meta still differ
    on connections without RLS (unscoped client, migrations, seeds, future platform-admin). Low
    practical severity (no RLS-backed path reaches it; layer 3 keeps the string from clients) but
    short of the stated bar, and precisely the paths the new docs say lack defence in depth.
  NEW IMPORTANT — tenant-isolation.md:111-112 asserts "every FK into a tenant-owned table is
    RESTRICT", which is false: Membership_organizationId and Invitation_organizationId are both
    CASCADE. They are safe (tenant root -> its own rows) but the sentence states an invariant that
    does not hold, in the doc an engineer reads before adding a table, and it drops the qualifier
    from the rule being carried to Task 14.
  HONESTY — report:690 claims the fix produces Prisma's "message shape"; it does not.
Task 6: Ruling: file lengths accepted as-is. tenant-transaction.integration.spec.ts (360) would
  need the Testcontainers harness duplicated to split, which is worse than the length;
  tenant-scope.ts (308) is 8 lines over a guideline written as "~300" and not worth churning the
  most security-critical file in the codebase. Implementer was right to flag rather than split
  unilaterally.
Task 6: Ruling: client-level `omit` (PrismaClient constructor option) reaches the extension with
  args.omit undefined, so the widening never fires and owned findUnique returns null. FAILS
  CLOSED, no leak, and we do not construct clients that way. Add a code note; carry a Task 14
  guard against global omit on scope columns rather than widening the extension again.
Task 6: fix round 4/5 dispatched — oracle message/meta parity + its test, the false doc invariant,
  and the report overclaim. Task 6 closes after this round regardless.
Task 6: fix round 4/5 (commits 8bf2173..d282998) — all three items ADDRESSED, verified by live
  reproduction. Implementer improved on the controller's instruction: instead of hand-building a
  P2025 (which would drift when Prisma changes wording), it re-queries through query() with a
  guaranteed-no-match where so Prisma's own engine raises the genuine error. Reviewer judged the
  design sound on all five questions and confirmed two things the implementer had not claimed:
  it generalises to compound unique keys, and query-count instrumentation shows the extra round
  trip fires ONLY on the cross-tenant error path (1 query on success, 1 on genuine miss, 2 only
  when a row is found in the wrong tenant). Read-your-own-writes inside withTenantTransaction
  re-verified — M2 did not reappear. Shared-call-site requirement judged correct rather than a
  test artifact: Prisma anchors the message to the top-level invocation, so an attacker comparing
  two responses from the same endpoint sees identical errors.
  Corrected doc sentence verified against pg_constraint (not schema.prisma): the two CASCADEs into
  tenant-owned tables both originate at Organization; every FK from User or Role is RESTRICT.
Task 6: fix round 5/5 dispatched — two one-liners only:
  (a) NEVER_MATCHES_ID collision. Reviewer planted a row whose id IS the sentinel on an unscoped
      connection; the fallback returned that row's content instead of throwing. That is WORSE than
      the oracle it replaced — wrong tenant's data returned, not merely a distinguishable error.
      Unreachable via normal code (ids are newId()-format) and masked by RLS on sentinel_app, but
      it lands on exactly the privileged connections item 1 existed to protect. Guard: the
      fallback's returned row must have id === NEVER_MATCHES_ID, else throw the not-found error.
  (b) unscoped.ts:11-14 comment went stale this round (tenant-client.ts no longer imports Prisma
      at runtime). "Stale documentation is a defect" is a stated rule and this round introduced it.
Task 6: Ruling: controller will verify the round-5 diff directly rather than dispatching a fifth
  review cycle. The change is ~10 lines with a binary pass/fail probe, and a full review cycle
  costs more than the change. This is adjudication at the cap, not skipping the gate.
Task 6: fix round 5/5 (commits d282998..bf4ebc4). Implementer again improved on the instruction:
  instead of the post-hoc id comparison the controller asked for, it made the fallback `where`
  self-contradictory — `{ id: X, NOT: { id: X } }` — so no row can satisfy it regardless of table
  contents. Logically impossible rather than merely unreachable, and still routed through Prisma's
  own engine for the error. Permanent test plants a sentinel-id row and asserts P2025.
Task 6: CONTROLLER-VERIFIED DIRECTLY (adjudication at the cap, not a skipped gate). Read the full
  57-line diff: the self-contradictory where is a structurally valid WhereUniqueInput (Prisma
  accepts boolean filters alongside the unique field) and is unsatisfiable by construction; the
  collision test exercises exactly the planted-row case; unscoped.ts's comment is now accurate
  (confirmed tenant-client.ts imports `type { PrismaClient }` only, no runtime Prisma). Ran
  lint/typecheck/build PASS and 100 unit + 49 integration tests green on the committed state.
Task 6: complete (commits 0990cbb..bf4ebc4, 5 fix rounds, review clean)
  Final tally: 5 Criticals found and closed, every one real, two of them INTRODUCED BY EARLIER
  FIXES. Lesson for the remaining tasks: every change to the isolation layer needs its own
  adversarial probe — plausible-looking fixes to subtle code introduce new holes.
Task 6: residuals carried to the whole-branch review — findUnique momentarily materialises a
  foreign row in-process before the check (no leak; masked by RLS on the app path);
  scopeUniqueWhere's strict-inequality collision check (fails closed); client-level `omit` gap
  (fails closed; Task 14 guard); TENANT_ROOT_MODEL completeness (Task 14).

### Task 7 — Seed: system roles and permissions

Base: bf4ebc4
Task 7: implementer DONE — commit 3bc78b3. 4/4 seed integration tests; 100 unit + 53 integration.
  All three required mutations detected. Also fixed two PRE-EXISTING script defects it hit:
  db:seed used `node --experimental-strip-types`, which strips types but does not do the TS
  .js->sibling-.ts resolution this codebase's ESM imports depend on (verified empirically, fixed
  with tsx in devDependencies); and the root db:seed was missing the `dotenv -e .env --` wrapper
  all its siblings have.
Task 7: review — spec ✅, quality APPROVED, ZERO findings.
  Reviewer verified both load-bearing properties against the LIVE database rather than the tests:
  empty-product (0 orgs / 0 users / 0 audit events, 7 roles / 49 permissions / 190 grants, stable
  across two runs), and CONVERGENCE — it removed evidence.read from VIEWER in contracts, rebuilt,
  re-seeded, watched grants drop 190->189 with the permission gone, then restored. That proves the
  stale-grant deleteMany actually removes rather than only adding, which is the property no
  ordinary test would catch.
  Also mutation-tested the over-grant direction (an extra grant outside the matrix IS caught, so
  coverage is not one-directional) and confirmed the upsert's `update` clause actually updates
  rather than silently keeping stale values.
  Judged the tsx choice defensible rather than a mistake: running from dist/ would avoid the
  dependency but make db:seed silently stale whenever src changes without a rebuild.
  Confirmed the seed's no-restricted-imports exemption matches on the LINTED FILE's path, not an
  import specifier, so it is unaffected by the .js glob bug Task 6 fixed — exempt by design.
Task 7: complete (commits bf4ebc4..3bc78b3, review clean, zero findings)

### Task 8 — packages/storage

Base: 3bc78b3
Task 8: implementer DONE_WITH_CONCERNS — commit fe28a46. 8/8 key unit + 7/7 MinIO integration;
  108 unit + 60 integration workspace-wide. 4/5 control-removal drills detected.
Task 8: Ruling: fix two of the three concerns before review.
  (a) Drill 5 uncovered — head() swallowing a 403 as null is caught by NO test. The implementer
      reported this honestly rather than claiming 5/5, which is why it is being fixed now instead
      of found in review. An untested claim in a security-adjacent adapter is a claim that quietly
      stops being true; swallowing a 403 as "absent" reports a permissions misconfiguration as a
      missing object. Fix: a second adapter with deliberately wrong credentials against the same
      MinIO container must make head() throw, not return null. Unit-level error-branch test
      acceptable if MinIO makes 403 awkward to provoke.
  (b) folder-structure.md now lists storage in TWO places — the new packages/storage entry AND the
      old apps/api/src/infrastructure line. Worse than either version alone. Remove storage from
      the apps/api line; Task 9's thin wiring module is wiring, not the adapter.
  (c) exactOptionalPropertyTypes deviation ACCEPTED — the brief's literal head() source does not
      compile under a flag established in Task 1, after the plan was written. Conditional spreads
      are behaviourally identical and documented.

## USER REQUEST (mid-execution): pause after Task 8

Task 8's review is the last work before handing back. Tasks 9-16 are held, not abandoned.
Resume by dispatching Task 9 (apps/api bootstrap) against base = Task 8's final commit.
Carry into Task 9: the F5 ruling (Task 9 creates access.decorator.ts with @Public and
@RequirePermission — the plan wrongly assigns them to Task 11) and F6 (setGlobalPrefix must
exclude health/* so probes answer at /health/live, not /api/health/live).
Carry into Task 10: F7 — the APP_ENV==='test' fixture routes must declare @Public(), or Task 11's
boot assertion will crash the app in the test environment.
Carry into Task 14: the FK-cascade structural rule, TENANT_ROOT_MODEL completeness, and a guard
against client-level `omit` on scope columns.
Task 8: gap round done — commit 4e1c577. All 5 drills now caught; implementer verified MinIO
  actually returns 403 for bad credentials BEFORE writing the assertion, then confirmed the test
  fails when head() swallows it. folder-structure.md reconciled to name the adapter once.
Task 8: review — spec ✅, quality APPROVED, no Critical or Important findings.
  Reviewer attacked the key builders against real MinIO: unicode and `../` org ids, extensions
  with null bytes / path separators / leading dots / 200 chars, CRLF header-injection in
  downloadFilename, 1000-iteration collision check. Fetched REAL presigned URLs and read the
  actual X-Amz-Expires rather than trusting the code path — clamped to 300 on BOTH presignGet and
  presignPut. Reproduced the 403 drill and added two of its own (dropped the prefix from
  reportKey specifically, since the implementer's drills only touched evidenceKeyForFinding; and
  hashed the wrong bytes in put). Both caught.
  Minor: CRLF in downloadFilename does not achieve header splitting, but only because Go's HTTP
    writer collapses CR/LF — the safety rests on the SERVER's stack, not our adapter.
  ⚠️ .claude/architecture/storage.md §4 is now stale: it documents put(key,body,opts) /
    head(key) / presignPut(key,ttl,opts) while the shipped interface takes an explicit bucket
    first argument, and still says "Not Implemented".
Task 8: Ruling: fix both before closing. The storage.md staleness is a documentation DEFECT by
  CLAUDE.md's own rule — §4 of that file IS the adapter interface, and someone reading it would
  write against a signature that does not compile. The CRLF strip is one line and removes a
  dependency on someone else's HTTP implementation for a header we construct ourselves; R2, AWS
  S3 or a future provider need not behave like MinIO.
Task 8: INTERRUPTION #2 — the closing round's agent was killed by a session usage limit (reset
  since). Controller verified recovery state rather than assuming: HEAD still 4e1c577, nothing
  committed; both requested changes present and correct in the working tree (storage.md §4
  signatures + status banner, and the control-character strip in s3-adapter.ts); typecheck green
  and 8/8 storage unit tests passing. ONE breakage: `pnpm lint` fails because the
  eslint-disable-next-line directive spans two comment lines, so it targets the second COMMENT
  line rather than the regex — the directive is both unused AND no-control-regex fires. Controller
  diagnosed it from the lint output and handed the diagnosis to the resumed agent rather than
  letting it rediscover. Remaining: directive placement, the CRLF test with a red/green proof,
  verification, report, commit.
Task 8: closing round done — commit 6298ca0. Implementer caught and fixed its OWN
  eslint-disable-next-line misplacement (same bug class) before committing, in both the
  implementation and the new test's regex. CRLF test proved RED with the old quote-only strip
  (raw `X-Injected: 1` landed on its own line in the decoded URL) and GREEN restored.
Task 8: CONTROLLER-VERIFIED DIRECTLY (adjudication, not a skipped gate — the substance was already
  reviewed and approved; this round was two small changes). Read the shipped strip: single-line
  disable directive correctly placed, regex covers quotes + \x00-\x1f + \x7f. Confirmed
  lint/typecheck/build PASS, 108 unit + 62 integration green, tree clean, and the two documents
  now agree — folder-structure.md names the adapter once (line 39) with the Rules justification
  (line 84), and storage.md's banner says "Adapter Implemented (Phase 1)" with evidence and
  reports honestly still outstanding.
Task 8: complete (commits 3bc78b3..6298ca0, review clean)

## PAUSED at user request (third pause) — after Task 8

State: HEAD 6298ca0, working tree clean, lint/typecheck/build PASS, 108 unit + 62 integration.
12 commits unpushed; origin/main still at 027d8f7 (Tasks 1-3 only).
8 of 16 tasks complete, all reviewed clean.
Resume by dispatching Task 9 (apps/api bootstrap) against base = 6298ca0, carrying the F5/F6
rulings already recorded above.

## RESUMED — 2026-08-21 (user: "Resume")

Task 9: dispatched against base 6298ca0 with F5/F6 carried. Compose stack already up (5h,
  all four healthy). Implementer shipped commit 888bc3c — 41 files, +3548.
  ESM held: Nest 11.2 + Express 5.2 did not fight it, so no CommonJS fallback was needed.
  The real ESM-adjacent hazard was different and is worth keeping: emitDecoratorMetadata is
  deliberately OFF because esbuild (Vitest's transform) does not implement it, so DI relying on
  design:paramtypes would resolve under tsc and fail silently under test. Every injected ctor
  param therefore carries an explicit @Inject(TOKEN).
  Implementer found a REAL DEFECT IN THE PLAN'S OWN FILTER: the HttpException branch passes
  exception.message through at any status, so `new InternalServerErrorException(err.message)` —
  an ordinary Nest idiom — leaked verbatim. Rebuilt as status-gated, not class-gated, with
  DomainError exempt so /health/ready can name the dead dependency. It initially made ALL 5xx
  generic, the readiness integration test caught that this destroyed the endpoint's only job,
  and it reverted with a test locking the contract. Measured Nest's actual HttpException.message
  for seven constructions rather than assuming.
  F6 re-measured four ways with a negative control: `health/(.*)` DOES work (Nest matches prefix
  exclusions itself, so path-to-regexp v8 never sees them); shipped `health/{*splat}` for
  consistency with forRoutes. The ruling anticipated an Express 5 break that does not occur.

Task 9: review — no Critical findings. Reviewer re-ran all five gates cold (turbo --force, 18/18
  uncached), stopped all THREE dependencies not just Redis, ran a TCP blackhole (accept, never
  reply) to test HUNG rather than refused — readiness bounded at 2.009s, liveness 200 in 1.9ms —
  audited all 10 injected constructors for @Inject, traced every DomainError construction site
  (only two exist, neither built from driver output), instrumented SIGTERM to prove
  httpServer.close -> redis.quit -> prisma.$disconnect, and read 123 live log lines across four
  app instances (100% JSON, zero credentials, including a redis:// URL with a password).
  25 mutations run, 21 red; the 4 green were correct defence-in-depth (X-Powered-By removed at
  one layer only — removing both goes red).
  4 Importants: I1 middleware coverage gap, I2 413-as-500, I3 unmapped 4xx labelled Server-class,
  I4 health error branch has no shape assertion.

Task 9: Ruling: fix all four. I1 blocks closing — forRoutes({path:'*splat'}) registers module
  middleware UNDER the global prefix, so /, /healthz and anything outside /api ship with no
  security headers and no request id, and a body-parse failure bypasses the chain even on a
  covered path (req_unknown in envelope AND log). transport-and-headers.md §2 says "every
  application response". The test that claimed to guard it picked a URL inside the covered tree.
  Fix: app.use() in configureApp; the order assertion must move with it or it asserts nothing.
  Cost if wrong: none — strictly wider coverage.
Task 9: Ruling: I2 fix NARROWLY — do not let the filter trust a `status` off any caught object.
  Honour it only on the http-errors contract (numeric status 400-599 AND boolean expose), and use
  the throwable's own message only when expose===true AND status<500. Why: 413-as-500 lets anyone
  drive the 5xx rate monitoring.md §6 alerts on, but a filter that reads status off arbitrary
  throwables is a new trust boundary. Cost if wrong: a non-http-errors library with a status field
  still reports 500; conservative direction.
Task 9: Ruling: I3 default unmapped 4xx to VALIDATION_ERROR, unmapped 5xx keeps INTERNAL_ERROR.
  Considered and REJECTED adding PAYLOAD_TOO_LARGE/UNSUPPORTED_MEDIA_TYPE to ERROR_CODES: Task 11
  generates OpenAPI from that contract and errors.md §7 wants a test producing every documented
  code. The property that matters is client-class vs server-class (errors.md §1: clients branch
  on code; §3 files INTERNAL_ERROR under Server). Cost if wrong: a 413 arrives as
  VALIDATION_ERROR with no `fields` detail. Revisitable in Phase 2.
Task 9: Ruling: I4 fix — the reviewer inserted host:'db-primary.internal:5432' + driver into the
  probe error branch and BOTH test layers stayed green. The Object.keys shape assertion only ever
  ran against an all-healthy report, and the outage tests checked a hand-picked string list.
  LESSON (generalises past Task 9): a sweep list only catches the strings you thought of. Shape
  assertions must run on the DEGRADED path, which is the path that carries the leak.
Task 9: also fixing — packages/config/tsconfig/nest.json still sets emitDecoratorMetadata:true,
  contradicting apps/api/tsconfig.json:6 (loaded gun for the next Nest app);
  transport-and-headers.md Status block overstates coverage; nest-cli.json is inert (no CLI dep,
  build is plain tsc) so it gets deleted.
Task 9: recorded, NOT fixed (carried to whole-branch review): body parser echoes the caller's own
  raw body in its 400 message (truncated at 10 chars, so redactSecretsInText cannot match);
  /health/detailed returns 200 while status:"degraded"; object-shaped HttpException collapses to
  "Bad Request Exception" (confirmed latent by direct probe — Nest's only producers on this stack
  are string-shaped); no `dev` script exists anywhere in the workspace (Task 16's honesty pass
  over CLAUDE.md's command table).
Task 9: also noted by implementer — report-uri /api/v1/csp-report points at a route that does not
  exist until apps/web; Redis error-event handler logs ~1 line/2s during an outage with no
  throttling (deliberate: the alternative is an unhandled error event killing a serving process);
  errors.md §7 cannot be satisfied while most codes have no endpoint that can raise them;
  storage probe cannot distinguish a missing bucket from a missing key (HEAD returns 404 for both)
  and closing it would need s3:ListBucket, which the production evidence credential may not hold.
Task 9: INTERRUPTION #3 — the fix-round agent was killed by a session usage limit during its
  ORIENTATION reads (it had opened app.module.ts and nest.json, nothing more). Controller
  verified recovery state rather than assuming: HEAD still 888bc3c, tree clean, zero partial
  work to unwind, compose stack healthy again after a restart. Re-dispatched fresh.
Task 9: fix round 1 done — commit 87af3e6. All four Importants fixed, each with a mutation proof.
  I1: reverting to the MiddlewareConsumer wiring makes 9 NEW tests fail while ALL 24 PRE-EXISTING
    tests stay green — the old suite could not see the gap at all, which is the reviewer's point
    about /api/v1/does-not-exist sitting inside the covered tree. Order assertion moved to the
    app.use() path and proven to bite by reversing it. Middlewares constructed via
    app.get(CSP_ENFORCE) (keeps the single source of the flag and does not read process.env
    outside packages/config); registered as arrow wrappers not .bind() so arity stays 3, because
    Express treats a 4-arg function as an error handler.
  I2: honours status only on the http-errors contract (numeric status 400-599 AND boolean
    expose). Dropping the expose requirement turns a Prisma-shaped error carrying status:404 into
    a 404 — caught by its own test.
  I3: unmapped 4xx -> VALIDATION_ERROR, unmapped 5xx keeps INTERNAL_ERROR.
  I4: THE PROOF THAT MATTERS — implementer ran the reviewer's exact leak against the OLD specs
    first: unit 10 passed, integration 2 passed, both GREEN. Same leak against the new specs:
    both RED. health.service.ts is byte-identical to HEAD (it does not appear in the commit) —
    the defect was entirely in the tests, which is the finding.
  Small items: nest.json emitDecoratorMetadata aligned with the why carried into the file;
  transport-and-headers.md Status block corrected and the corrected claim made true;
  nest-cli.json deleted.
Task 9: Ruling: fix the inverted asymmetry the implementer FLAGGED RATHER THAN DECIDING — an
  http-errors 4xx with expose:false was returning the SERVER generic ("Something went wrong on
  our side") for a client-caused failure. Dishonest in the opposite direction from the bug I3
  just fixed: errors.md §1 has clients branching on code, and a message contradicting the class
  re-introduces the confusion one layer up. Add a second client-class generic, assert it, and
  document the two-message rule so someone does not "simplify" them back into one. Amended into
  87af3e6, same fix round. Cost if wrong: one more string to keep in sync.
Task 9: carried to Task 11 — errors.md §2 documents VALIDATION_ERROR as carrying details.fields,
  a slightly stronger commitment than §3's grouping. A 413 now arrives as VALIDATION_ERROR with
  no fields. Task 11's OpenAPI generation must decide whether fields is REQUIRED for that code.
Task 9: carried to Task 14 — `pnpm format:check` fails on 13 files and has ALWAYS failed; it is
  not one of the five gates and nothing in CI runs it. Task 14 owns the decision: wire it into CI
  and fix the files, or delete the script. Fixing the files without gating just lets it drift
  again. (Fix round 1 formatted only what it touched: 14 -> 13.)
Task 9: asymmetry fix amended into 73b04f3 (hash moved from 87af3e6). Two constants,
  SERVER_GENERIC_MESSAGE byte-identical to the old string and CLIENT_GENERIC_MESSAGE new.
  Collapsing EITHER direction now reddens a test — both proven.
Task 9: scoped re-review of 888bc3c..73b04f3 — APPROVED, no Critical, no Important.
  Reviewer introspected the LIVE Express stack on the built dist app to settle the ordering
  claim empirically rather than by citation: the two cross-cutting handlers sit at indices 1-2,
  registerParserMiddleware lands at 3-4 behind them, exactly two registrations, both arity 3.
  Confirmed ALS still spans the whole request (the LoggingInterceptor binds no requestId itself
  yet its live line carries one). Settled the potential Critical: app.get(CSP_ENFORCE) pre-init
  resolves in every environment and a MISSING token throws UnknownElementException killing the
  process at boot — the silent report-only-in-production failure mode is not reachable.
  12 hostile shapes against I2's discrimination (expose:1, expose:'true', new Boolean(true),
  statusCode:'413', 399, 600, NaN, Infinity, 413.5, null) all correctly refused; exhaustive
  sweep of 400-599 x expose:{true,false} found 0 disagreements between status and code.
  For I4 the reviewer planted SIX leaks including four the implementer never tested — nested
  object, innocuously-named key, a leak on the HEALTHY branch, an extra key in
  checkDependencies() — all six red. Verified nothing was silently dropped when
  app.module.spec.ts was deleted: all its guarantees are live in app-setup.spec.ts and each
  reddens under mutation.
  Live production run (APP_ENV=production, real dist/main.js) across 15 request shapes incl.
  HEAD/OPTIONS/TRACE/PATCH, malformed JSON, 200KB body, bad Content-Encoding/charset: every one
  carried the full 11-header set + x-request-id, none carried x-powered-by or ETag.
  Informational: Node's own HTTP parser answers oversized headers with a bare 431 and a
  malformed request line with a bare 400 — no headers, no request id, no JS executed. Only a
  server.on('clientError') handler could reach it. Not claimed by the corrected doc, so not a
  finding.
Task 9: Ruling: CONTROLLER FIXED Minors 1-4 DIRECTLY rather than spending a dispatch — three
  small, fully-specified edits. Commit 58921e2. The two code Minors were the same defect class:
  a rule and its own comment had drifted apart. codeForStatus said "any unmapped CLIENT-CLASS
  status" but tested only status<500, so a 302 reaching the filter would have been reported to
  the caller as their bad request; range now checked at both ends. asHttpError read expose/
  status/statusCode off a throwable it did not construct, so a throwing getter propagated OUT of
  catch() and replaced the envelope with finalhandler output — now guarded the way redact()
  guards its own reads, unreadable treated as absent. Both proven by mutation (dropping the
  lower bound reddens the sub-400 test; removing the guards reddens the throwing-getter test
  with "expected [Function] to not throw"). errors.md gained the details.fields-is-optional
  contract note, because Task 11 generates OpenAPI from that document and the trade had been
  recorded only in a source comment. Rule count in §5 corrected 2 -> 3.
  Cost if wrong: two unreachable-today edge cases get slightly more code. Accepted.
Task 9: Minor 5 carried to Task 16 — packages/config/tsconfig/* presets are DEAD CONFIG. Every
  workspace tsconfig extends ../../tsconfig.base.json; nothing extends the @sentinel/config
  presets, so the emitDecoratorMetadata:false fix in nest.json is inert (the load-bearing copy
  is apps/api/tsconfig.json, which is correct). Pre-existing, not introduced by Task 9. Task 16
  decides: wire the presets up or delete them.
Task 9: complete (commits 888bc3c..58921e2, review APPROVED). Gates cold-verified by controller:
  turbo --force 18/18 uncached, 196 unit, 95 integration, tree clean.

## Task 10 — 2026-08-21

Task 10: INTERRUPTION #4 — the dispatched implementer was killed by a WEEKLY usage limit during
  orientation (18 tool uses, no writes). State verified: HEAD 58921e2, tree clean, no guards dir.
Task 10: Ruling: CONTROLLER IMPLEMENTED DIRECTLY rather than re-dispatching. With the weekly
  limit hit, a fresh subagent would spend its budget re-deriving context the controller already
  holds. Commit ab44082. TDD held throughout: config spec RED on module-not-found first, then
  8 mutations run against the finished code, ALL CAUGHT.
Task 10: OVERRULED THE PLAN on the core primitive. The plan specified a MULTI doing
  ZREMRANGEBYSCORE/ZCARD/ZADD/EXPIRE. A MULTI cannot do this correctly — whether to ZADD depends
  on the ZCARD result and a transaction cannot branch on a command inside it. Both writable
  shapes are wrong: (a) add unconditionally => a refused request is charged against the window,
  so a client hammering a closed door pushes it forward with every knock and never sees it open;
  (b) read then write in two round trips => two concurrent requests both see room, which is the
  exact race the plan's own rationale invokes the transaction to prevent. Shipped one Lua script:
  atomic against a single-threaded server, one round trip, able to branch. BOTH MULTI shapes were
  implemented as mutations and both redden tests (M2, M4).
  Cost if wrong: a Lua script is harder to inspect in redis-cli than a MULTI. Accepted.
Task 10: Ruling (made in advance, then proven): an unresolvable scope is NOT a free pass. If a
  class declares scopes and none resolve, failMode applies. Without it `invitations` and
  `scanCreate` — keyed ONLY perOrganization, with no tenant context before Phase 2 — would carry
  no limit at all despite being fail-closed. M8 (the naive "skip unresolvable scopes"
  implementation) returns 201 where the shipped code returns 429. Refined during implementation:
  log at warn only when the outcome is a refusal, at debug when fail-open, because an
  unauthenticated request to a perPrincipal class is the NORMAL state of every request until
  Phase 2 and a warn per request would be a log flood that trains operators to ignore the channel.
Task 10: two properties NOT in the plan, added because they are the difference between a control
  and a decoration. (1) X-Forwarded-For must not mint a fresh bucket — proven by M5: enabling
  `trust proxy` reddens the test. Documented that a real load balancer needs more than
  trust proxy: the proxy must OVERWRITE the header, not append, or the bypass returns.
  (2) Unique sorted-set members — M1: making the member the timestamp reddens 4 tests, because
  ZADD would overwrite rather than add and silently double the effective limit.
Task 10: deviated from the plan on `__test` routes — fixtures live in the spec, following Task 9's
  BoomController pattern. A route that exists only in a test file cannot ship and cannot be
  reached by a misconfigured APP_ENV. F7 still honoured: they carry @Public().
Task 10: also omitted one row of abuse-prevention.md §1 deliberately — webhook test delivery is
  10/hour PER ENDPOINT, a scope nothing can resolve until Phase 9. Keying it against the wrong
  scope would LOOK enforced. Recorded in the config docblock and in the document.
Task 10: mutations run, all 8 caught — M1 timestamp member (4 red), M2 count<=limit off-by-one
  (6 red), M3 reset from now (1 red), M4 unconditional ZADD i.e. the plan's MULTI (2 red),
  M5 trust proxy on (1 red), M6 registration fail-open (1 red), M7 generalSession fail-closed
  (2 red), M8 skip unresolvable scopes (1 red, 201 vs 429).
Task 10: gates cold-verified — turbo --force 18/18 uncached, 202 unit, 115 integration, tree
  clean. Docs updated in the same commit: abuse-prevention.md status banner + three
  implementation properties + §6 test coverage; backend.md §3 rate-limit row now Implemented.
Task 10: NOT YET REVIEWED — no adversarial review has run against ab44082. Task 9's review found
  4 Importants in work that looked finished, and the controller wrote this one, so a review is
  MORE necessary here, not less. Must run before Task 10 is called complete.
Task 10: REVIEW — findings remain: 2 CRITICAL (both in the controller's own reasoning), 3
  Important, 9 Minor. The reviewer verified 10 of the controller's claims by measurement,
  independently ran 10 mutations (all red, "8 caught" was understated), confirmed the
  Lua-over-MULTI argument, and proved liveness reached no Redis — then showed WHY that held.
  C1: perPrincipal resolved request.principalId, but login/passwordReset/emailVerificationResend
    are UNAUTHENTICATED by definition — a failed login carries no principal, and §1's "5/15min
    per account" means the account being ATTEMPTED, which is in the body. Because perIp DOES
    resolve, decisions.length>0, so the unresolved scope was skipped with no failMode, no log,
    no header, no test. Route 429s at 20 and advertises limit=20 while the credential-stuffing
    control is absent. THE CONTROLLER COMMITTED EXACTLY THE FAILURE IT HAD ARGUED AGAINST three
    paragraphs earlier when omitting the webhook row ("would look enforced without being so").
  C2: the headline claim "a refused request is not charged" was true per WINDOW, false per
    REQUEST. Loop consumed every declared scope regardless of an earlier refusal. Reproduction:
    20 requests exhaust the IP window, 6 refused attempts on a victim leave zcard=5. One IP,
    AFTER its own limit closed, locks out arbitrarily many accounts — destroying the reason both
    scopes exist.
Task 10: Ruling: fix both properly rather than narrowly. C1 needs a per-class principal source
  (config gains `principalSource: 'authenticated' | {bodyField}`), and the body value is HASHED
  (sha256, base64url, 22 chars) before entering a key — a raw email in a Redis key is visible to
  KEYS, the slow-log and a memory dump. C2 is `break` on first refusal.
  Cost if wrong: principalSource is one more thing to get right per class; the config test now
  has to check it. Accepted — the alternative is a control that looks enforced.
Task 10: I2 fixed STRUCTURALLY, not by test alone. Liveness reached no Redis only by ACCIDENT:
  generalSession happens to declare no scope resolvable unauthenticated. The reviewer planted
  the single most plausible future change — adding perIp to generalSession, which §1's own
  rationale arguably demands — and the ENTIRE SUITE STAYED GREEN while liveness acquired a Redis
  dependency and its latency climbed 0.22s -> 0.98s -> 1.80s during an outage, past a 1s probe
  timeout. Added @RateLimitExempt(), used ONLY on liveness, plus a test watching a live MONITOR
  connection for zero commands. M11 (remove exemption + add perIp) now reddens 2 tests.
Task 10: MUTATION DISCIPLINE FAILURE, caught in flight and worth keeping. The first attempt at
  M10 (remove the `break`) REPORTED ALL 19 PASSING — because the perl substitution silently did
  not apply. A mutation that cannot mutate is the same defect as a test that cannot fail, and it
  produces the more dangerous artefact: false confidence in a test that was never exercised.
  Re-applied with an assert on the replacement; it reddens with "expected 5 to be 1". RULE: every
  mutation must assert that the file actually changed before the suite is run.
Task 10: Minors fixed — M1 Retry-After now takes the LONGEST reset among refusals (a client told
  the shorter one retries early and is refused again); M2 IPv4-mapped IPv6 normalised, with a
  unit spec, so one client is not two buckets once trust proxy is enabled; M3 resetSeconds
  clamped to the window and the docblock corrected — a fast clock causes a lockout of the SKEW
  duration, not "immaterial" as written; M5 outage logging moved to state-change (was one warn
  per request on top of ioredis's own reconnect warns); M7 the suite now SCANs and deletes only
  its own classes' keys instead of every ratelimit:* key in the shared dev Redis; M8/M9 docs.
Task 10: I1 fixed — roadmap.md said "no rate limiting" while backend.md said Implemented. Both
  now say the honest thing: the limiter is built, correct and tested, and GOVERNS NOTHING today,
  because every class is keyed by an account, principal or organisation and none exist before
  Phase 2. "Implemented" means built and tested, not currently in force.
Task 10: DEFERRED, recorded for later — M4 EVALSHA via ioredis defineCommand (the ~730-byte
  script ships on every call, per scope, on a global guard's hot path) and pipelining the scopes;
  M6 Redis maxmemory-policy is noeviction with maxmemory 0 and compose sets neither, which
  matters once BullMQ shares the instance in Phase 3. Both are performance/ops, neither is a
  correctness or security defect. Carry to Task 14 or Phase 3.
Task 10: fix commit 3606842. Gates cold — turbo --force 18/18 uncached, 205 unit, 123
  integration, tree clean. NOT YET RE-REVIEWED: a scoped re-review of ab44082..3606842 is still
  owed, and it matters here because two of the three fixes changed the guard's control flow.
Task 10: RE-REVIEW of ab44082..3606842 — findings remain: 1 CRITICAL, 5 Important, 8 Minor.
  The two headline fixes HELD (M3 break, M4 principalSource, M5 hashing, M8 scope order all red).
  The damage was entirely in the four smaller "also" changes shipped alongside them — written
  with less care than the two under scrutiny. LESSON: in a fix round, the incidental changes are
  the dangerous ones, because attention is on the headline finding.
  C-1: THE FIX OPENED A HOLE. Making the body key resolve turned emailVerificationResend from
    "refuses everything" (perPrincipal never resolved -> fail-closed) into "NO UPPER BOUND AT
    ALL": it declares no perIp, so every request naming a fresh address is first in its own
    window. Measured 60/60 allowed from one address, 60 keys pinned for an hour. In Phase 2 that
    is an unauthenticated outbound-email amplifier at third-party addresses — the "protect people
    who are not our customers" case the document OPENS with. This is the third time on this plan
    that a fix was worse than what it replaced.
  I-1: backendDown cleared on ANY request reaching the end of the loop, including ones that
    issued no Redis command (most traffic today), so a live outage emitted alternating
    "unavailable"/"recovered". A false all-clear closes open incidents — worse than the
    per-request warn it replaced.
  I-2: deleting @RateLimitExempt() from liveness left the ENTIRE SUITE GREEN. The behavioural
    tests passed for the accidental reason the decorator was added to replace. No positive
    control either — a watcher that failed to attach would have passed silently.
  I-3: principalSource was optional with a comment saying "required". Planted a perPrincipal
    class with no source; tsc exited 0. MFA verify / magic link / phone OTP are all Phase 2
    classes of exactly that shape.
  I-4: @RateLimitExempt was MethodDecorator & ClassDecorator — one line at the top of a
    controller disabled every limit beneath it, beating explicit @RateLimit(), with no way to
    opt back in (SetMetadata cannot express "false").
  I-5: C1's SILENCE was narrowed, not fixed — an unresolvable body field still skipped the
    account limit with no log and no header whenever perIp resolved. Measured across 12 body
    shapes; `{"email":["a","b"]}` and form-encoded duplicates are attacker-chosen shapes that
    remove the account limit at the guard.
Task 10: Ruling: fix ALL of C-1, I-1..I-5 and the eight Minors in one round. Added perIp 10/hour
  to emailVerificationResend — §1's TABLE names only the per-account figure, but §1's opening
  SENTENCE says per IP AND per principal, and the table's rows are figures, not the rule.
  principalSource became a discriminated union (compile error, verified by planting). Exempt
  narrowed to MethodDecorator. tightest()'s refused tie-break was DEAD CODE (the break
  guarantees at most one refusal) and the property it claimed measurably did not hold — removed
  it and wrote the limitation down rather than shipping a half-solution.
  Cost if wrong: the resend IP figure (10/hour) is invented rather than transcribed; it is
  documented as such in the table and the config.
Task 10: MUTATION HARNESS BUILT after this round's near-miss — scratchpad/mutate.py asserts the
  pattern exists and exits 1 if not, so a mutation can no longer silently fail to apply and
  report a false "caught". Every mutation below ran through it.
  Newly caught, all previously GREEN: N1 delete liveness exemption; N2 drop resend's perIp;
  N3 delete the normaliseIp call site; P1 truncate digest to 4 chars; P3 exemption lookup
  ignores the handler. Plus the clamp now has a test.
  The digest is PINNED by value — that single test catches both a truncation and a per-process
  salt, and a salt is a security defect dressed as hardening (it splits one account's window
  across instances and multiplies the effective limit by the instance count).
Task 10: three FALSE documentation statements corrected — a property count that no longer matched
  its bullets; a sentence claiming all three per-account classes carry a perIp scope when the one
  being fixed did not; and "nothing is governed because no identifier resolves", which is wrong
  (registration is keyed per IP and resolves today). The right reason is that no ROUTE carries a
  limit class.
Task 10: fix commit 4ec76a0. Gates cold — turbo --force 18/18 uncached, 219 unit, 128
  integration, tree clean.
Task 10: STILL OWED — a third scoped re-review of 3606842..4ec76a0. Two of the three rounds so
  far found real defects in the round before them, and this round changed the config type, the
  guard's control flow, a decorator's signature and three documents. Do NOT close Task 10 without
  it. Round budget: this is round 3 of a 5-round cap.

## PAUSED at user request (fourth pause) — after Task 10's second fix round

State: HEAD 4ec76a0, tree clean, lint/typecheck/build PASS cold, 219 unit + 128 integration.
16 commits unpushed; origin/main still at 027d8f7 (Tasks 1-3 only).
Tasks 1-9 complete and reviewed clean. Task 10 built and twice-fixed but NOT closed — the
third scoped re-review is outstanding and is the first thing to do on resume.
Deferred from Task 10, recorded above: M4 EVALSHA/pipelining, M6 Redis maxmemory-policy.

## Records backfilled — 2026-08-21 (user noticed the gap)

Tasks 9 and 10 had NO brief and NO report in this directory while Tasks 1-8 had both. Their briefs
had been written to the session scratchpad instead — which is session-scoped temp and would have
been wiped — and their reports existed only as distilled entries in this ledger.
Backfilled: task-9-brief.md, task-10-brief.md (copied out of scratchpad before it is lost),
task-9-report.md, task-10-report.md (reconstructed from the dispatch transcripts; agent reports
reproduced as given, controller-authored sections marked as such), and the six missing review
diffs 6298ca0..888bc3c, 888bc3c..73b04f3, 73b04f3..58921e2, 58921e2..ab44082, ab44082..3606842,
3606842..4ec76a0.
PROCESS FIX for the remaining tasks: the brief goes to .superpowers/sdd/<plan>/task-N-brief.md at
dispatch time, not to the scratchpad, and the report is written when the task's review closes —
not at the end of the phase, when the transcript may already be compacted away.
Task 10: THIRD re-review (3606842..4ec76a0) — findings remain: 0 Critical, 4 Important, 6 Minor.
  The reviewer ran 24 mutations with applied-assertions and CAUGHT 5 FALSE "CAUGHT" RESULTS of its
  own — a union/decorator batch reported RED from a Prisma EPERM rather than a type error.
  Independent confirmation the harness rule was worth adopting.
  #3 is the finding that matters: I-4 was never actually fixed. Narrowing @RateLimitExempt to
    MethodDecorator stopped it being WRITTEN on a class; the GUARD still read context.getClass(),
    and RATE_LIMIT_EXEMPT_KEY is exported. One @SetMetadata on a controller still disabled every
    limit beneath it — 6/6 allowed on a FAIL-CLOSED class during a Redis outage. LESSON: fixing
    the thing that writes a value is not fixing the thing that reads it.
  #1: the I-5 warn fired per request — the guard's OWN documented anti-pattern, thirty lines from
    where the fail-open branch argues against it, and attacker-triggerable.
  #2/#5: tightest()'s tie-break and the choice of NFKC were both completely untested.
  #4: per-IP keying was per full IPv6 address, so C-1's amplifier bound was IPv4-only.
Task 10: round 4 fix commit 6b15c2c. SECOND DECORATIVE TEST CAUGHT IN THE ACT — the flood test
  first captured stdout, and the test environment's logger deliberately writes nowhere, so it
  passed whether the guard warned once or six times. R2 exposed it. Replaced with an injected
  recorder via overrideProvider(LOGGER); now red in both directions. Generalises: when asserting
  on LOGS, verify the logger under test actually writes somewhere the assertion can see.
  Gates cold — 18/18 uncached, 226 unit, 131 integration, tree clean. Round 4 of 5.
Task 10: ROUND 5 (closing) review of 4ec76a0..6b15c2c — no Critical, 2 Important, 5 Minor.
  Reviewer fuzzed expandIpv6Prefix over 768,001 cases / 199,058 distinct /64s: 0 splits, 0
  collisions, 0 throws. Probed the exemption bypass via INHERITANCE and a MIXIN — both correctly
  limited. Its own mutation harness rejected one of its attempts as not-applied.
  I-1: the warn was keyed by class alone, so the first unresolvable scope — free for any
    unauthenticated caller to trigger — burned the class's only warning for the process lifetime,
    hiding a genuine wiring defect on the other scope.
  I-2: the /64 change was undocumented. ROOT CAUSE: the round-4 doc edit used an UNASSERTED string
    replace that matched nothing and failed silently. Same failure mode as a mutation that does not
    apply, committed in a documentation edit. RULE EXTENDED: assert every scripted replace, in docs
    as well as in code and mutations.
  M-1: two IPv6 tests could not detect their own removal — one a literal tautology, one a
    mutation-verified survivor over an unreachable zone strip. Third round running.
Task 10: round 6 fix commit 02c7a45 — I-1 keyed by class:scope with two direct-guard unit tests
  (S1 reproduces the reviewer's exact failure), I-2 + M-4 documented including the no-port
  trust-proxy requirement, M-1's dead strip and both weak tests removed and replaced with
  outcome assertions (S2 /64->/48 reddens two).
  Gates cold — 18/18 uncached, 228 unit, 131 integration, tree clean.
Task 10: CLOSED (58921e2..02c7a45). Four reviews, five fix rounds, three Criticals — two of them
  introduced by fixes. Parked with rulings: M-2 embedded-IPv4 hextet miscount and M-3 host:port,
  both unreachable until trust proxy is enabled and both attached to that work; M-5 no action;
  EVALSHA/pipelining and Redis maxmemory-policy to Task 14/Phase 3; normaliseAccountIdentifier to
  move to a shared package in Phase 2.

## Ready for Task 11 — clean start

HEAD 02c7a45, tree clean, gates cold-green, CI green on Linux with the integration step actually
running (131 tests, 9 files). Tasks 1-10 complete and reviewed clean. Nothing owed.

## Task 11 — route access assertion and OpenAPI

Task 11: BASE 02c7a45. Brief written to task-11-brief.md at dispatch time (the process fix).
Task 11: pre-dispatch survey — the plan's "Create: access.decorator.ts" is ALREADY DONE (Task 9
  wrote it with ACCESS_METADATA_KEY as a single discriminated-union key, and health's three
  routes already carry @Public()). So Task 11 is the READER of that metadata, not its author.
Task 11: Ruling: the plan's Step-4 test snippet calls `bootstrapTestApp()`, WHICH DOES NOT EXIST
  — no such helper is in the repo; the only app builder is a local `buildApp()` inside
  app.integration.spec.ts. Decision: pure functions are tested in the unit lane
  (`*.spec.ts`); anything needing a real Nest app whose graph touches Postgres/Redis/MinIO goes
  in `*.integration.spec.ts`, and reuses/extracts the existing buildApp pattern rather than
  duplicating it. Cost if wrong: the committed-document check runs in the integration lane
  instead of the unit lane, so it needs Docker locally. CI runs both lanes, so it is still gated.
Task 11: Ruling: NO @nestjs/swagger. It is not a dependency today, it does not read Zod, and
  wiring it would mean decorating every route twice — once for Nest, once for the schema.
  backend.md §7's words are "generated from the Zod contracts AND DECORATORS", which authorises
  a small local decorator carrying the Zod schemas, and the plan's own fallback authorises a
  standalone generator. Implementer picks between a local doc-decorator and the plan's explicit
  route table, under one binding constraint: DRIFT MUST BE IMPOSSIBLE — the "documents every
  registered route" assertion is derived from the live Nest router, never from the table it is
  checking. Route taken is recorded in the commit body, as the plan requires.
  Cost if wrong: a Phase-2 swap to @nestjs/swagger rewrites one generator file plus its call
  sites, which today number three.
Task 11: Ruling: the served document is PUBLIC at /api/v1/openapi.json in every environment —
  backend.md §7 and spec §5 both write that path with no environment qualifier, and the only
  routes it can describe in Phase 1 are three health probes. Cost if wrong: from Phase 2 the
  document enumerates the authenticated surface to anonymous callers; revisit when the first
  authenticated route lands, and note it in the Phase 2 dispatch.
Task 11: known trap carried into the dispatch — Nest does not register routes until
  `app.init()`, and `app.listen()` inits implicitly, so an assertion placed "before listen"
  naively sees ZERO routes and passes vacuously. Requires an explicit `await app.init()` first
  AND a positive control proving the assertion sees the real app's routes.
Task 11: built at 813bc1e (DONE_WITH_CONCERNS). No @nestjs/swagger — paths come from the live
  application's controller metadata via Nest's own RoutePathFactory, schemas from Zod through a
  local @ApiDoc decorator + zod-to-json-schema. Implementer found and fixed the vacuous-boot trap
  itself (explicit await app.init() before the assertion) and added an empty-router refusal plus a
  rogue-route cross-check against Express's own stack.
Task 11: review of 02c7a45..813bc1e — 0 Critical, 1 Important, 7 Minor, 2 warnings.
  The reviewer could find NO path by which the assertion passes while an undeclared route is
  served: empty inventory, missing metatype, handler-vs-class metadata target and out-of-band
  registration are each guarded or caught.
  IMPORTANT #1: the inventory uses RoutePathFactory.create() RAW, but Nest registers
    router.normalizePath(path), which runs LegacyRouteConverter.tryConvert — so `@Get('*')` or
    `@Get(':id?')` would make the inventory and Express disagree and the API UNBOOTABLE on a
    legitimate route, with a message blaming the checker. No-op for today's four routes, which is
    why everything is green. It also falsifies the "cannot disagree with the routes Nest
    registered" claim now written into backend.md §3 — a documentation defect under the honesty
    rule, in the same change.
  Warning A: roadmap.md still says the assertion "is not written yet" — now false.
  Warning B: mutation M7's "9 failures" does not add up against a 9-test file whose first test
    cannot detect it. Report-evidence gap, not a code defect.
Task 11: Ruling: promote Minors #2, #3, #4, #5, #6 and #7 into fix round 1 rather than deferring
  them. The skill's default is that minors never enter the loop; every one of these is a
  one-to-three-line change inside a file the round is already editing, and two of them (#2's
  regex-path blind spot in the LAST LINE OF DEFENCE, #5's overstated docblock) are the exact
  failure class this branch has been bitten by four times. Batching them costs one re-review;
  deferring them costs a whole later round. Cost if wrong: a slightly larger fix diff for the
  re-reviewer to read. #8 (cli.ts hardcodes log level/pretty — cosmetic, one-shot script) is the
  only finding deferred.
Task 11: minor (deferred): openapi cli.ts:44-49 hardcodes logger level/pretty instead of deriving
  them from the env it just loaded.
Task 11: fix round 1/5 (8 addressed, 0 open; commits 813bc1e..d06cb21). Re-reviewer traced F1,
  F2/F2b and F3/F3b against the code and confirmed each new test would fail with the fix gutted,
  INDEPENDENTLY of the report's mutation table. It also verified the normalizePath reproduction
  against the framework source rather than against the report, and checked the writer/reader pair
  the branch has split before: describeRoutesFrom now takes the normaliser as a REQUIRED third
  parameter, so no caller can silently get the raw factory path, and both readers (the assertion
  and the OpenAPI generator) reach the router only through it.
  The implementer INTRODUCED A FACTUAL ERROR WHILE FIXING A FACTUAL ERROR — wrote `{*splat}` in
  backend.md where the converter emits `{*path}` — and caught it itself against the converter
  source before committing. Committed wording verified correct by the re-reviewer.
  Honesty A: M7 restated, not deleted. The original "9 failures" was a ReferenceError blowing up
  the whole file; the real detectors are exactly the two tests the first review named.
Task 11: two NEW Minors introduced by the fix round — (a) generate.ts:98-116, the new
  assertUniqueOperationIds was inserted between buildOpenApiDocument's docblock and its function,
  so one function carries two docblocks and the other carries none; (b) health.contracts.ts:24-25
  claims the schema/handler gap "is why the integration test asserts the served body's key shape
  separately" — NO TEST LINKS A SCHEMA TO A SERVED BODY. /health/ready's check is toMatchObject,
  which does not even pin the key set.
Task 11: Ruling: fix both in a round 2 rather than deferring them to the whole-branch review. The
  skill's default sends Minors to the ledger, and (a) alone would go there. (b) is a FALSE
  STATEMENT ABOUT TEST COVERAGE written while correcting a false statement about test coverage —
  the second time in two rounds, and the fourth on this branch, that a fix has introduced a
  true-looking claim that isn't true. CLAUDE.md makes stale documentation a release-blocking
  defect; a claim of coverage that does not exist is worse than the overstatement it replaced,
  because it tells the next reader not to look. Both are single-line edits.
  Cost if wrong: one extra fix round and one cheap re-review on a two-line diff.
Task 11: fix round 2/5 (2 addressed, 0 open; commits d06cb21..5942482). The implementer took the
  HARDER of the two options it was offered: rather than downgrading the docblock to "uncovered",
  it wrote two integration tests that parse the live /health/ready and /health/detailed bodies
  through readinessReportSchema and detailedReportSchema, making the sentence true instead of
  smaller. Re-reviewer verified the claim LITERALLY: the schemas the tests parse against are the
  same objects @ApiDoc publishes into the document, and grep confirms no other test binds them,
  so "the only check that catches it" holds.
  It also volunteered the pattern behind its two false claims, unprompted: both asserted coverage
  living in ANOTHER FILE, written right after proving something adjacent — "the proof of the
  adjacent thing supplies the feeling of having checked". Rule it adopted: a sentence claiming
  another file covers something requires opening that file, and if it is a test, running it under
  mutation BEFORE the sentence is written. That ordering changed what it wrote — G1 alone would
  have justified "the new test catches it", but two committed-document tests also fired, so it ran
  G2 (regenerate openapi.json, as an author would) and only then could write "it is the ONLY check
  that catches it". Worth carrying into Tasks 12-16.
Task 11: gates as reported by the implementer, cold: lint/typecheck/build re-run with --force so
  nothing came from cache; 256 unit, 139 integration against the live compose stack; tree clean.
Task 11: CLOSED (02c7a45..5942482). Two reviews, two fix rounds, 0 Critical, 1 Important, 9 Minor,
  2 honesty items. The Important was a latent unbootable-API trap that was a no-op on all four of
  today's routes — the reviewer found it by reading Nest's registration path rather than the diff.
  Roadmap narrative updated by the implementer in 5942482; resume pointer moved by the controller
  in the commit above.
Task 11: minor (deferred, for the whole-branch review): cli.ts hardcodes logger level/pretty;
  finding-4's app.close() wrapper and main.ts's init()-before-assert ordering are guarded but not
  directly tested (no test boots the process); two deep imports into @nestjs internals
  (route-path-factory.js, constants.js), documented at the import site; @ApiDoc is optional and
  not boot-asserted; x-sentinel-access is a vendor extension until Phase 2; apps/api still
  declares an unused `dotenv` devDependency alongside dotenv-cli.

## PAUSED at user request — after Task 11

State: HEAD is the roadmap commit above, tree clean. Tasks 1-11 complete and reviewed clean,
nothing owed. 26 commits unpushed (counted, not estimated); origin/main still at 027d8f7
(Tasks 1-3 only).
Next: Task 12 — packages/ui, design tokens and base primitives.

## Task 12 — packages/ui (design tokens and base primitives)

Pre-flight scan (Task 12's text against what Tasks 1-11 actually built, and against itself):

| Row | Checked | Found |
|---|---|---|
| 12 <-> 1 (vitest.workspace.ts) | Task 12 mandates button.spec.tsx / field.spec.tsx | CONFLICT. unit project includes only `packages/*/src/**/*.spec.ts`. `.tsx` specs would NEVER RUN. And `pnpm test` = `vitest run --project unit` from root, so the `packages/ui/vitest.config.ts` Step 4 mandates is not read by the root run at all. |
| 12 <-> 1 (eslint.config.js) | Step 4: "no raw hex (the lint rule from Task 1 enforces it)" | CONFLICT. Grepped all 154 lines of eslint.config.js: NO SUCH RULE EXISTS. design-system.md §7 asserts one does. Task 1 did not build it; the plan misremembers. |
| 12 <-> 1 (tsconfig.base.json) | React primitives under the shared base config | CONFLICT (mechanical). `lib: ["ES2023"]` has no DOM, and there is no `jsx` option. `HTMLButtonElement`, `document`, and JSX will not typecheck. |
| 12 <-> 1 (eslint files globs) | `.tsx` under the type-checked config | GAP. No glob covers `.tsx`; `**/*.spec.ts` test exemptions do not cover `**/*.spec.tsx`. |
| 12 <-> 13 | 13 consumes @sentinel/ui tokens + primitives | tokens.css opens `@import 'tailwindcss'`. If Task 13's globals.css also declares it, Tailwind is emitted twice. Carry into Task 13's dispatch. |
| 12 <-> 13 | design-system.md §7: tokens "consumed through Tailwind theme extension" | The plan's `:root` custom properties do NOT generate Tailwind named utilities (`bg-surface`) on their own; v4 needs `@theme`. Unresolved by the plan text. |
| 12 internal | Step 3 "8 tests" vs the spec block | Consistent - exactly 8 `it()`s. |
| 12 internal | `tokensIn(':root {')` vs the three `:root` selectors in the CSS | Sound. The literal `':root {'` (space-brace) matches only the light block; the two dark selectors are `:root:not(...)` and `:root[...]`. |
| 12 internal | jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`) in both .tsx specs | GAP. Requires a setup file registering `@testing-library/jest-dom/vitest`; the plan lists the dependency but mandates no setup file, and the setup must be wired into the ROOT workspace project (see row 1). |
| 12 internal | Step 4's no-raw-hex assertion in button.spec.tsx | Weak proxy: it inspects one component's rendered HTML. Real enforcement is the missing lint rule. |

Task 12: Ruling: the mechanism for running .tsx specs is the implementer's to choose, but the
  OUTCOME is mandated and must be PROVEN: root `pnpm test` must actually execute the .tsx specs
  in a jsdom environment, with the test names visible in the root run's output pasted into the
  report, and every other package must keep `environment: 'node'`. This branch has been bitten
  four times by claims of coverage that no run produced; a .tsx spec that silently matches no
  include glob is that failure exactly, and it is invisible because `passWithNoTests` is on.
  Cost if wrong: the root test script or workspace file grows a shape a later task has to
  rework - cheap, and the proof requirement makes a silent miss impossible.
Task 12: Ruling: BUILD the missing no-raw-hex lint rule in this task rather than deferring it.
  design-system.md §7 states as fact that a lint rule enforces it and the plan's Step 4 repeats
  the claim; both are false today. Under CLAUDE.md's honesty rule a documented control that does
  not exist is a defect, and Task 12 is the first task that produces the code it governs.
  Cost if wrong: an over-broad rule flags a legitimate hex somewhere later - it is scoped to
  packages/ui and apps/web and is one line to tune.
Task 12: Ruling: packages/ui runs NO Tailwind build in Phase 1. Primitives express token colours
  as Tailwind arbitrary-value utilities referencing the custom properties directly
  (`bg-[var(--color-surface)]`), which need no theme extension and no build to be correct. The
  implementer may instead use named utilities via `@theme inline` ONLY if it empirically proves,
  against a real Tailwind run, that they generate - no unverified mechanism either way.
  tokens.css ships verbatim per the plan; tailwindcss is a peer dependency, and Task 13 owns the
  pipeline. Cost if wrong: verbose class strings that a later task converts to named utilities
  with a mechanical find/replace across eight files.
Task 12: Ruling: tokens.css keeps its `@import 'tailwindcss'` line verbatim as the plan mandates.
  Carry-forward for Task 13: apps/web must import @sentinel/ui's tokens.css INSTEAD OF declaring
  its own `@import 'tailwindcss'`, or Tailwind is emitted twice. Cost if wrong: a duplicated
  stylesheet in the web bundle, caught the moment Task 13 builds.
Task 12: built at c1ca471 (DONE). packages/ui with tokens.css transcribed byte-exact from the
  brief, eight forwardRef'd primitives, a new `ui` vitest project (jsdom) alongside `unit`
  (node), a jest-dom setup file, and the no-raw-hex ESLint rule that Ruling 2 found missing.
  Implementer self-caught two real bugs in its own first draft (Button's
  `disabled ?? pending` letting an explicit `disabled={false}` override `pending`; Field not
  forwardRef'd) and one brief defect (the brief's default `userEvent` import does not typecheck
  under nodenext against that package's exports map).
Task 12: review of f06451e..c1ca471 — 0 Critical, 3 Important, 11 Minor.
  The reviewer verified BOTH load-bearing claims against mechanism rather than against the
  report: it read esquery's selector semantics to confirm the no-raw-hex rule matches the class
  strings the primitives actually emit AND does not self-trigger on button.spec.tsx's
  `/#[0-9a-f]{3,8}\b/i` regex literal; and it read tailwindcss@4.3.3's own source to confirm
  input.tsx's `aria-invalid:` variant is generated by the functional aria handler rather than
  the static suggest() list. It also diffed tokens.css against the brief line by line and then
  independently against design-system.md's tables — no transposed digit.
  IMPORTANT #1: design-system.md:165 still says tokens are "consumed through Tailwind theme
    extension" — the mechanism Ruling 3 deliberately rejected. Task 13 reads that sentence to
    build the pipeline and would expect `bg-surface` utilities that do not and will not exist.
  IMPORTANT #2: vitest.workspace.ts:34 scopes the jsdom project to `packages/ui/src/**/*.spec.tsx`
    ONLY. An apps/web `.spec.tsx` from Task 13 matches NO project, and `--passWithNoTests` prints
    green while executing nothing — the exact trap Ruling 1 was written to close, left open one
    task ahead of the task that walks into it.
  IMPORTANT #3: filenames. Global Constraints and coding-standards.md:33 both say React
    components are `PascalCase.tsx`; the brief's Files line mandates `{button,input,...}.tsx`
    and the implementer followed the brief.
Task 12: Ruling: RENAME the eight primitives to PascalCase.tsx. coding-standards.md:33 is the
  checked-in standard the plan's Global Constraints was copied verbatim FROM, and it is
  unambiguous; the brief's lowercase list is the plan restating a shadcn habit, which is an
  argument, not an authority. Deciding now costs eight renames and three import sites; deciding
  after Task 13 imports them costs a cross-package rename. Cost if wrong: if apps/web ever runs
  the shadcn CLI it emits lowercase files, and the repo would be half-and-half — so the same
  change records in components.md that shadcn-generated files get renamed to match.
Task 12: Ruling: promote Minors #4, #5, #6, #7, #8, #9, #10, #11 and #13 into fix round 1 rather
  than deferring them. The skill's default keeps Minors out of the loop; these earn the
  exception on the same grounds as Task 11's batch. #4 is misclassified — `Field` overwriting a
  child's existing `aria-describedby`/`aria-invalid` with `undefined` is the one component whose
  entire job is that association silently DESTROYING it, which is Important behaviour in Minor
  clothing. #9 and #8 are false claims in a docblock and a lint comment — the exact failure class
  that has bitten this branch five times now, and the cheapest possible moment to kill each is
  while the file is already open. #5 covers the branch Task 13's forms will actually exercise.
  The rest are one-to-three-line edits inside files this round already touches. Cost if wrong: a
  larger fix diff for the re-reviewer to read; deferring instead costs a later round each.
Task 12: minor (deferred, for the whole-branch review): #12 Badge's severity variants carry
  colour with no glyph slot, against design-system.md:99's "never colour alone" — not required by
  the brief, and the domain components that consume Badge are the right place to settle it;
  #14 components.md:9-11 places primitives at `components/ui/` and calls them "shadcn/ui based"
  while this ships hand-rolled primitives at packages/ui/src/components/, and CLAUDE.md's stack
  table still lists shadcn/ui — banner-marked "Not Implemented" so aspirational, not false;
  assign to Task 16's documentation pass.
Task 12: Ruling: roadmap.md stays out of this commit. The reviewer flagged CLAUDE.md's
  "same change" wording against this branch's convention of a separate `docs(roadmap)` commit
  (f06451e is the precedent). Convention wins: the roadmap moves in the controller's commit when
  the task CLOSES, which is the only moment its status is true. Cost if wrong: a reader looking
  at the feature commit alone sees no status change — mitigated because the two commits are
  adjacent and the roadmap is never stale for longer than the review loop.
Task 12: fix round 1/5 committed at 784504c (12 findings addressed per the implementer; commits
  c1ca471..784504c). Implementer reports 275 unit tests (up 3: the new Field aria-merge,
  aria-invalid and useId-fallback cases), 139 integration unaffected, lint/typecheck/build green,
  and mutation evidence for findings 4 and 5. Scoped re-review dispatched; the FIRST re-review
  dispatch died to a session limit after 2 tool calls having produced nothing, and was
  re-dispatched from scratch against the same diff package.
Task 12: re-review of c1ca471..784504c — 12 of 12 ADDRESSED, 0 Critical, 0 Important, 3 new
  Minors introduced or left by the fix. The re-reviewer verified the two claims that no test can
  reach, against source rather than against the report: it intersected all 48 token names in
  tokens.css against all 419 theme-variable names in tailwindcss@4.3.3's theme.css and confirmed
  `--text-sm` is the ONLY collision, so the audit sentence is true including the namespaces it
  does not enumerate; and it swept the repo for stale lowercase component paths after the rename,
  finding live code and config clean with only historical prose remaining. It also checked both
  mutation proofs for coherence rather than existence — that the mutation shown would actually
  produce the failure shown.
Task 12: three NEW Minors from the fix round — (a) Button.tsx:28-29 warns against "the bare
  `text-sm`/`leading-sm` utilities, which follow Tailwind's own 0.875rem/line-height default":
  `leading-sm` IS NOT A TAILWIND UTILITY (theme.css defines only leading-tight/snug/normal/
  relaxed/loose), so the comment attributes a Tailwind default to a class that does not exist —
  and it says so two paragraphs after the document it cites gets the same point right; milder
  vacuous echo at design-system.md:189-190; (b) vitest.workspace.ts:34's broadened `ui` glob has
  no counterpart to the `unit` project's `exclude: ['**/*.integration.spec.ts']`, so a future
  `*.integration.spec.tsx` anywhere under packages/*/src or apps/*/src would run in the UNIT pass
  under jsdom with no 120s timeout instead of the integration pass — the gap predates the fix but
  the broadening enlarged its reach from one package to every package and app; (c) Alert.tsx:24's
  new role-by-variant default has no test.
Task 12: Ruling: fix round 2 for all three rather than deferring them. Same call as Task 11's
  round 2 and for the same reason: (a) is a FALSE CLAIM introduced by a fix round — the sixth
  instance of that pattern on this branch and the second introduced while correcting another
  one — and CLAUDE.md makes stale documentation release-blocking; (b) is the "test runs in the
  wrong place, silently" class that Ruling 1 exists to close, widened by the round that closed
  it, and Task 13 is the task that would walk into it; (c) is a behaviour change with no
  covering test. All three are one-to-three-line edits in files the round already opened.
  Cost if wrong: one cheap re-review on a tiny diff.
Task 12: minor (deferred, for the whole-branch review): packages/ui/dist/components/ on this
  Windows checkout still carries pre-rename lowercase filenames — NTFS does not re-case an
  existing directory entry on overwrite. dist/ and .turbo/ are gitignored and file CONTENTS are
  current, so nothing ships wrong, but Task 16's clean-clone exit-criteria run is the place to
  confirm a fresh `pnpm build` emits PascalCase on a case-sensitive filesystem.
Task 12: fix round 2/5 (3 addressed per implementer, 0 open; commits 784504c..2b0f9ce). The
  implementer surfaced, unprompted, that my round-2 order CREATED a third instance of the same
  trap: adding `exclude: ['**/*.integration.spec.tsx']` to the `ui` project means a
  `*.integration.spec.tsx` now matches NO project at all — `unit` is `.spec.ts` only, `ui`
  excludes it, and `integration`'s include is `.ts` only (verified directly in
  vitest.workspace.ts:17). It scoped the gap out rather than fixing it unasked, and reported it.
  That is the correct call and the correct disclosure.
Task 12: Ruling: close the instance in a round 3 (one line: `.tsx` added to the integration
  project's include), and assign the CLASS to Task 14. Three separate rounds on this one task
  have each produced a new spelling of "a spec filename that matches no vitest project passes
  green under --passWithNoTests"; patching globs one at a time is losing to it. The durable
  control is a check that every `*.spec.*` under packages/*/src and apps/*/src is claimed by
  exactly one project — the same shape as Task 11's boot-time route-access assertion and Task
  14's tenant-registry completeness check, and Task 14 is the CI-checks task where that shape
  belongs. Doing the guard here would be scope creep into a task three away; doing neither
  leaves a known live trap in front of Task 13. Cost if wrong: if Task 14 drops the guard, the
  class survives with only its current instances closed — so it is written into the ledger as a
  Task 14 requirement, not left as a suggestion.
Task 12: CARRY INTO TASK 14 — build a check that every `*.spec.*` file under packages/*/src and
  apps/*/src is matched by exactly one vitest project, and fail CI otherwise. Origin: three
  instances of the silent-skip trap on Task 12 alone.
Task 12: CARRY INTO TASK 13 — (a) apps/web must import @sentinel/ui's tokens.css INSTEAD OF
  declaring its own `@import 'tailwindcss'`, or Tailwind is emitted twice; (b) tokens are
  consumed through arbitrary-value utilities (`bg-[var(--color-surface)]`), NOT named utilities —
  packages/ui ships no `@theme` block, so `bg-surface`/`text-body` do not resolve; (c) `--text-sm`
  is 13px app-wide, overriding Tailwind's own `--text-sm`, while `--text-sm--line-height` keeps
  Tailwind's default — pair `text-[length:var(--text-sm)]` with `leading-[var(--leading-sm)]`
  explicitly; (d) a real apps/web spec importing @testing-library/react directly needs that
  package as an apps/web devDependency — the shared setupFiles path resolves its OWN imports
  against packages/ui's node_modules, which does not extend to the spec's imports.
Task 12: fix round 3/5 (1 addressed, 0 open; commits 2b0f9ce..0621e54).
Task 12: combined re-review of rounds 2+3 (784504c..0621e54) — 4 of 4 ADDRESSED, 0 new breakage,
  0 out-of-scope. One re-review seat spent on two rounds rather than two. The re-reviewer read
  tailwindcss@4.3.3's theme.css itself to verify the REPLACEMENT sentence rather than reading it
  for plausibility (`--leading-*` is tight/snug/normal/relaxed/loose only, so "generates no CSS at
  all" is right; --text-sm/-–text-sm--line-height confirmed at theme.css:349-350; no `--duration-*`
  namespace and no `--row-height-*` at all; 48 token names counted independently). It then derived
  the glob routing table from the three projects' includes and excludes rather than accepting the
  implementer's claim: foo.spec.ts -> unit, foo.spec.tsx -> ui, foo.integration.spec.ts ->
  integration, foo.integration.spec.tsx -> integration. Exactly one project each. The trap that
  cost this task three rounds is now closed in all four spellings.
Task 12: CLOSED (f06451e..0621e54). Two reviews across four dispatches, three fix rounds,
  0 Critical, 3 Important, 14 Minor, 0 open. Every Important was invisible to the test suite:
  a `.claude/` document describing the Tailwind mechanism this task deliberately rejected and
  that Task 13 would have built from, a jsdom glob that left the silent-skip trap open for
  apps/web, and a filename convention that contradicted the checked-in standard. The recurring
  false-sentence pattern produced one more instance (a Tailwind `leading-sm` utility that does
  not exist) and was caught by the re-review, not by any command.

## PAUSED at user request — after Task 12

State: HEAD is 8478963 (the roadmap commit), tree clean. Tasks 1-12 complete and reviewed
clean, nothing owed on Task 12. 30 commits unpushed; origin/main still at 027d8f7 (Tasks 1-3).
Next: Task 13 — apps/web, the Next.js App Router shell. Its four carry-forwards from Task 12
are in the ledger above AND in roadmap.md's "Known outstanding" list, as is Task 14's guard.
PUSHED at user request (2026-08-21, after Task 12): origin/main fast-forwarded 027d8f7..8478963
  (31 commits) and origin/feat/phase-1-foundation 02c7a45..8478963 (9 commits). Verified as a
  true fast-forward first — origin/main was an ancestor of HEAD with 0 commits of its own.
  Local `main` ref fast-forwarded to match so it is not left 31 commits stale.
  Note for the record: main now carries Tasks 1-12, which have each passed per-task review but
  NOT the whole-branch final review the plan schedules after Task 16. The user was told this
  before the push and asked for it anyway.

## Task 13 — apps/web Next.js shell (BASE 8478963)

Task 13: preflight cross-task scan (this task only; the plan-wide scan ran before Task 1).
  Row 1 — Task 13 produces `buildSecurityHeaders(nonce, enforceCsp)`; nothing downstream in
  Phase 1 consumes it. Consistent with the plan's own §"Type consistency" line.
  Row 2 — Task 13 consumes `@sentinel/ui` (tokens.css + 8 primitives, Task 12) and
  `@sentinel/config`'s `webEnvSchema` (Task 2). Both exist and export what the brief names:
  webEnvSchema = { NODE_ENV, APP_ENV, LOG_LEVEL, WEB_PORT, WEB_BASE_URL, API_BASE_URL }.
  Row 3 — Task 13 vs Task 9's SecurityHeadersMiddleware: both build the
  transport-and-headers.md §2 table. Task 9 additionally sets Cross-Origin-Embedder-Policy
  and a blanket Cache-Control: no-store, and uses report-uri /api/v1/csp-report. Task 13's
  own test table asserts neither of the extras and Step 4 creates /api/csp-report. Two
  divergences to rule on — see below.
  Row 4 — Task 13 internally self-consistent: the files it creates match the files its steps
  touch; its one spec (apps/web/src/security-headers.spec.ts) tests the pure function it
  creates. `.spec.ts` under apps/*/src routes to the `unit` vitest project (node env) —
  correct for a pure function, and the routing table verified in Task 12 holds.
  Row 5 — Task 13 vs Task 14: Task 14 owes the every-spec-matches-exactly-one-project guard.
  Task 13 adds the first apps/web specs; it does not owe the guard.
Task 13: Ruling: the web origin does NOT set a blanket `Cache-Control: no-store`. Why: Task 9's
  no-store is justified in its own comment as "the API serves nothing cacheable"; frontend.md §2
  makes marketing Static/ISR and reserves no-store for "any response containing tenant data".
  A blanket no-store on the web origin would contradict the rendering-strategy table this task
  is building the route groups from. Cost if wrong: an authenticated page could be cached — but
  no authenticated page exists until Phase 2, and Phase 2's (app) group must set no-store on its
  own responses. Carried into Task 13's dispatch as an explicit instruction so Phase 2 inherits it.
Task 13: Ruling: web's CSP `report-uri` is `/api/csp-report`, matching the route Step 4 creates,
  not the API's `/api/v1/csp-report`. Why: the report must reach a collector on the same origin
  that sent the policy; the API's path is on the API origin. Cost if wrong: one string.
Task 13: Ruling: `app/api/csp-report/route.ts` pins `export const runtime = 'nodejs'`. Why: it
  logs through packages/observability (pino), which does not run in Next's Edge runtime; a
  report endpoint that throws on every report is exactly the decorative CSP
  transport-and-headers.md §3 warns about. Middleware stays on Edge (Next gives it no choice).
  Cost if wrong: if pino turns out to work on Edge the pin is a harmless, documented default.
Task 13: implementer dispatched (opus) — multi-file integration with four known traps
  (Tailwind v4 double-emit, vitest glob routing, Edge vs Node runtime, Next-vs-nodenext
  tsconfig), so not a cheap-tier transcription task.
Task 13: SESSION INTERRUPTED — the VS Code process was closed while the implementer ran. Recovery
  state read from git, not from memory: HEAD 6d97bb5, tree clean, two commits on top of BASE
  8478963 (594687d feat(web) + 6d97bb5 docs(web) self-review). apps/web exists with 22 tracked
  files. The implementer never wrote task-13-report.md and never returned a status, so the task
  is mid-loop at "implementer dispatched", NOT complete. Resuming the implementer to produce the
  report before any review is dispatched — a task reviewer without the report file is missing one
  of its three required inputs.
  Note for the review: the tree has NO apps/web/middleware.ts; it has apps/web/proxy.ts instead.
  The brief names middleware.ts. That divergence needs an explanation from the implementer and a
  ruling from me before the review, not after.
Task 13: implementer returned DONE_WITH_CONCERNS after resume; report written (662 lines).
  Verified independently before ruling: next@16.3.2 is the installed version; .claude/ docs were
  updated in the same change (frontend.md +29, transport-and-headers.md +41, design-system.md
  +18, page-map.md +9, roadmap.md +72), satisfying CLAUDE.md's same-change documentation rule;
  tsbuildinfo/.turbo/test-results are gitignored, but apps/web/next-env.d.ts IS tracked.
Task 13: Ruling: accept `proxy.ts` in place of the brief's `middleware.ts`. Why: Next 16.3.2
  deprecates the middleware filename in favour of proxy.ts; the implementer captured the
  deprecation warning from a real build before renaming. The brief is stale, not the code — a
  plan defect, ruled rather than papered over. Cost if wrong: none to the running app (proxy.ts
  is the supported name on 16); the risk is Tasks 14-16 referencing the old filename, so it is
  written into roadmap.md as a carry-forward, not left in this gitignored ledger alone.
Task 13: Ruling: accept `force-dynamic` on every HTML route, overriding frontend.md §2's
  Static/ISR for marketing. Why: Next can only nonce its inline bootstrap scripts for a page
  rendered against a real request — the implementer measured a static `/` carrying 9 inline
  scripts and 0 nonces, which `'strict-dynamic'` would execute none of. transport-and-headers.md
  §3's nonce CSP is a security control; frontend.md §2's rendering strategy is a performance
  preference. The control wins. The divergence is documented in frontend.md itself, so the
  contradiction is recorded rather than silent. Cost if wrong: marketing pages are dynamic and
  not CDN-cacheable — a real but reversible performance cost; the escape hatch is scoping the
  nonce CSP to (app)/(auth) and giving (marketing) a hash-based policy. Revisit when marketing
  has actual traffic, not now.
Task 13: Ruling: accept `(app)/dashboard/page.tsx` in place of the brief's `(app)/page.tsx`.
  Why: two route groups cannot both own `/`; `(marketing)/page.tsx` already does. The brief's
  file list is impossible as written. `/dashboard` matches ui-ux/page-map.md. Cost if wrong:
  a placeholder sits at a different URL than the plan imagined — trivial, and page-map.md is
  the more specific authority.
Task 13: NOT ruled yet, deliberately routed to the review instead: the three gaps the
  implementer named and left open (next-env.d.ts tracked and churning, no E2E stage in CI, no
  eslint-plugin-react/react-hooks in the workspace). Adjudicating them now would be pre-judging
  findings for the reviewer. The reviewer verdicts them; I rule after.
Task 13: task reviewer dispatched (opus) over 8478963..6d97bb5 — 2306 insertions across 33
  files, a security control (CSP) at its centre, and four self-disclosed false comments in the
  report, so this diff gets the most capable tier rather than a mid one.
Task 13: review dispatch #1 FAILED — the reviewer agent terminated on its first turn against an
  account session limit, before reading any input. No review file, no findings, HEAD unchanged
  at 6d97bb5, tree clean. Nothing to salvage and nothing to re-do; re-dispatching the identical
  review. Recorded so a resuming session does not mistake the absence of task-13-review.md for a
  review that returned clean.
Task 13: review dispatch #2 returned. Spec ✅ (one real miss: WEB_PORT), Task quality Approved
  conditional on the two Criticals. 2 Critical, 7 Important, 7 Minor. The reviewer independently
  re-measured six load-bearing claims and all six held; it verified the nonce is genuinely
  per-request and reaches the HTML (18 nonce attributes over 16 script tags, different each
  request), that headers cover 404s and /_next/static, that the vitest spec is claimed by exactly
  one project and executes, and that Playwright passes 5/5 against an enforcing CSP. Full review:
  task-13-review.md.
Task 13: my three deferred gaps came back verdicted — next-env.d.ts MINOR (the reviewer tested
  the clean-clone typecheck consequence that would have made it Important and it does not hold),
  eslint-plugin-react-hooks IMPORTANT, CI E2E stage IMPORTANT. Both Importants are Important for
  the same reason: the gap is recorded only in this gitignored ledger and not in roadmap.md,
  where a fresh session would find it. That is the same failure mode as Task 12's vitest guard.
Task 13: Ruling: the five trivial Minors (M1 gitignore next-env.d.ts, M4 delete the other CSP
  request-header name, M5 await networkidle before the console-error assertion, M6 the loose
  dev/JSON provenance label, M7 roadmap's premature "Tasks 1-13 are complete") ride along in fix
  round 1 rather than deferring to the whole-branch review. Why: the skill's rule that Minors
  never enter the loop exists to stop the loop being EXTENDED; these are one-to-two-line edits in
  files the round already opens for Criticals and Importants, and M6/M7 are honesty-rule items —
  a false provenance label on captured output and a completion claim the review had not granted —
  which this branch treats as load-bearing. Cost if wrong: a slightly larger re-review diff.
  M2 (auth layout with no routes) and M3 (density context nothing consumes) are explicitly NO
  ACTION — both were asked for by the brief and both document their own inertness accurately.
Task 13: fix round 1/5 dispatched — original implementer resumed (context intact), 2 Critical,
  7 Important, 5 ride-along Minors.
Task 13: fix round 1/5 (15 addressed per implementer, 0 open; commit 6d97bb5..21746c5). 563
  insertions across 15 files; new apps/web/src/csp-report.ts + csp-report.spec.ts (34 tests) and
  apps/web/scripts/next-on-web-port.ts. Tests 287 -> 321. The implementer mutation-tested the new
  spec rather than reporting it green — reverting the URL masking fails 8 tests, removing the body
  cap fails 3 — which is the correct answer to I4's complaint (a test that passes if the handler
  is deleted) instead of another untested assertion.
Task 13: C1's audit found a SECOND instance — the implementer checked all 68 section citations
  the task added; 66 correct, and the wrong one had been cited twice (providers.tsx:9 AND the
  design-system.md status block written the round before). Same error, same habit, same task, the
  second one introduced by a fix round. That is the seventh and eighth instance of the false-claim
  class on this branch and the third-and-fourth introduced while correcting another one.
Task 13: Ruling: accept the implementer's stronger action on I5 — it REMOVED the ten
  minimumReleaseAgeExclude entries rather than documenting them. I had offered either. It then
  proved they were unnecessary (pnpm install, --frozen-lockfile and --lockfile-only all succeed
  without them, no lockfile change, because resolution is already pinned) and established that
  next@16.3.2 was installed ~3h after publication, inside the window the cooldown exists for. In a
  security product, ten unexplained supply-chain-control holes removed beats ten annotated. Cost
  if wrong: a future install of a just-published version blocks and needs a deliberate,
  documented exclusion — which is the control working, not failing.
Task 13: scoped re-review of round 1 dispatched (sonnet — 563-line fix diff against a fixed
  15-item findings list, not an open-ended audit).
Task 13: re-review of round 1 (6d97bb5..21746c5) — 15 of 15 ADDRESSED, 0 open, 0 new breakage,
  0 out-of-scope. The re-reviewer did NOT accept the implementer's mutation-testing claim on
  description: it reverted the URL masking itself (11 tests failed), reverted the body-cap logic
  itself (exactly 3 failed, matching the claim), restored both and confirmed a clean tree. It also
  re-ran the token-leak case on a realistic input, started a production server on WEB_PORT=3187 to
  prove I1 live (200 on :3187, nothing listening on :3000), and ran `pnpm install --frozen-lockfile`
  itself to prove I5's removals did not break install. Every Important was verified by execution,
  not by reading.
Task 13: controller verification (own run, not delegated): tree clean; `pnpm test` 321 passed /
  27 files, including apps/web/src/security-headers.spec.ts (9 tests). 3 commits on BASE.
Task 13: COMPLETE (commits 8478963..21746c5, review clean). One review, one fix round, 2 Critical,
  7 Important, 14 Minor total, 0 open. Both Criticals were single invented sentences — a wrong
  .claude/ section citation and a fabricated CORS mechanism written into the security document —
  and the citation audit they triggered found a second instance of the same error introduced by
  the PREVIOUS fix round. That class now stands at eight instances on this branch, four of them
  introduced while correcting another one. It is the one defect class no command on this branch
  can catch, and Task 15's skills work is the place to put a control.

## PAUSED at user request — after Task 13

State: HEAD is 21746c5, tree clean. Tasks 1-13 complete and reviewed clean, nothing owed on
Task 13 except the human visual pass (below). 34 commits unpushed on feat/phase-1-foundation;
origin/main and origin/feat/phase-1-foundation both still at 8478963 (Tasks 1-12).
Next: Task 14 — CI checks (OpenAPI diff, tenant-registry completeness).
Task 14 now owes THREE recorded requirements, all in roadmap.md's Known Outstanding, not only
here: (a) the guard that every *.spec.* under packages/*/src and apps/*/src is matched by exactly
one Vitest project (origin: Task 12, three instances); (b) an E2E stage in CI — the five Playwright
tests are today the ONLY assertions covering nonce-in-HTML and CSP-doesn't-break-the-page, and CI
stays green if they regress; (c) eslint-plugin-react-hooks, now that React application code exists.
OWED TO A HUMAN, not to a task: nobody has looked at apps/web in a browser. Step 6 of the plan asks
for visual confirmation that the type is IBM Plex and the theme follows the OS colour scheme. It is
verified by Playwright and by HTTP assertions; it is not verified by eye, and no non-Chromium
browser has loaded it.
PUSHED at user request (after Task 13): verified origin/main was a strict ancestor of HEAD with
  0 commits of its own before pushing — a true fast-forward, nothing on the remote to lose.
  origin/feat/phase-1-foundation 8478963..21746c5 and origin/main 8478963..21746c5 (3 commits,
  Task 13 only; Tasks 1-12 were already pushed after Task 12). Local `main` ref fast-forwarded to
  21746c5 so it is not left stale. All four refs now at 21746c5, tree clean.
  Correction to this ledger's previous pause note, which I misread when reporting: the branch was
  3 commits ahead of origin, not 34 — the earlier push had already landed Tasks 1-12.
  Note for the record, as before: main now carries Tasks 1-13, each of which has passed its own
  per-task review but NOT the whole-branch final review the plan schedules after Task 16. The user
  was told this before the Task 12 push and asked for it again here.

### Task 14 — CI checks: OpenAPI diff, tenant registry completeness, carry-forwards

Base: 21746c5
Task 14: brief written. Scope = plan Steps 1-5 PLUS the six requirements the ledger parked on this
  task: (a) FK-cascade structural rule + every-model-accounted-for (Task 6 rulings, closes N5);
  (b) spec-project coverage guard (Task 12 ruling, three instances); (c) CI E2E stage (Task 13
  review, Important); (d) eslint-plugin-react-hooks (Task 13 review, Important); (e) format:check
  decision (Task 9); (f) the missing root `dev` script that CLAUDE.md:55 and setup.md:31,50-53
  already tell developers to run.
Task 14: Ruling: `pnpm format:check` gets WIRED INTO CI and the 13 failing files get formatted,
  rather than deleting the script. Why: a formatter that has never passed is a broken window, and
  deleting format/format:check throws away the only mechanical consistency control the repo has;
  Task 9's own framing was "fixing the files without gating just lets it drift again", so the
  gate is the half that matters. Guards attached: .prettierignore's four deliberate exemptions
  (openapi.json byte-identity gate, tokens.css verbatim transcription, next-env.d.ts, all *.md)
  must be untouched, the reformat commits separately from the checks so the review can read the
  real diff, and both test lanes must be green after it because the 13 files include
  tenant-scope.ts and tenant-client.ts. Cost if wrong: a whitespace-only commit across 13 files
  that has to be reverted — cheap and mechanical.
Task 14: Ruling: the plan's own Step 2 implementation of check-openapi-diff is not achievable as
  written and the brief says so up front. `node --experimental-strip-types scripts/check-openapi-diff.ts`
  importing generateOpenApiDocument boots the Nest AppModule, which needs decorator metadata that
  Node's type-stripping does not emit — which is exactly why apps/api's openapi:generate compiles
  with tsc first. Implementer told to confirm rather than take it on trust, and given the two
  properties that actually matter (must not leave the tree dirty on success, must print a readable
  diff) instead of a prescribed mechanism. Cost if wrong: the implementer proves me wrong and uses
  the simpler form, which is a better outcome than following a broken instruction quietly.
Task 14: Ruling: deferred OUT of scope, explicitly — dead packages/config/tsconfig/* presets
  (already assigned to Task 16 by the Task 9 review), Redis EVALSHA/maxmemory-policy (performance,
  Phase 3/4), and the client-level `omit` guard (Task 6 residual; fails CLOSED, no constructed
  client uses that form — evaluate only if it is a one-rule ESLint addition that can be proven to
  fire, otherwise Task 16). Why: this task already carries six parked requirements on top of its
  own five steps; adding a speculative static check to that is how a task stops being reviewable.
  Cost if wrong: the omit gap survives to Task 16 with its fail-closed behaviour unchanged.
Task 14: roadmap.md is deliberately NOT in the implementer's file list — the controller updates it
  after the review, so it never claims a status the review has not granted.
Task 14: implementer dispatched (fresh agent, opus) over base 21746c5.
Task 14: implementer DONE — commits 21746c5..a18c95d (daf7fd7 checks+CI+lint+dev+docs, 2ce6a81
  the separate Prettier reformat, a18c95d a self-caught false comment). 2365 insertions across 39
  files, tree clean. Claims: 10 drills run/captured/restored, including the live trap (an unclaimed
  __probe__.spec.jsx asserting 1===2 while `pnpm test` printed 31 files / 375 tests passed) and a
  revert of vitest.workspace.ts's integration glob to its actual pre-fix form rather than a
  strawman. Measured Prisma 6.19.3: an omitted onDelete leaves NO relationOnDelete key in the DMMF,
  so the FK rule reports rather than guesses. Local: test 375, integration 139, build, e2e 5,
  `pnpm dev` starts web :3000 and api :3001. GitHub Actions itself UNRUN and explicitly not claimed
  (playwright install --with-deps on Linux, the E2E stage on a Linux runner, artifact upload).
Task 14: five items the implementer flagged for adjudication, deliberately NOT ruled before the
  review so the reviewer is not pre-judged: (1) the brief's "13 files" for format:check is really
  11 — the extra 8 were CRLF-only under core.autocrlf=true and 3 produce no diff at all; (2) it
  wrote a false code comment about a dynamic @sentinel/db import decoupling the spec from dist,
  MEASURED it before filing (Vite resolves dynamic specifiers at transform time, so it does not),
  and corrected it in a18c95d — the ninth instance of the branch's false-claim class, self-caught
  this time; (3) NEW pre-existing gap: `pnpm test` on a fresh clone fails because the unit lane
  needs built workspace dist and CI only survives because lint/typecheck run first under turbo's
  dependsOn ^build — not introduced and not fixed, recommends Task 16; (4) testing.md §6 says
  "never retried into passing" while playwright.config.ts sets retries: 2 in CI — inert until this
  task added the stage, now live, documented rather than silently changed; (5) seven divergences
  from the brief incl. scanning whole packages rather than only src for check:specs, and two new
  files (packages/db/src/datamodel.ts, apps/api/src/openapi/cli-args.ts) added to avoid widening
  the no-restricted-imports fence on the unscoped Prisma client.
Task 14: task reviewer dispatched (opus) over 21746c5..a18c95d — 2365 insertions, 39 files, and the
  centre of it is the mechanical guard on the tenant-isolation control the whole roadmap rests on,
  so this gets the most capable tier.
Task 14: review returned. Spec: MET with two partials (Steps 4/5 partial because the class C1 names
  is not closed; Step 10 partial for the live doc contradiction). Quality: APPROVED WITH CONDITIONS.
  1 Critical, 5 Important, 6 Minor. The reviewer re-ran six of the ten implementer drills and all
  six reproduced exactly, then invented five of its own — and the FIRST spelling it invented that
  the check does not handle got straight past it. It also ran every gate itself with Docker up
  (test 375, integration 139, build, e2e 5), proved the Prettier commit behaviour-neutral by
  regenerating all 11 files with the pre-commit formatter and diffing byte-for-byte, audited all 10
  new section citations (all correct — first task on this branch with a clean citation audit), and
  settled flagged item 1 by `git archive`ing both commits and running prettier on what Linux would
  actually check out (11 at base, 0 at HEAD).
Task 14: C1 — check:specs is blind to *.test.*, proved with packages/db/src/__probe__.test.ts
  containing expect(1).toBe(2): `pnpm test` printed 375 passed AND `check:specs` printed OK, both
  exit 0. The Task 12 trap reproduced inside the guard built to end it, via the most natural
  filename in the ecosystem. Every vitest project overrides include to `.spec.` only, discarding
  Vitest's default `{test,spec}`, and the candidate sweep globs `*.spec.*` only — blind in exactly
  the direction that manufactures confidence.
Task 14: Ruling on C1: widen the candidate sweep to `*.{spec,test}.*` and BAN the .test.* spelling
  rather than teaching the vitest projects to claim it. Why: the reviewer correctly says either is
  acceptable and silence is not, but two spellings for one concept is how this exact trap regrows —
  Task 12 hit three spellings of it and the third was created by the fix for the second. One
  convention, mechanically enforced, with a failure message that names the convention and says
  rename, is the version that cannot drift. All 41 existing spec files are already `.spec.*`, so
  the ban costs nothing today. Cost if wrong: a contributor who prefers .test.ts gets a red build
  with an explicit instruction — recoverable in one rename, and loud rather than silent.
Task 14: Ruling on I1 (stale DMMF): FIX THIS ROUND, not recorded as owed. The reviewer offered
  either. Why: the check's entire premise is refusing to answer from an artefact it has not
  verified, and it currently prints the Prisma CLIENT VERSION on the OK line — which reads as a
  provenance claim while saying nothing about whether the DMMF matches the schema on disk. The
  false green lands precisely on the developer workflow the check exists for (edit schema.prisma,
  run the check, get OK on a live cascade defect — the reviewer reproduced Task 6's exact defect
  this way). CI is safe via postinstall, so this is a local hole, but a security guard that is
  honest only in CI is a guard people learn not to run locally. Cost if wrong: a staleness
  comparison that false-positives after a checkout — bounded, and the failure direction is red.
Task 14: Ruling on I3: do BOTH halves this round, not just the rationale correction the reviewer
  made mandatory. Correct datamodel.ts:9-14 (it asserts a protection that is not there) AND widen
  the no-restricted-imports group to cover **/generated/client, with unscoped.ts and datamodel.ts
  exempted. Why: coding-standards.md §6 states as fact that lint enforces "no import of the
  unscoped Prisma client outside migrations, seeds, and platform admin", and the reviewer proved
  that false for the direct path with a bypass probe that linted clean. Leaving it means a security
  document describes a control that does not exist — the same class as Task 13's two Criticals, and
  the fix is one array entry plus two exemptions. Cost if wrong: a few more exemptions to add later.
Task 14: Ruling on I4: amend testing.md §6, do not change the config. Adopting the reviewer's
  shape — retries permitted ONLY in the E2E lane, unit and integration at 0, and a red-then-green
  retry is triaged rather than ignored because trace: 'on-first-retry' preserves the evidence. Why:
  §6's absolute was written about unit tests, where it is right, and over-generalised to a lane
  that did not exist when it was written; retries in a browser lane absorb infrastructure flake,
  not test flake. Cost if wrong: a genuinely flaky E2E test hides behind two retries — mitigated by
  the trace artefact and by the triage sentence being written into the doc rather than assumed.
Task 14: Ruling on I5: DEFER to Task 16, and the roadmap records it as OWED, not suggested.
  Implementer and reviewer independently reached the same call and I agree — the honest fixes are
  workspace-topology changes (a pretest build, or routing root `test` through turbo) that deserve
  their own review rather than riding into a CI-checks task. The reviewer's caveat is adopted
  verbatim: the failure mode is a CI gate whose correctness rests on an earlier step's task graph,
  which is the exact rot this task exists to stop, so it must not slip past Task 16.
Task 14: Ruling: Minors M1, M2, M3, M4 and M6 ride along in fix round 1; M5 is NO ACTION. Same
  reasoning as Task 13's ride-along ruling — these are one-to-two-line edits in files the round
  already opens for the Critical and the Importants, and M3 (check:specs passes vacuously on an
  empty candidate list) and M1 (every changed value announced as breaking) are signal-integrity
  items on checks whose whole premise is distrusting silent greens. M5 (E2E webServer timeout on a
  cold Linux runner) is deliberately left: it is unmeasurable until the first real CI run, and
  pre-emptively changing a timeout nobody has watched expire is guessing.
Task 14: fix round 1/5 dispatched — original implementer resumed (context intact): 1 Critical,
  4 Importants (I1, I2, I3 both halves, I4), 5 ride-along Minors. I5 deferred, M5 no action.
Task 14: fix round 1 INTERRUPTED — the implementer hit the account session limit mid-round, after
  writing the work to disk but before committing or reporting. Nothing was lost: HEAD unchanged at
  a18c95d, 479 insertions across 14 modified files plus 2 new (packages/db/src/schema-hash.{ts,spec.ts})
  sitting uncommitted. Its last words were that it had found a better I1 mechanism than the recorded
  hash I specified and was rewriting the guard around it.
Task 14: controller verification of the interrupted tree (own run, not delegated, because a dead
  agent's uncommitted work is exactly the thing not to take on trust):
  - pnpm typecheck: 14/14 tasks, exit 0.
  - C1 CLOSED. Re-ran the reviewer's exact probe (packages/db/src/__probe__.test.ts asserting
    1===2): check:specs now exits 1 with a rename instruction that carries the ruling's reasoning
    ("two spellings for one concept is how this trap regrows, and Task 12 hit three of them, the
    third created by the fix round for the second"). The OK line now reads "No banned .test.*
    spellings".
  - I1 CLOSED, by a BETTER mechanism than I ruled. I specified hashing schema.prisma at generate
    time and recording it beside the client. The implementer instead compares against
    generated/client/schema.prisma — the copy PRISMA ITSELF writes in the same invocation that
    writes the DMMF, so the two cannot disagree about which schema they came from. No recorder
    script, no postinstall coupling, no turbo-cache interaction. Drilled: reintroduced Task 6's
    Membership.userId Cascade WITHOUT regenerating -> exit 1 naming the staleness and the
    regenerate command (was exit 0 OK at review time); regenerated -> exit 1 naming the actual FK
    defect with the tenant-root qualifier intact; restored -> exit 0. schema.prisma verified
    unmodified afterwards.
  - I2 CLOSED. apps/api lint is now `eslint src scripts`, and tsconfig.json gained scripts/**.
    Required a real fix, not a glob edit: rootDir:"src" made including scripts/ impossible, so
    rootDir/outDir/noEmit:false moved to tsconfig.build.json (the only project that emits) and the
    checking project became noEmit. Emission still src-only.
  - I3 CLOSED, both halves. Re-ran the reviewer's bypass probe importing PrismaClient from
    ../generated/client/index.js: now 1 error (was exit 0, zero errors). coding-standards.md §6
    corrected to describe the control that now exists.
  - I4 CLOSED, and better than asked: the implementer verified the zero-retry claim BEHAVIOURALLY
    (a probe that only passes on a second attempt fails under both unit and integration) rather
    than asserting Vitest's default from documentation.
  - Minors M1, M2, M3, M4, M6 all present in the diff. 153 new spec lines across the two check
    spec files.
Task 14: implementer resumed to finish its own round — full gate run, commits, and the fix-round
  report section. Deliberately NOT finished by the controller: the work is complete on disk and
  nothing is blocked, so there is no usage-limit justification for collapsing the implementer and
  controller roles the way Task 10 had to.
Task 14: fix round 1/5 COMPLETE — commit 83ffbbc. C1, I1, I2, I3, I4 and Minors M1/M2/M3/M4/M6 all
  ADDRESSED and individually drilled; I5 (Task 16) and M5 (no action) recorded in the report as
  decisions rather than omissions. Unit suite 375 -> 403 tests, 32 files.
Task 14: MY I1 RULING WAS WRONG, and the implementer proved it by measurement rather than arguing
  it. I ruled the recorded-hash form (hash schema.prisma at generate time, record it beside the
  client). It BUILT that, then measured it failing: @sentinel/db's build is a cached turbo task, so
  a cache hit replays logs without re-running the recorder and the hash is never written — meaning
  `pnpm build && pnpm check:registry`, which is exactly the CI order, then fails for a reason
  having nothing to do with the schema. Same class in postinstall ("Already up to date" -> no
  postinstall runs at all). Its replacement compares schema.prisma against
  generated/client/schema.prisma, which Prisma writes in the same invocation as the DMMF: no
  separate step that can be skipped, no turbo or postinstall coupling. Prisma reformats its copy
  (9784 vs 9664 bytes), so both sides are normalised for horizontal whitespace — verified matching
  today AND that a Restrict->Cascade flip is still detected through the normalisation.
  The lesson worth keeping: a guard whose correctness depends on a build step having actually run
  is the same defect class as I5 (a CI gate resting on another step's task graph), which this task
  deferred to Task 16. I recorded that failure mode in a ruling and then reintroduced it in the
  fix for a different finding. The implementer caught it because it drilled the instruction instead
  of implementing it.
Task 14: implementer also corrected my controller verification, unprompted: my summary of its
  interrupted tree missed that its final edits had changed the schema-hash API (recordSchemaHash
  removed, decideSchemaStaleness re-signatured), leaving schema-hash.spec.ts written against the
  old shape — it would have gone red on the next run. Rewritten, 11 tests green. My verification
  ran typecheck and the drills, which is why it did not surface: the spec was type-consistent
  enough to compile and I did not run `pnpm test`. Recorded because the near-miss is the point —
  a controller check that runs typecheck plus targeted drills is not a substitute for the suite.
Task 14: ONE GATE OPEN — `pnpm test:integration` is UNVERIFIED on this tree. Docker Desktop went
  down mid-session. The implementer ran it anyway and checked the failure causes rather than
  inferring: all infrastructure (no container runtime strategy, Redis MaxRetriesPerRequestError,
  503s), not assertions. It passed at 10 files / 139 tests earlier in the session, but that was
  BEFORE the schema-hash, datamodel.ts and tsconfig changes, so it does not cover them. Controller
  starting Docker Desktop and running it before the re-review rather than handing the re-reviewer
  a gate nobody has closed.
Task 14: OPEN GATE CLOSED by the controller — started Docker Desktop, brought up the stack
  (postgres/redis/minio/mailpit all Healthy, minio-init created both buckets), and ran
  `pnpm test:integration` on the fix-round tree at 83ffbbc: 10 files / 139 tests passed, 12.76s.
  That covers the schema-hash, datamodel.ts and tsconfig changes the earlier passing run predated.
  No gate is now unverified on this branch except GitHub Actions itself.
Task 14: scoped re-review of round 1 dispatched (sonnet — a bounded fix diff against a fixed
  11-item findings list, not an open-ended audit; the open-ended pass already happened at opus).
Task 14: re-review of round 1 (a18c95d..83ffbbc) — 10 of 10 items ADDRESSED, 0 open, nothing broken.
  The re-reviewer ran every gate itself INCLUDING pnpm test:integration (10 files/139 tests), which
  the implementer could not, and re-executed the drills rather than reading the report. On the I1
  divergence it did the thing I asked for and could not defeat it: seven adversarial inputs against
  the whitespace normalisation (line-merging, line-reordering, Unicode NBSP smuggling, blank-line
  padding, tab/space realignment, a genuinely added field) — every real semantic change still
  detected, only cosmetic reformatting tolerated. It also independently substantiated the turbo
  reasoning behind the divergence by confirming turbo.json's build outputs exclude
  packages/db/generated/**.
Task 14: two findings the implementer did not report, both raised by the re-review:
  (a) NEW MINOR introduced by M1's own fix — check:openapi's prose exemption keys on the leaf name,
      so a real schema property named `description` (a future Finding.description) would be
      classified as prose and not raise the /api/v2 banner. Messaging only; the exit code never
      depended on that classification and still fails closed.
  (b) FALSE CLAIM in the fix-round report — it stated I5 was "recorded in the roadmap as owed" when
      roadmap.md was untouched anywhere in the Task 14 range. The claim described work assigned to
      the CONTROLLER (the brief withheld roadmap.md from the implementer), so it was a claim about
      someone else's unfinished work. Ninth-and-tenth instances of the branch's false-claim class,
      both caught by review rather than shipped.
Task 14: Ruling: close the task on both, no round 2. Why: (a) is a messaging gap on a check that
  fails closed regardless, and the skill's rule is that Minors never EXTEND the loop — there is no
  round already open for it to ride along in, and opening one costs a full re-review cycle for a
  banner. (b) is now true rather than false: the roadmap carries I5 as owed to Task 16 with the
  reasoning and the reproduction. Both are recorded — (a) in roadmap.md's Known outstanding, (b) as
  an appended controller note in task-14-report.md so the record does not stand with a false claim
  in it. Cost if wrong: a /api/v2 banner is missed on one property rename, which the diff still
  prints and the exit code still fails on.
Task 14: controller verification (own run, not delegated): tree clean; lint, typecheck,
  format:check all exit 0; pnpm test 403 passed / 32 files; check:specs, check:openapi,
  check:registry all OK; pnpm build 8/8; pnpm test:integration 139 passed / 10 files against the
  live stack; pnpm test:e2e 5 passed. Every gate on this branch is now green under my own hand
  except GitHub Actions, which has never run.
Task 14: roadmap.md updated in commit 2dad5bb — status paragraph for the three checks, Tasks 1-14
  complete, and Known outstanding REWRITTEN rather than appended to: six items Task 14 owed are
  closed and removed (E2E stage, react-hooks, spec guard, format:check, dev script, OpenAPI CI
  diff), three added (clean-clone `pnpm test`, the never-run workflow, the check:openapi prose
  exemption), and the human browser pass promoted out of the gitignored ledger into the roadmap
  where a fresh session will find it.
Task 14: COMPLETE (commits 21746c5..2dad5bb). One review, one fix round, one re-review, 1 Critical,
  5 Important, 7 Minor total, 0 open. The Critical is the one worth remembering: check:specs, the
  guard built to end Task 12's silent-skip class, was itself blind to *.test.* — the most natural
  filename in the ecosystem — and a review proved it by putting a test asserting 1===2 in the tree
  and watching BOTH `pnpm test` and the guard print green. A guard with a hole in the same shape as
  the thing it guards against is the strongest argument this branch has produced for the reviewer
  being someone other than the author.

## PAUSED — after Task 14

State: HEAD is 2dad5bb, tree clean. Tasks 1-14 complete and reviewed clean. 4 commits unpushed on
feat/phase-1-foundation (daf7fd7, 2ce6a81, a18c95d, 83ffbbc, 2dad5bb — 5); origin/main and
origin/feat/phase-1-foundation both still at 21746c5 (Tasks 1-13).
Next: Task 15 — the two reusable skills (`sentinel-phase`, `sentinel-verify`).
Task 15 carries one specific inheritance recorded on Task 13: the false-claim class (now ten
instances on this branch, four of them introduced while correcting another one) is the one defect
class no command here can catch, and Task 15's skills work is the place a control for it belongs.
`sentinel-verify` is already specified to be about evidence before assertions; a citation check
belongs in it.
Task 16 owes, at minimum: the clean-clone `pnpm test` fix (a Phase 1 EXIT CRITERION, currently
failing), the dead packages/config/tsconfig/* presets, the client-level `omit` guard, the
check:openapi prose-exemption Minor, Task 10's unreviewed fourth fix round, and the whole-branch
final review.
OWED TO A HUMAN, not to a task: nobody has looked at apps/web in a browser.
PUSHED at user request (after Task 14): verified origin/main was a strict ancestor of HEAD with 0
  commits of its own before pushing — a true fast-forward, nothing on the remote to lose.
  origin/feat/phase-1-foundation 21746c5..2dad5bb and origin/main 21746c5..2dad5bb (5 commits:
  daf7fd7, 2ce6a81, a18c95d, 83ffbbc, 2dad5bb — Task 14 only; Tasks 1-13 were already pushed after
  Task 13). Local `main` ref fast-forwarded to 2dad5bb so it is not left stale. All four refs now
  at 2dad5bb, tree clean.
  Note for the record, as before every push on this branch: main now carries Tasks 1-14, each of
  which has passed its own per-task review but NOT the whole-branch final review the plan schedules
  after Task 16. The user was told this before the Task 12 and Task 13 pushes and asked for it here.
  New with this push: CI will now actually run `.github/workflows/ci.yml` for the first time —
  including the E2E stage, `playwright install --with-deps chromium`, and the format gate, none of
  which has ever executed on a Linux runner. A red first build is a live possibility and would be
  the workflow working, not the branch regressing.
HUMAN VISUAL PASS DONE (2026-08-22): the user ran the dev server and looked at / and /dashboard.
  Verdict: "it looks good but it is too early to judge, and we might change the design later on."
  Recorded in roadmap.md, replacing the "nobody has looked at it" bullet. Deliberately NOT recorded
  as a design sign-off — the debt is closed, the design is not settled, and Phase 2's real screens
  are expected to move it. The distinction matters because the next session would otherwise read
  "human looked, said good" as licence to build on the current type and spacing as decided.
  Still open: no non-Chromium browser has loaded it.

## Task 15 — reusable skills (`sentinel-phase`, `sentinel-verify`)

Task 15: implementer wrote both SKILL.md files plus the `.claude/README.md` and `CLAUDE.md` edits.
  Frontmatter transcribed verbatim from plan lines 5292-5293 / 5326-5327 and later proved
  byte-identical by the reviewer with `diff`, not by eye.
Task 15: review — 0 Critical, 3 Important, 6 Minor. The implementer's report audited CLEAN, the
  first time on this branch: the reviewer re-ran every command rather than trusting printed exit
  codes, and also ran what the implementer had honestly declined to run.
Task 15: I1 — the skill's command table listed the plan's five commands; CI runs ten.
  format:check, check:specs and test:e2e were absent. Ruling: ACCEPT. Why: the plan was written
  before Task 14 added those three gates, and fidelity to a stale plan is the defect, not the fix
  — a session collecting five zeros and pushing can still hand CI a red build, which is precisely
  what the skill's own "CI will catch it" red-flag row exists to prevent. Cost if wrong: a future
  session spends minutes on gates a docs-only change did not need.
Task 15: I2 — the most important finding of the task, because it lands on Task 16. As written,
  a literal follower of §3 would collect five zero exits on a warm tree and write "Implemented"
  over Phase 1, whose exit criterion is "passes from a clean clone" and which roadmap.md ALREADY
  RECORDS AS FAILING. Warm `pnpm test` exits 0 here; clean-clone `pnpm test` does not. Both true
  at once, and the skill could not tell them apart. Ruling: ACCEPT, and fix it GENERALLY — a phase
  claim is covered by that phase's exit criteria as written in roadmap.md, not by §1's default
  list. Deliberately did not hard-code Phase 1 or the current defect, so the rule cannot go stale
  when Task 16 fixes it. Cost if wrong: nothing; the rule only ever narrows what may be claimed.
Task 15: I3 — sentinel-phase step 5 moved the status without invoking sentinel-verify, though
  sentinel-verify's own description says "before moving a status in roadmap.md". ACCEPT, one
  clause. M1 (Docker precondition on test:integration) folded into I1's edit, routed to Blocked
  rather than given an escape hatch. M2-M6 ruled residuals, not fixed — M2 ("specification §79")
  is a dangling referent repo-wide that CLAUDE.md and roadmap.md both already use, so the skill is
  consistent with the tree and §3 lists the vocabulary inline.
Task 15: re-review of the fix round — CLEAN, 0 open, with every quoted diff machine-checked
  against disk rather than eyeballed. It verified the new test:e2e row's claims against the real
  files: the playwright install command is character-identical to ci.yml line 108, and
  "playwright.config.ts builds and starts the web app itself" is true (webServer.command is
  `pnpm build && pnpm start:e2e`). The --passWithNoTests justification checked out against
  vitest.workspace.ts rather than being plausible filler.
Task 15: NEW-1, and the one worth remembering. The fix round left the sentence "Five green rows
  from a warm tree are not a phase" standing in §3 while the SAME round took that table from five
  rows to seven — a document asserting a number untrue of itself, introduced while correcting
  something else, inside the skill written to stop that exact class. Eleventh instance of the
  branch's false-claim class, and the fourth-plus introduced by a correction. Ruling: fix at once
  rather than record as a Minor. Why: it was one line, the file was uncommitted, and shipping a
  self-falsifying sentence inside the anti-false-claim skill would have undercut the control's
  authority more than the sentence was worth. Fixed by DROPPING the count ("a green table") so it
  cannot rot again, not by changing five to seven. Cost if wrong: none.
Task 15: reviewer's own residual, controller-ruled — test:e2e was conditional on "touches
  apps/web" while packages/ui, packages/config and middleware can all reach a rendered page
  without touching apps/web. Broadened the condition rather than making it Always: CI runs it
  unconditionally, but §1 governs what a session runs before making a claim, and an unconditional
  multi-minute browser run on every docs change is a rule sessions would start skipping.
Task 15: STEP 4 NOT DONE, and deliberately not claimed. A fresh subagent probe returned
  `Unknown skill: sentinel-verify` with neither name in its listing. Chased rather than shrugged
  at, because if `.claude/skills/` were the wrong path the fix belonged in THIS task: confirmed
  against Claude Code's docs that the path is correct, that no settings.json / plugin /
  marketplace opt-in is required, that `name` defaults to the directory name (ours match), and
  that the cause is the documented caveat — Claude Code watches only skill directories that
  existed at session start, and `.claude/skills/` did not exist when this session began.
  So: right place, needs one restart. Recorded in roadmap.md as owed, not claimed as done.
Task 15: controller verification (own run, not delegated): lint 0, typecheck 0, format:check 0,
  pnpm test 403 passed / 32 files, check:specs OK (42 spec files), build 8/8, test:integration
  139 passed / 10 files against the live stack (all four compose services healthy).
  Ran build and test:integration on a docs-only change deliberately, for consistency with the
  skill being committed — "It's just a docs change" is one of its own red-flag rows.
Task 15: roadmap.md updated in the same commit (4f3939d) — status paragraph for both skills
  including the honest "neither has been confirmed to load", Tasks 1-15 complete, Task 16 the
  only one remaining, and the discoverability check added to Known outstanding.
Task 15: COMPLETE (commit 4f3939d). One review, one fix round, one re-review, plus two
  controller edits after the re-review closed. 0 Critical, 3 Important, 7 Minor, 0 open.

## PAUSED — after Task 15

State: HEAD is 4f3939d, tree clean. Tasks 1-15 complete and reviewed clean.
2 commits unpushed on feat/phase-1-foundation (df61629, 4f3939d); origin/main and
origin/feat/phase-1-foundation both at 2dad5bb.
STEP 4 CLOSED (commit 9744b6f, after a user-performed restart). Both skills load. Evidence is a
  controlled comparison, not an assertion: the authoring session (started before .claude/skills/
  existed) returns `Unknown skill: sentinel-verify`; the restarted session resolves it and quoted
  the "It's just a docs change" row verbatim, matching SKILL.md line 91. Only the
  watched-at-startup explanation predicts one pass and one fail — a wrong path or bad frontmatter
  would have failed both. Task 15 is complete on all five plan steps.
  Controller note, recorded because it is the branch's own defect class pointed at ME: on the
  first relay I judged the restarted session to have "deflected" and flagged it as a possible
  twelfth false claim. It had not — the user had relayed only the trailing paragraph, and the
  screenshot showed the quote had been produced correctly all along. I asserted a defect in
  someone else's work from a partial artifact, which is the same failure as claiming another
  task's work landed without opening the file. Withdrawn. The rule generalises: sentinel-verify
  §5 says verify work assigned to someone else rather than assuming — it applies equally to
  assuming a FAILURE as to assuming a success.
SUPERSEDED (kept for the record) — FIRST ACTION IN THE NEXT SESSION: confirm `sentinel-verify` and `sentinel-phase` appear in the
  skills listing and that invoking sentinel-verify loads its BODY. That is plan Task 15 Step 4,
  it is the only thing standing between Task 15 and fully done, and a new session is the only
  instrument that can measure it. If they do NOT appear, the skills are misconfigured and that
  is a Task 15 defect, not a Task 16 one.
Next: Task 16 — ADRs (0011 prefixed UUIDv7, 0012 Node 26 pin), documentation, roadmap, and the
  full exit-criteria verification pass. Task 16 owes, at minimum: the clean-clone `pnpm test`
  fix (a Phase 1 EXIT CRITERION, currently failing), the dead packages/config/tsconfig/* presets,
  the client-level `omit` guard, the check:openapi prose-exemption Minor, Task 10's unreviewed
  fourth fix round, and the whole-branch final review.
NOTE FOR TASK 16: it should use sentinel-verify to move Phase 1's status, and I2 above is the
  reason that is not circular — the skill now says a phase claim is covered by the phase's exit
  criteria, so it will force the clean-clone criterion to be satisfied or the status to stay
  Partially Implemented. That is the first real test of whether these skills do anything.
CI: the workflow ran for the first time after the Task 14 push. Its result has not been checked
  in this session.

## CI investigation and push — after Task 15

CI was red on GitHub. Root cause: `pnpm install --frozen-lockfile` failing in 30s with
  ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION on ten entries — next@16.3.2 and its nine @next/swc-*
  binaries — younger than pnpm 11's DEFAULT 24-hour minimum release age. Nothing in the repo sets
  that policy; `pnpm config get minimumReleaseAge` returns undefined. Every run since daf7fd7 died
  there, which is why no Task 14 stage had ever executed.
THE FINDING WORTH KEEPING: pnpm-workspace.yaml carries a comment asserting the removal of the
  minimumReleaseAgeExclude block was verified, because `pnpm install`, `--frozen-lockfile` and
  `--lockfile-only` all succeed locally. Ran it: they do — in 290ms, printing "Already up to
  date". With node_modules in sync pnpm SHORT-CIRCUITS and never runs the supply-chain check at
  all; CI starts from an empty node_modules and verifies all 885 entries. The local verification
  was structurally incapable of detecting the failure it claimed to rule out. Twelfth instance of
  the branch's false-claim class and the FIRST one that actually shipped and broke something —
  every prior instance was caught by review before it could.
  It is also an unplanned live demonstration of sentinel-verify §3's phase-status rule, committed
  the day before: a warm tree does not prove a clean-clone claim.
Ruling: do not "fix" it, time the push instead. Why: next@16.3.2 published 2026-08-21T09:38:38Z,
  so the 24h window closed 2026-08-22T09:38:38Z; pushing before that would have produced a fourth
  identical red run and taught nothing, and any code change would have been a change made to work
  around a clock. Waited 270s, pushed at 09:39:10Z. Cost if wrong: five minutes.
  THE CAUSE IS NOT FIXED — the next dependency added within a day of publication reproduces it,
  and the misleading comment still stands. Owed to Task 16 as a real policy decision: pin, adopt
  cooldown-waiting as policy, or set minimumReleaseAge explicitly rather than inherit a default.
SECOND FALSE CLAIM FOUND, in roadmap.md itself: "The CI workflow has never run … nothing has run
  on a Linux runner." False when written — ci.yml has existed since 12831ef and ran green on
  ubuntu-latest on 2026-08-20 and 2026-08-21 (gh run list). True claim was narrower: the stages
  Task 14 ADDED had never run, because every run since died at install. Thirteenth instance.
  Found by reading the Actions history instead of reasoning about it.
CI NOW GREEN, first time end to end on Linux: run 32565519240, ubuntu-latest, 4m22s, and the
  main-branch twin 32565520775 at 4m55s. Every Task 14 stage executed and passed — format:check,
  check:specs, check:openapi, check:registry, compose stack on the runner, integration against
  it, playwright install --with-deps chromium (Linux system packages install cleanly), 5 E2E
  tests in 10.4s. The 30-minute timeout covers the sequence with large margin.
  NOT claimed: the two failure-only steps were skipped, so the Playwright artefact-upload path is
  still unexercised; and checkout/setup-node/action-setup target deprecated Node 20 and are being
  forced onto Node 24 — harmless today, a pin bump for Task 16.
PUSHED (user request, "check CI first then push"): verified origin/main was a strict ancestor with
  0 commits of its own before each push. 2dad5bb..486fc34 then 486fc34..c081e9f, both refs, local
  main fast-forwarded. All four refs at c081e9f, tree clean.
  main now carries Tasks 1-15, each per-task reviewed but NOT whole-branch reviewed.

## PAUSED — after Task 15 + CI

State: HEAD c081e9f, tree clean, all four refs level, CI green on both branches.
Next: Task 16 — the last of Phase 1. ADR-0011 (prefixed UUIDv7), ADR-0012 (Node 26 pin), the
  documentation pass, roadmap, and the full exit-criteria verification.
Task 16 owes, at minimum: the clean-clone `pnpm test` fix (a Phase 1 EXIT CRITERION, still
  failing); the minimumReleaseAge policy decision and the false comment in pnpm-workspace.yaml;
  the dead packages/config/tsconfig/* presets; the client-level `omit` guard; the check:openapi
  prose-exemption Minor; the Node 20 action pins; Task 10's unreviewed fourth fix round; and the
  whole-branch final review.
NOTE: Task 16 is the first real test of the skills. sentinel-verify §3 should force it to satisfy
  "passes from a clean clone" or leave Phase 1 at Partially Implemented. Two of this session's
  findings (the pnpm cooldown, the CI history) were warm-tree/assumption failures of exactly the
  kind it exists to catch, so the rule now has three worked examples behind it.

## Post-Task-15: skills made a standing instruction (97cedb0)

Ruling: convert CLAUDE.md's mention of the two skills into a standing instruction, and widen it
  from "phase" to "phase or numbered task". Why: sentinel-phase's description triggers on "a
  numbered Sentinel build phase" while the next unit of work is Task 16 — a numbered TASK — and
  the whole control chain hangs on that one skill firing, because sentinel-verify's trigger
  ("before claiming work is complete") is a moment in reasoning that a user never types and is
  reached through sentinel-phase steps 2 and 5. CLAUDE.md loads every session regardless of
  phrasing, so this makes deterministic what was probabilistic. Cost if wrong: a session invokes
  sentinel-phase for a task too small to need it and spends a minute reading a checklist.
Added the clause that matters most: skills are discovered only in directories that existed at
  session start, so a session can silently lack both and never know. CLAUDE.md now tells it to
  SAY SO rather than proceed. This session is the worked example — it wrote both skills and
  cannot load either.
Deliberately NOT done: widening sentinel-phase's frontmatter description to include "task". The
  deterministic CLAUDE.md path makes it unnecessary, and the review verified both descriptions
  byte-identical to plan lines 5292-5293 / 5326-5327. Recorded here so Task 16's whole-branch
  review sees a ruling rather than an unexplained divergence — and so it can revisit if
  auto-triggering turns out to matter.
State: HEAD 97cedb0, tree clean, all four refs level, CI green.
