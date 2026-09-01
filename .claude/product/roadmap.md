# Roadmap and current status

**This is the authoritative answer to "what actually works?"** Every other document
describes design. This one describes reality. It is updated at the end of every phase, and
a status is only raised after the functionality has been run and verified — not after the
code was written.

Status vocabulary (specification §79): **Implemented** / **Partially Implemented** /
**Not Implemented** / **Blocked**.

## Current state — 2026-08-26

| Phase | Scope | Status |
|---|---|---|
| **0** | Repository audit, architecture, documentation foundation | **Implemented** |
| 1 | Production foundation | **Implemented** — all four exit criteria proven 2026-08-22, re-proven 2026-08-24 |
| 2 | Identity | **Not Implemented** — Tasks 1–10 of 18 done 2026-08-31 (schema, migrations, registry, wire contracts, password hashing, the breach check, single-use secret tokens, the mailer with nine templates, the session service, the authentication stage with CSRF and CORS, registration with email verification, login/logout/session with per-account lockout, and password reset and change); the API publishes **13 routes** and a person can register, confirm an address, sign in, read their own session, change or reset a password and sign out, but **nothing authorises anybody** — `GET /auth/session` returns an empty permission set until Task 12, and there is no screen until Task 16 |
| 3 | SaaS core | **Not Implemented** |
| 4 | Execution platform | **Not Implemented** |
| 5 | Web security engine | **Not Implemented** |
| 6 | API security engine | **Not Implemented** |
| 7 | Pentest workspace | **Not Implemented** |
| 8 | Reports | **Not Implemented** |
| 9 | Integrations | **Not Implemented** |
| 10 | Billing | **Not Implemented** |
| 11 | Enterprise | **Not Implemented** |
| 12 | Additional engines | **Not Implemented** |

**Five Phase 1 packages and the API skeleton exist and are verified working**, per the
honesty rule in `CLAUDE.md` (run and verified, not just written): `packages/config` (validated
env loading), `packages/observability` (structured logging with redaction),
`packages/contracts` (error envelope, pagination, IDs, permission matrix), `packages/storage`
(S3-compatible adapter with mandatory tenant key prefixes), and `packages/db` (Prisma schema,
migrations, the mandatory tenant-scoped client, and PostgreSQL row-level security — the
two-layer tenant isolation control the whole roadmap depends on, covered by 40+ integration
tests and 20+ unit tests against a real Postgres 16).

**`packages/contracts` has since grown past that list.** Phase 2 Task 2 added the identity wire
contracts — authentication, organisation, membership, role and invitation schemas, the `Principal`
union and `TenantContext` — described under Phase 2 below. They are schemas and types only: **no
endpoint validates against any of them yet.**

**`apps/api` now boots.** A NestJS application with the request-ID middleware, the
security-header and CSP middleware, the global error-envelope filter, the structured logging
interceptor, the Zod validation pipe, the `@Public()`/`@RequirePermission()` access
decorators, and a `health` module answering `/health/live`, `/health/ready` and
`/health/detailed` against the live Postgres, Redis and MinIO stack. It has **no
authentication and no business endpoint**: the only routes are the health probes and the
OpenAPI document.

**`packages/ui` exists — tokens and eight primitives.** The full
token set from `ui-ux/design-system.md` (the cool-ink neutral ramp, the five-step severity ramp,
status and intent, the 1.2 type scale, the three density modes, the motion durations), with light
on bare `:root` and dark redefined under both the `prefers-color-scheme` media query and
`[data-theme="dark"]`, plus `Button`, `Input`, `Label`, `Field`, `Card`, `Alert`, `Badge` and
`Skeleton`. A test asserts the two dark blocks declare identical token sets and that no token
exists in only one theme. `Field` ties label, description and error to its control with
`aria-describedby` and `aria-invalid`, merging rather than overwriting what the child already
declares. The no-raw-hex lint rule that `design-system.md` §7 had claimed for months **now
actually exists** and is proven to fire.

Two things this deliberately does not do, because saying so is the point of this section:
`packages/ui` **runs no Tailwind build of its own** — tokens are referenced through
arbitrary-value utilities (`bg-[var(--color-surface)]`), and named utilities like `bg-surface`
do not resolve because no `@theme` block is shipped. Task 13's `apps/web` is what runs the
Tailwind build that emits those utilities, and it needs an explicit
`@source '../../../packages/ui/src'` to do it: measured, with that line removed the emitted
stylesheet was missing every utility that appears only inside `packages/ui`. **A browser has
now rendered three of the eight primitives** (Card, Alert, Badge) on the marketing page.
Button, Input, Label, Field and Skeleton are still exercised only by jsdom unit tests — no
browser has ever painted them.

The boot-time assertion that every route declares its access is now built: a route declaring
neither `@Public()` nor `@RequirePermission()` refuses startup with an error naming every
offender, and the inventory it checks is cross-checked against Express's own router on each
boot so it cannot pass by inspecting nothing. `@Public()` is therefore load-bearing today.
**`@RequirePermission()` is still metadata no guard *enforces*** — the authorization guard
is Task 12 — so declaring a permission records an intention, it does not enforce one. As
of Task 7 three things do *read* that metadata key: the authentication guard, the route
inventory and the OpenAPI generator. The earlier wording, "metadata no guard reads", was
literally false, and the distinction is the one Task 6 had to make about `PENDING_MFA`
being recorded but unenforced.

The OpenAPI document is generated from the route inventory and the Zod contracts, served at
`/api/v1/openapi.json`, and committed as `apps/api/openapi.json`; a test asserts the committed
file is byte-identical to what the code generates. `pnpm check:openapi` now enforces the same
thing in CI's cheap lane, without Postgres.

Rate limiting is built and globally registered — a Redis sliding window over the table in
`security/abuse-prevention.md` §1. **Through Task 7 it limited nothing, because no route carried
a class; since Task 8 it governs three.** `registration` on `POST /api/v1/auth/register`,
`emailVerificationConsume` on `POST /api/v1/auth/verify-email` and `emailVerificationResend` on
`POST /api/v1/auth/resend-verification`, all three fail-closed and all three per-IP-resolvable on
an unauthenticated request — measured live at `200,200,200,429,429` against the real application.
Liveness stays deliberately exempt so that it depends on no backing service. **Every other class
in the table still governs nothing**, and the per-principal half of `generalSession` remains
unresolvable because the limiter runs before authentication by design, with nothing reporting
that at the default log level.

**`apps/web` now renders in a browser — two pages, neither of them a product.** A Next.js
16 App Router shell with the three route groups from `architecture/frontend.md` §1:
`(marketing)` serving `/`, `(app)` serving a `/dashboard` placeholder that states the product
is not built and names the phase, and `(auth)` holding a layout with no routes under it at
all. IBM Plex Sans, Sans Condensed and Mono are self-hosted through `next/font` (verified: the
built CSS references `/_next/static/media/*.woff2` and contains zero references to any Google
font host, which is what makes `font-src 'self'` true rather than aspirational). Every
response leaves `proxy.ts` carrying the `security/transport-and-headers.md` §2 header table
and a fresh per-request CSP nonce, with `/api/csp-report` collecting violations into the
redacting logger from day one. TanStack Query and an appearance (theme/density) context are
wired; nothing queries anything, because there is no API call to make.

Three things this deliberately does not do. **There is no mock product UI** — no fake metric
tiles, no seeded findings table. **Nothing has been design-reviewed**: a human has now loaded
both pages in a browser (see the last bullet under Known outstanding) and called them acceptable
but too early to judge, which is not a sign-off. The mechanical coverage is Playwright (renders
in both colour schemes, no console errors, no horizontal overflow at 375px) plus assertions on
returned HTML and headers, and none of that says whether the typography and spacing are any
good. And **every HTML route is `force-dynamic`**,
including marketing, which contradicts `architecture/frontend.md` §2 — a deliberate trade
explained in a new subsection there: Next can only nonce its inline bootstrap scripts for a
page rendered against a real request, so a prerendered page under this CSP ships as dead
HTML.

**CI now has three mechanical checks, and all of them have been watched failing.** `check:registry`
reads the Prisma DMMF and enforces four rules over the tenant registry: a model carrying
`organizationId` that is not registered, a registered model that has lost the column or vanished,
any model not accounted for by exactly one of tenant-owned / tenant-root / deliberately-global, and
any `ON DELETE CASCADE` into a tenant-owned table from a parent that is not itself tenant-scoped —
the exact shape of the defect Task 6 found live on `Membership.userId`, where deleting a `User`
destroyed other organisations' rows. It refuses to answer from a generated client older than
`schema.prisma`, because it was caught doing exactly that: a review reintroduced the Task 6 cascade
defect, did not regenerate, and watched the check print OK. `check:openapi` fails on drift between
the committed document and what the contracts generate. `check:specs` requires every spec file to
be claimed by exactly one Vitest project and **bans the `*.test.*` spelling** — every project
overrides Vitest's default `include` with `.spec.` patterns only, so a `.test.ts` file executes
nothing while `pnpm test` prints green, which a review proved with a file asserting `1 === 2`.

CI also gained an end-to-end stage, a `format:check` gate (green for the first time — it had failed
on 11 files since the repository was created), and `eslint-plugin-react-hooks`. **The whole
pipeline is now green on a Linux runner** — run `32565519240` on `ubuntu-latest`, 4m22s, with every
stage executing: format, lint, typecheck, unit, `check:specs`, the compose stack, integration,
build, `check:openapi`, `check:registry`, `playwright install --with-deps chromium`, and 5 E2E
tests. That took three red runs to reach, all of them dying at `pnpm install` on a supply-chain
policy rather than on anything this repository had written; see Known outstanding, because the
cause is not fixed.

**Two project skills now encode the two rules this build keeps having to relearn.**
`.claude/skills/sentinel-verify/` turns the honesty rule into a runnable gate — it lists the ten
commands CI actually runs, refuses a row for a command that was not run, and refuses
**Implemented** without a zero exit behind every command covering the claim. It carries one
control no command can enforce: a citation rule for the false-claim class this branch had
produced ten instances of by Task 14 — a report or document asserting something untrue, four of
them introduced *while correcting an earlier one*. Task 15's own re-review then caught an
eleventh, inside the skill written to stop it: the sentence "five green rows from a warm tree are
not a phase" was left standing after the same fix round took that table from five rows to seven.
Corrected before commit. `.claude/skills/sentinel-phase/` encodes
`development/resuming-work.md` as an ordered checklist, including the two rules that make the
protocol work: verify a claimed status by running it before building on it, and update this file
in the same change that moves the status.

**Both have been confirmed to load** (2026-08-22). Proved by controlled comparison rather than by
inspection: the session that wrote them — started before `.claude/skills/` existed — returns
`Unknown skill: sentinel-verify`, while a session restarted afterwards resolves it and quoted a
row from the middle of the file verbatim. That is the documented behaviour (Claude Code watches
only the skill directories present at startup), and it rules out the alternative explanation: a
wrong path, a missing opt-in or bad frontmatter would have failed in **both** sessions. The
quote is what closes it — a name resolving proves registration, a line from deep in the body
proves the body loaded.

**Task 16 closed the two defects the previous tasks had deferred, and both were the same defect
in different clothes: a gate whose correctness depended on ambient machine state.**

The first was Phase 1's own exit criterion. `pnpm test` failed from a clean clone — root `test`
was a bare `vitest run`, not a turbo task, so nothing built the workspace packages that specs
import by name. `lint` and `typecheck` survived only because they *are* turbo tasks with
`dependsOn: ["^build"]` and happened to run earlier in CI. Fixed by a `build:packages` script
(`turbo run build --filter=./packages/*`) that `test`, `test:integration`, `check:openapi` and
`check:registry` now run first. Measured, not assumed: from a cold tree the old scripts failed
**10** spec files — not the 7 this file previously recorded, which came from moving only
`packages/contracts/dist` aside — and the new ones pass 32 files / 403 tests in 8.8s cold. The
warm cost of the added step is what matters for everyday use, and it is a turbo cache hit:
`pnpm build:packages` alone returns in **0.6s** (`Time: 24ms >>> FULL TURBO` inside it), against
`pnpm test` end to end at **~5.5s**. `check:specs` was audited and deliberately left alone: it reads
`vitest.workspace.ts` and the filesystem only, and already passed cold.

The second was the supply-chain cooldown. `minimumReleaseAge` is now **declared explicitly at
1440 minutes** in `pnpm-workspace.yaml` and recorded in
[ADR-0013](../decisions/ADR-0013-dependency-release-age-cooldown.md), where before it was pnpm's
default that nobody had chosen. The value changes no behaviour today; writing it down is the
change. The old comment in that file claimed the removal of `minimumReleaseAgeExclude` had been
"verified" because three install commands succeeded locally — that verification was worthless and
the file now says so, because a warm `node_modules` makes pnpm print "Already up to date" in
277ms without ever running the release-age check. Also corrected: **four** CI runs died on this,
not three — commits `21746c5` and `2dad5bb` each fired a run on `main` *and* on the feature
branch, so two of the failing runs are in `main`'s own history.

Three ADRs were written for decisions that had been made in code and never recorded: **0011**
prefixed UUIDv7 identifiers, **0012** the Node 26 pin with an explicit revisit trigger, **0013**
the cooldown. `repository-audit.md` gained a dated **addendum rather than an edit** — §1–§6 still
say what was true on 2026-08-20, which is the only thing an audit is for.

**Phase 1 is Implemented as of 2026-08-22: all four of its exit criteria have been run and
passed.** The last one to fall was "CI is green". Task 16 bumped four GitHub Actions majors
(`checkout@v7`, `setup-node@v7`, `upload-artifact@v7`, `pnpm/action-setup@v6`) off the deprecated
Node 20 runtime, and for one commit that made the criterion *unproven* — the pins had been read,
not run, and this file refused to call that green. Run **`32579100605`** (commit `5aab4b5`,
`ubuntu-latest`, **3m00s**) settled it: conclusion `success`, all four new action majors
executing, every stage passing — format, lint, typecheck, unit, `check:specs`, the compose stack,
integration, build, `check:openapi`, `check:registry`, Playwright install, and 5 E2E tests. The
Node 20 deprecation annotations that prompted the bump are gone; the only annotation left is the
Playwright pass notice. The run is also 1m22s faster than `32565519240`.

Two things that remain unexercised, so they are not claimed: the two failure-only steps ("Stack
logs on failure", "Upload Playwright artefacts on failure") were correctly skipped because
nothing failed, so the artefact-upload path still has never run.

**What Implemented means here, and what it does not.** It means Phase 1's exit criteria are met:
the workspace builds and tests from a clean clone, the stack starts, migrations apply, and CI is
green. It does **not** mean this is a product. Nothing is deployed, and no request reaches this
code from outside a test or a developer's own machine. Nothing in this product runs, scans,
stores, bills, or authenticates for an actual user today. Phase 1 built the floor, and the floor
is finished and verified.

### Blocked items

| Item | Blocker | Owner |
|---|---|---|
| Terraform IaC execution | **Terraform not installed**; Phase 11 anyway | Operator |

**Go worker engines left this table on 2026-08-22 — they are deferred, not blocked, and the
difference is the point.** The row read "Go toolchain not installed" from Phase 0 until Task 16
checked instead of assuming: `go version` reports **go1.27.0 windows/amd64** from
`/c/Program Files/Go/bin/go`, confirmed by compiling and running a program rather than by the
version string alone. The obstacle is gone. The deferral stands anyway, because
[ADR-0010](../decisions/ADR-0010-engine-contract.md) makes engine language a per-engine choice
over a JSON-on-stdio contract and the first-party engines are naturally TypeScript. Nothing has
moved in Phase 4 or Phase 12: `git ls-files '*.go'` returns nothing and there is no `go.mod`. An
installed toolchain is not a Go worker.

## Phase detail and exit criteria

A phase is complete only when its exit criteria are demonstrably met.

### Phase 1 — Production foundation
pnpm + Turborepo monorepo; TypeScript strict; ESLint/Prettier; `packages/config` with
validated env; structured logging with redaction; `packages/db` with Prisma and the
tenant-scoped client; Docker Compose (Postgres, Redis, MinIO, Mailpit); storage adapter;
rate limiting; security headers and CSP; base design system; GitHub Actions running
install → lint → typecheck → test → build; `.env.example`.

*Exit:* `pnpm install && pnpm build && pnpm test` passes from a clean clone; the compose
stack starts; a migration applies; CI is green.

*Verified 2026-08-22 (Task 16).* Every row below is a command that was run, with its real exit
code. **Criterion 1 was satisfied as written — from a genuine clean clone**, not a warm tree:
`git clone` into a scratch directory with no `node_modules`, no `dist` and no `.turbo`, with this
commit's changes applied.

| Command | Exit | Tree | What it proves — and no more |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | clean clone | The lockfile resolves from cold in 1m32s under the new 1440-minute cooldown. |
| `pnpm build` | 0 | clean clone | 8 packages build from cold, 0 cached, 13.1s. |
| `pnpm test` | 0 | clean clone | 32 files / 403 tests. **Exit criterion 1 met.** |
| `pnpm test` | 0 | clean clone, `dist` + `.turbo` deleted again | The topology fix is real: no prior `build` step, still green. |
| `pnpm format:check` | 0 | warm | Prettier clean across the tree. |
| `pnpm lint` | 0 | warm | ESLint clean, 14 tasks. |
| `pnpm typecheck` | 0 | warm | Types compile. Says nothing about behaviour. |
| `pnpm check:specs` | 0 | warm | 42 spec files, each claimed by exactly one project; no banned `.test.*`. |
| `pnpm check:openapi` | 0 | warm | `apps/api/openapi.json` is byte-identical to what the contracts generate. |
| `pnpm check:registry` | 0 | warm | 10 models: 3 tenant-owned, 1 tenant root, 6 deliberately global, DMMF checked against `schema.prisma`. |
| `pnpm test:integration` | 0 | warm + stack | 10 files / 139 tests against real Postgres, Redis and MinIO. |
| `pnpm test:e2e` | 0 | warm | 5 passed against a Playwright-owned production build. |
| `docker compose ps` | 0 | — | postgres, redis, minio, mailpit all `Up (healthy)`. **Exit criterion 2 met.** |
| `prisma migrate deploy` | 0 | **empty database** | All 4 migrations apply to a freshly created database, producing 10 tables. **Exit criterion 3 met.** |
| `pnpm db:seed` ×2 | 0, 0 | warm | Byte-identical output twice — 7 roles, 49 permissions, 190 grants, no tenant data. Idempotent. |

**Exit criterion 4 — "CI is green" — met by run `32579100605`** on commit `5aab4b5`,
`ubuntu-latest`, 3m00s, conclusion `success`, every stage executed. That run is also the proof
for the four bumped action majors, which until it existed had only been read.

All four criteria are therefore met, which is what moves Phase 1 to **Implemented**. Note what
the table does and does not license: it proves the phase's exit criteria, not that any feature
works for a user. There are no features.

*Deliberately deferred, with the phase that picks it up:* workers, scheduler and engine SDKs
(Phase 4); production Dockerfiles and container scanning (Phase 11); the full E2E journey suite
(Phase 2, when journeys exist — 5 smoke specs run today); authentication, authorization
enforcement and entitlements (Phase 2 — the pipeline slots and the boot-time route-access
assertion exist and are empty); CWE, OWASP, plan and engine seed data (the phases that create
those tables).

#### Where Phase 1 stopped — read this before resuming

Phase 1 is being executed as 16 tasks from
`docs/superpowers/plans/2026-08-20-phase-1-foundation.md`, subagent-driven: a fresh implementer
per task, then a separate adversarial reviewer, then scoped re-reviews per fix round.

**All 16 tasks are complete.** Task 16 was implemented, and its every factual claim re-verified
by the orchestrator against the repository rather than taken from the implementer's report — the
Go finding below is what that caught. 1 workspace and CI · 2
`packages/config` · 3 `packages/observability` · 4 compose stack, schema, prefixed UUIDv7 IDs,
first migration · 5 `packages/contracts` · 6 tenant-scoped Prisma client and RLS · 7 seed · 8
`packages/storage` · 9 `apps/api` bootstrap · 10 rate limiting · 11 route-access assertion and
OpenAPI · 12 `packages/ui` tokens and primitives · 13 `apps/web` Next.js shell · 14 CI checks ·
15 the two project skills.

**Task 16 delivered:** ADRs 0011–0013, the audit addendum, the `setup.md` correction, the
clean-clone `pnpm test` fix, the explicit release-age cooldown, the CI action-major bump, and the
full exit-criteria verification pass recorded above. **Phase 1 is complete and verified.** The
review of Task 16 found 0 Critical, 4 Important and 6 Minor; all ten were re-verified against the
repository and corrected in `5aab4b5` before the status moved. The Important four were every one
of them a false factual claim in newly written prose — the twelfth instance of that class on this
branch, and the fifth introduced while correcting an earlier one. **The commands were never the
problem; the sentences written about them were.** Next session starts Phase 2.

The execution ledger is
[`docs/superpowers/ledger/phase-1/`](../../docs/superpowers/ledger/phase-1/). `progress.md` is the
file to read first.

**Two corrections to what this paragraph used to say, both found by auditing the directory on
2026-08-24 rather than by re-reading the sentence.** It located the ledger at
`.superpowers/sdd/2026-08-20-phase-1-foundation/` and called it "gitignored and exists only on the
machine that built it" — true when written, and no longer: all 71 files were moved into the tracked
tree above on 2026-08-24, verified byte-for-byte (2,817,988 bytes both sides), with the flat
`task-N-brief.md` naming reshaped into zero-padded `task-NN/` folders to match Phase 2's. Ledgers
are not gitignored any more, in any phase.

And it claimed the ledger holds "every ruling with its cost if wrong, every review finding, per-task
briefs and reports". It does not. **Only tasks 13, 14 and 15 have a review document** — tasks 1–12
have a brief and a report and nothing else — **and Task 16 left no entry at all**, so `progress.md`
ends at `HEAD 97cedb0`, twelve commits behind. Task 16's *work* is real and verified above with
commands and a CI run ID; only its ledger entry is missing. The discipline decayed after Task 12 and
nothing caught it, because nothing in CI or in review can see an ignored directory. That is the
concrete reason Phase 2's ledger is tracked. Full audit:
[`docs/superpowers/ledger/phase-1/README.md`](../../docs/superpowers/ledger/phase-1/README.md).

Known outstanding. **None of it blocks Phase 1, which is complete.** All of it is owed to a later
phase or to the operator:

- **`rate-limit.integration.spec.ts` is flaky on CI, and it guards a security control.** Proven
  rather than assumed on 2026-08-25: CI run `32805306518` on commit `8214466` failed at
  *"liveness is never rate limited › issues no Redis command at all while probing /health/live"*,
  and a **re-run of that same job on that same SHA passed**. The commit it failed on changed two
  markdown files and no code (`git diff --stat 6d6b582 8214466` — 2 files, 34 insertions), and the
  preceding run on `6d6b582` was green, so nothing in the tree caused it. The failure is not an
  assertion: it is `Error: Command queue state error. If you can reproduce this, please report it`
  raised inside `ioredis@5.11.1`'s own `DataHandler.shiftCommand`, which points at a race between
  the spec's Redis-traffic monitoring connection and the command queue rather than at the rate
  limiter. **This matters more than an ordinary flake.** The Phase 2 plan's own words for the
  timing test — "a flaky security test gets deleted" — describe the risk exactly, and rate
  limiting is one of the controls `security/abuse-prevention.md` §1 depends on. Owed: diagnose the
  monitoring connection's teardown, not a retry wrapper. Nobody has done it.

- ~~The four bumped GitHub Actions majors have never run on a runner.~~ **Closed 2026-08-22 by
  run `32579100605`** — `checkout@v7`, `setup-node@v7`, `upload-artifact@v7` and
  `pnpm/action-setup@v6` all executed successfully on `ubuntu-latest`, and the Node 20
  deprecation annotations are gone. Worth keeping the reasoning: the bump was verified by reading
  each new `action.yml` for its runtime and inputs, the branch was still recorded as
  **Partially Implemented** on the strength of that reading, and only the run moved it. Reading
  an action's contract is a good way to choose a pin and not a way to prove one.
- ~~`pnpm test` fails from a clean clone.~~ **Closed 2026-08-22 by Task 16.** Root `test` now runs
  `build:packages` first; proven green from a genuine clean clone with no prior build (see the
  verification table above). Two corrections to what this bullet used to say: the cold-tree
  failure was **10** spec files, not 7 — the old number came from moving only
  `packages/contracts/dist` aside, so it measured one package's blast radius rather than the
  defect — and `test:integration`, `check:openapi` and `check:registry` had the same latent
  dependency and were fixed with it. The old text's diagnosis was right: a gate whose correctness
  rested on an earlier step's task graph.
- **A local `pnpm test:e2e` silently tests whatever server is already on `WEB_PORT`.** Found
  while running Task 16's verification, and it cost a real detour. `playwright.config.ts` sets
  `reuseExistingServer: process.env['CI'] === undefined`, so locally Playwright attaches to any
  listening server instead of building its own. A `next dev` server left over from the browser
  session earlier that day was still on port 3000 running `APP_ENV=development`, which makes the
  CSP **report-only** — and Chromium logs `The Content Security Policy directive
  'upgrade-insecure-requests' is ignored when delivered in a report-only policy`, which the smoke
  spec correctly counts as a console error. 1 failed, 4 passed. Re-run with the server Playwright
  owns (`APP_ENV=test`, enforcing CSP): 5 passed. **No code was wrong.** But a suite that tests a
  different application depending on what a developer left running is the same failure class as
  the warm-tree blindness above, and it presents as a code defect.

  **Closed 2026-08-23.** The suite now has its own port — `E2E_PORT=3100`, owned in `.env` like
  `WEB_PORT`, selected by an explicit `--e2e-port` flag on the launcher so no shell expansion is
  involved (pnpm on Windows does not perform any). `E2E_PORT` lives on a separate `e2eEnvSchema`
  rather than on `webEnvSchema`, because `apps/web/src/env.ts` parses the latter at module load in
  every environment and a Playwright port on it would be a variable production must define in
  order to boot. Proven with the offending `next dev` still holding port 3000: the command that
  gave 1 failed / 4 passed gave 5 passed, no CI flag, no workaround. The smoke spec also now
  refuses a report-only policy outright, naming server reuse as the likely cause.

  **And `reuseExistingServer` is now `false` everywhere, which was not the original plan.** It was
  kept on the stated grounds that consecutive local runs should not pay for a rebuild. Review
  asked for that number and it did not exist: Playwright tears down the server it spawns, so
  back-to-back `pnpm test:e2e` runs each rebuild regardless — both printed `next build`, nothing
  was left listening afterwards, 9.146s then 9.179s. The only server the flag could still adopt
  was a hand-started `pnpm start:e2e` serving whenever-old code, which is precisely the stale-code
  **false green** the guard assertion cannot detect. A benefit that does not exist, guarding a
  hazard that does; removed for nothing.

  Fixed with it: both `apps/web/src/security-headers.ts` and
  `apps/api/.../security-headers.middleware.ts` emitted `upgrade-insecure-requests` in report-only
  mode, where the W3C *Upgrade Insecure Requests* specification says it is ignored — harmless to
  protection, but it put a permanent CSP console error in every local dev session, which is how a
  team learns to ignore CSP errors. Now enforcing-only in both, with specs asserting the two
  policies differ by exactly that directive and nothing else.
- **`packages/db/src/id.ts`'s own docstring example is not a valid ID.**
  `org_01J8XK2P9V3QWERTYUIOPASDF` has a 25-character body where a real one has 26, and contains
  `U`, `I` and `O` — all excluded from the Crockford alphabet the file itself defines — so
  `parseIdPrefix()` returns `undefined` for it. The same invalid string appears in the Phase 1
  plan. Found by Task 16 while writing ADR-0011, which uses a generated ID instead. Left unfixed
  only because it is a code change outside Task 16's scope — **ADR-0011 is deliberately worded so
  that fixing it does not disturb the ADR.** A one-line docstring correction closes this.

  **Closed 2026-08-25 by Phase 2 Task 1.** The docstring now shows a real generated ID, and
  `id.spec.ts` reads `id.ts`'s own source and parses every backticked example in it — so the
  assertion cannot drift from the thing it documents, which a copied string in the spec would have.
  The invalid string still appears in the Phase 1 plan, which is a dated historical document and is
  left as written.
- ~~**The local development database needs `pnpm db:reset`, and only the operator can run it.**~~
  Phase 2 Task 1 corrected a comment inside migration
  `20260824153519_membership_partial_unique` *after* it had been applied, which changed its
  checksum, so `pnpm db:migrate` refused against the developer database until it was reset.
  **Nothing else depended on it**: measured on Prisma 6.19.3, `migrate deploy` does not verify
  checksums and exits 0, so CI, Testcontainers and any fresh clone replay all six migrations from
  empty and were unaffected. The reason it was the operator's: Prisma 6.19.3 refuses
  `migrate reset` when it detects an AI agent and demands
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to the literal text of the user's consenting
  message, explicitly excluding earlier messages. **An agent must never fabricate that string** —
  that part is permanent, not closed.

  **Closed 2026-08-25.** The operator consented explicitly and the reset ran: six migrations applied
  from empty, `_prisma_migrations` at six rows with matching checksums, and `pnpm db:migrate` now
  exits 0 reporting *"Already in sync, no schema change or pending migration was found"* — which is
  independently a **fourth** confirmation that Prisma sees neither the partial index nor the CHECK
  constraint as drift, since this is precisely where it would have offered to "fix" them.

  Two things learned that outlive the bullet. **`prisma migrate reset` does not run the seed here** —
  there is no `prisma.seed` hook in `package.json`, only the root `db:seed` script — so a reset
  leaves the database with zero roles and zero permissions until `pnpm db:seed` is run separately.
  It is a two-command operation, and the reset output gives no hint of the missing half. And the
  problem existed at all only because a comment inside an already-applied migration was corrected in
  place: an applied migration's text is effectively immutable, so the cheaper habit is to get it
  right at the gate, before it is applied.

- **Nothing in CI guards the partial index or the CHECK constraint on `Membership`.** Neither is
  expressible in `schema.prisma`, so Prisma cannot see them in either direction — it will not drop
  them, but it also cannot notice their absence. The two real ways to lose them both need a human:
  `prisma db push`, which builds from `schema.prisma` alone and never replays migration history, and
  someone "restoring" the `@@unique` line that is missing on purpose. Today the only defences are a
  schema comment and `packages/db/src/membership-soft-delete.integration.spec.ts` going red.
  The operator approved adding a cheap-lane CI check on 2026-08-24; it is not built.
- **Self-serve account deletion has no design and is not in Phase 2's eighteen tasks.**
  `Membership.userId` and `Invitation.invitedByUserId` are both `onDelete: Restrict`, so any user
  who has ever joined an organisation or sent an invitation cannot be removed by a plain `DELETE` —
  it raises a foreign-key violation. A Phase 1 comment claiming account deletion was "a legitimate
  Phase 2 flow" was corrected in Task 1 when it was checked. `DELETE` on `User` remains granted to
  `sentinel_app`, so the path stays open for whoever designs it.
- **An abandoned MFA enrolment will permanently block re-enrolment.** `MfaFactor`'s
  `@@unique([userId, type])` counts rows with `confirmedAt = NULL`, which the model's own comment
  correctly says are *not* enrolled — so a user who starts TOTP setup and closes the tab gets P2002
  forever. **Task 11 must upsert or delete-then-create.** Found by the Task 1 adversarial review.
- **`VerificationToken` has no index on `expiresAt`.** `Session` got `@@index([absoluteExpiresAt])`
  explicitly so expired rows can be swept across all users; the same sweep will want the token
  tables, and `VerificationToken` is the higher-churn of the two. A "no unbounded queries" concern
  rather than a correctness one.
- **CI's supply-chain policy will red the build again, and time was the only fix last time.**
  On commits `21746c5` and `2dad5bb` — the two pushes between `6d97bb5` and `486fc34` that
  triggered runs at all — every run died in 30 seconds at
  `pnpm install --frozen-lockfile` with
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`: ten lockfile entries — `next@16.3.2` and its nine
  `@next/swc-*` platform binaries — are younger than pnpm 11's **default 24-hour** minimum
  release age. Nothing in this repository sets that policy; it is a pnpm default, and the run's
  cutoff is exactly 24h before the run itself.

  **Why it passes here and fails there, which is the part worth keeping.** `pnpm-workspace.yaml`
  carries a comment stating the removal of the `minimumReleaseAgeExclude` block was verified
  because `pnpm install`, `pnpm install --frozen-lockfile` and `pnpm install --lockfile-only` all
  succeed locally. They do — and the verification is worthless. With `node_modules` already in
  sync, pnpm prints "Already up to date" in ~290ms and **never runs the supply-chain check at
  all**; CI starts from an empty `node_modules` and performs the full 885-entry verification pass.
  A warm tree cannot see this class of failure. That is the same defect as the clean-clone
  `pnpm test` item above, and it is exactly what `sentinel-verify` §3's phase-status rule was
  written for.

  **It self-healed for these ten entries, and that is the whole point.** `next@16.3.2` was
  published 2026-08-21T09:38:38Z; the `486fc34` push was deliberately timed after
  2026-08-22T09:38:38Z and the run went green. **No change was made to fix it — the fix was the
  passage of 24 hours**, so the green run is not evidence that anything is solved. The next
  dependency added within a day of its publication reproduces it exactly, and the misleading
  comment still stands in `pnpm-workspace.yaml`. **Owed to Task 16**, which should correct that
  comment and decide the policy deliberately — pin, adopt cooldown-waiting as policy, or set
  `minimumReleaseAge` explicitly rather than inheriting a default nobody chose.

  **Decided and closed 2026-08-22 by Task 16**, the operator choosing explicit declaration over
  the alternatives. `minimumReleaseAge: 1440` now sits in `pnpm-workspace.yaml` with
  [ADR-0013](../decisions/ADR-0013-dependency-release-age-cooldown.md) behind it, and the
  worthless verification comment has been rewritten to say why it was worthless. **The behaviour
  is unchanged and the trap is not removed** — 1440 is pnpm's own default, so a dependency added
  within 24 hours of its publication still reds CI until it ages out. That is the control working.
  The response is to wait or pin the previous release, never to accept a
  `minimumReleaseAgeExclude`. Two corrections to the text above: it was **four** red runs, not
  three (commits `21746c5` and `2dad5bb` each fired on `main` and on the feature branch — runs
  `32546337142`, `32546354121`, `32561019222`, `32561020627`), and two of those ran on `main`, so
  commits that failed CI are in `main`'s history. The margin on the green run was **55 seconds**.
  Separately: two sources disagree on `next@16.3.2`'s publish minute — pnpm's CI-side lockfile
  verification says `09:38:38Z`, `npm view` says `09:54:02Z`. Both are recorded in
  `pnpm-workspace.yaml`; nothing depends on which is right, and the load-bearing figure above is
  the pnpm one.
- ~~The CI workflow has never run.~~ **Closed 2026-08-22 — the full pipeline is green on a Linux
  runner** (run `32565519240`, commit `486fc34`, `ubuntu-latest`, **4m22s**). Every stage Task 14
  added executed for the first time and passed: the `format:check` gate, `check:specs`,
  `check:openapi`, `check:registry`, the compose stack started on the runner, integration tests
  against it, `playwright install --with-deps chromium` (the Linux system packages install
  cleanly), and the E2E stage — 5 passed in 10.4s. The 30-minute job timeout question is answered
  with room to spare: 4m22s for install → format → lint → typecheck → unit → checks → stack →
  integration → build → Playwright install → a second Next build.

  Two things this does **not** cover, so they are not claimed: the two failure-only steps ("Stack
  logs on failure", "Upload Playwright artefacts on failure") were correctly skipped because
  nothing failed, so the artefact-upload path remains unexercised; and the runner warns that
  `actions/checkout@v4`, `actions/setup-node@v4` and `pnpm/action-setup@v4` target the deprecated
  Node 20 and are being forced onto Node 24. Harmless today, a pin worth bumping in Task 16.
  **Bumped 2026-08-22; not yet run — see the first bullet in this list.**
- **CI now gates `main` — but only while the repository is public, and that is the catch.**
  Task 16 found that audit §4's risk 4 could not be closed: `gh api
  repos/…/branches/main/protection` and `…/rulesets` both returned **HTTP 403, "Upgrade to GitHub
  Pro or make this repository public to enable this feature."** On 2026-08-23 the operator made
  the repository public and protection was configured on `main`:

  | Setting | Value |
  |---|---|
  | Required status check | `verify` (the CI job) |
  | Require branch up to date before merging | yes |
  | **Include administrators** | **yes** |
  | Force pushes / deletions | blocked |
  | Linear history / conversation resolution | required |

  **`enforce_admins` is the setting that matters here and it was initially set wrong.** It was
  first configured `false` to leave the owner an escape hatch — which, in a repository where the
  owner is the only person who pushes, would have made the whole control decorative against the
  exact risk it was meant to address. Corrected to `true` the same session. The escape hatch is
  still there: the owner can disable protection deliberately, which is a logged act rather than
  an accident, and that difference is the entire point.

  **Two things are not proven and are not claimed.** `git push --dry-run` does *not* evaluate
  server-side branch protection — it reports what the client would send — so it cannot be used as
  evidence either way, and a reading of it briefly was. What is established is the authoritative
  API state above plus `branches/main` reporting `protected: true`. Watching a red commit be
  *rejected* has not happened; the first PR into `main` is what demonstrates it end to end.

  **And the load-bearing caveat: this protection dies if the repository goes back to private.**
  The 403 above is the evidence — on this plan, private repositories cannot carry branch
  protection. Flipping visibility back **silently removes the gate**, and nothing will announce
  it. Either keep the repository public, upgrade the plan, or accept that risk 4 reopens the
  moment it is flipped. Two commits that failed CI are already in `main`'s history from before
  this existed.

  Also corrected here: this bullet previously read "the CI workflow has never run … nothing has
  run on a Linux runner", which was false when written — `ci.yml` has existed since `12831ef` and
  ran green on `ubuntu-latest` on 2026-08-20 and 2026-08-21.
- `check:openapi` treats every changed value as potentially breaking, and its prose exemption is
  keyed on the leaf name — so a real API schema property named `description` (a future
  `Finding.description`, say) would be classified as prose and not raise the `/api/v2` banner.
  Messaging only: the exit code does not depend on that classification and still fails closed.
  Found by the Task 14 re-review. Task 16 or whenever a schema property named `description` exists.
- Task 10's fourth fix round has not itself been reviewed. Recommendation on file: fold it into
  the whole-branch review rather than spend a fifth round.
- Deferred residuals recorded in the ledger and assigned to Task 16 or later: dead
  `packages/config/tsconfig/*` presets; a guard against client-level `omit` on scope columns
  (Task 6 residual — it fails **closed**, and no client is constructed that way); Redis `EVALSHA`
  and `maxmemory-policy` (performance, Phase 3/4).
- Task 13 forced every HTML route dynamic to keep the nonce-based CSP intact. That is written
  up in `architecture/frontend.md` §2 and is a real cost to revisit when marketing content
  exists.
- **A human has now looked at `apps/web` in a browser** (2026-08-22, `/` and `/dashboard` on the
  dev server). Verdict: acceptable, and explicitly *too early to judge* — the design is expected to
  change once there are real screens to design against. So this is no longer an open debt, but it
  is also not a design sign-off, and nothing downstream should treat the current type, spacing or
  colour choices as settled. Still true: no non-Chromium browser has loaded it, and Playwright plus
  HTML/header assertions remain the only mechanical coverage.

### Phase 2 — Identity
Registration, email verification, login/logout, Argon2id, sessions, CSRF, password reset,
TOTP MFA with recovery codes, organisations, memberships, system roles and permissions,
permission guards, invitations, organisation switching, `/settings/security`.

*Exit:* the full authentication journey passes E2E; the authorization matrix test passes for
every existing endpoint; sessions revoke immediately.

#### Where Phase 2 starts — read this before resuming

**If you were told "Start Task N", read these four things in this order and then begin.** Nothing
else is needed, and re-verifying Phase 1 is not part of it:

1. This section, for what Phase 2 is and how it is executed.
2. [`docs/superpowers/ledger/phase-2/progress.md`](../../docs/superpowers/ledger/phase-2/progress.md)
   — the task table and the **pause state**, which names the next action. Read this first among the
   Phase 2 documents; it is the handoff.
3. The plan's **Execution protocol** section, which is binding on every task.
4. The plan's section for **your task only**, plus the previous task's ledger entry at
   `docs/superpowers/ledger/phase-2/task-NN/`.

**Status is Not Implemented and Tasks 1–9 do not change that.** The tables identity needs exist
and are proven to migrate, the wire contracts those endpoints validate against exist, a password can
be hashed and a breached one detected, and **as of Task 9 six endpoints are live** — a person can
register an account, confirm their email address, sign in, read their own session document and sign
out. The session service Task 6 built now has a caller that issues a cookie, and `logout` is the
first cookie-authenticated route `CsrfGuard` actually governs. But **nothing authorises anybody**:
`GET /auth/session` returns `permissions: []` because role assignment does not exist until Task 12,
no request is refused for want of a permission, and `apps/web`'s `(auth)` route group still holds a
layout with no routes under it, so no screen reaches any of this until Task 16. **Not one of the
three exit criteria above is met**: there is no E2E journey, no authorization matrix test, and
revocation is proved by integration tests rather than by the journey the criterion names. Per the
plan, the status moves to **Partially Implemented** at Checkpoint A, after Task 12.

**The `check:openapi` reports 4 routes below are dated evidence and stay as they are.** Each was
correct for the commit it describes. `check:openapi` reported **7** from Task 8 and reports **10**
from Task 9 onward, so the
sentence "this is the proof that no endpoint shipped" applies to those tables and to nothing
current.

`apps/api/src/modules/` now contains `auth` and `audit` alongside `health`. **`AuthModule`
registered no controller until Task 8, and now registers one** — `AuthController`, carrying the
three registration and verification routes. It exports four services: `PasswordService`,
`BreachCheckService`, `TokenService` and — as of Task 6 —
`SessionService`, all of them callable from Tasks 7–15 and called by nothing today. It
provides two more it deliberately does not export, `SessionRepository` and
`RedisSessionCache`, so no module outside `auth` can reach a session row or a cache key
except through the service that enforces the policy.

**Task 2 evidence, 2026-08-25 at commit `4788826`.** Every command re-run by the orchestrator on
the finished tree rather than taken from the implementer's report, with exit codes captured
outside a pipe (`out=$(pnpm <cmd> 2>&1); code=$?`), because `$?` after a pipe reports the last
stage's status and not the command's.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. ESLint clean, including the no-raw-hex and tenant-scoping rules. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **43 files / 536 tests**, up from 32 / 416 at Task 1. |
| `pnpm check:specs` | 0 | 54 spec files, each claimed by exactly one Vitest project — no spec runs nothing while printing green. |
| `pnpm test:integration` | 0 | 11 files / 148 tests against real Postgres 16. **Unchanged from Task 1**, correctly: this task added no integration spec. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm test:e2e` | 0 | 5 passed against a Playwright-owned production build. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |
| `pnpm check:openapi` | 0 | `apps/api/openapi.json` byte-identical to what the contracts generate, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global. |

What that table licenses and nothing more: the contracts compile, are exported, and behave as
their specs pin them; the workspace is green. **It says nothing about any endpoint**, because
there is none.

**What Task 2 delivered.** Zod request and response schemas for the eleven authentication
endpoints of `api/authentication.md` §2 and Tasks 8–10, plus the organisation, membership, role
and invitation schemas Tasks 13–15 will use — `.strict()` on every request schema, so an unknown
field is rejected rather than discarded (`api/conventions.md` §3). `Principal` and `TenantContext`
as **plain TypeScript types with no Zod schema**, deliberately: a `principalSchema.parse()` would
mint a principal out of attacker-controlled JSON. The `apiKey` arm of `Principal` is defined and
throws where it is reached — API keys are not in Phase 2. A password policy of minimum 12,
maximum 256, **no composition rules**, pinned by a spec asserting a twelve-character all-lowercase
password is accepted. Both ID prefix registries extended and, for the first time, **cross-checked
against each other** by a spec that was proven to go red by mutating each side in turn — Task 1's
carry-forward ruling 5 recorded that they had already drifted with nothing to notice.

**`UNKNOWN_FIELD` stopped being a code nothing could raise.** `ZodValidationPipe` now raises it at
400 when *every* Zod issue is an unrecognised key, while a mixed failure stays `VALIDATION_ERROR`
and still lists those keys — a validation failure must never hide behind a different code.
`api/errors.md` §2 was updated in the same change.

**Eleven review findings, and the two most severe were sentences rather than code.** A comment in
`auth.ts` quoted `"no maximum below 128"` as coming from `authentication.md` §2; `grep -rn "128"
.claude/` returns no such string in any authentication document. And the implementer's report gave
a CRLF cause for a commit that contains no CRLF and does not touch the file it named. Both are
corrected, and both are the same class as Phase 1's twelve. Three Medium findings were real code
defects the reviewer proved by measurement rather than argument: two specs claiming to cross-check
the Prisma enums stayed green when a value was added to `schema.prisma`; the pagination envelope
omitted the applied `limit` that `pagination.md` §4 requires, so a clamp was indistinguishable
from a short page; and `tenant-context.spec.ts` passed with its own module deleted. All eleven are
dispositioned in
[`docs/superpowers/ledger/phase-2/task-02/review.md`](../../docs/superpowers/ledger/phase-2/task-02/review.md).

**Task 3 evidence, 2026-08-25 at commit `7a7259e`.** Every command re-run by the
orchestrator on the finished tree, exit codes captured outside a pipe. Task 2 was re-verified the
same way before Task 3 began — all eleven commands exit 0 at the numbers its own table records.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. ESLint clean, including the no-`console` and no-`any` rules that bite in these two files. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **48 files / 596 tests**, up from 43 / 536 at Task 2. |
| `pnpm check:specs` | 0 | 59 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | 11 files / 148 tests against real Postgres 16. **Unchanged from Task 2**, correctly: this task added no integration spec. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, unchanged — Task 3 added no table. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row. Task 3 touches no `apps/web` path
(`git diff --stat main..HEAD -- apps/web` is empty) and ships no route, so it cannot reach a
rendered page.

What that table licenses and nothing more: two services exist, behave as their specs pin them, and
are wired into the Nest DI graph. **It says nothing about any user being able to register or log
in**, because they cannot.

**What Task 3 delivered.** `PasswordService` — Argon2id via `@node-rs/argon2`, parameters held in
`apiEnvSchema` rather than constants, PHC strings, and `verify()` returning
`{ valid, needsRehash }` so raising the parameters actually reaches existing accounts at their next
login. `BreachCheckService` — an HIBP k-anonymity client sending **only the first five hex
characters** of the password's SHA-1, off by default, 2-second timeout, failing open. A
`PASSWORD_BREACHED` error code in both `packages/contracts` and `api/errors.md` §3, and a 422
`PasswordBreachedError` with no producer until Task 8. Six new environment variables, `.env.example`
updated, and a `.superRefine` enforcing Argon2's `m >= 8p` so a bad pair is a config error naming
both variables rather than a native-module throw at boot.

**`AuthModule` registers no controller, and two independent checks prove it.** `check:openapi`
still reports 4 routes, and adding a controller was measured to turn both that check and the module
spec red.

**The two security claims are specs that were proven to fail.** The reviewer applied eleven
mutations to the implementation rather than reading the tests and agreeing with them. A
short-circuited absent-account branch reads a relative timing difference of **4874×** against a
tolerance of 0.25; a dummy hash baked at drifted parameters reads **23.7×**; a sixth hex character
and the full digest smuggled as a query parameter both fail the exact-URL assertion. Two places
were found where a test stayed green under a real violation — `needsRehash`'s memory-cost and
time-cost axes, and three of the four fail-open log-safety paths — and both were fixed and the
fixes proven by re-running the mutations that exposed them. A third round then pinned
`redirect: 'error'`, which a scoped re-review measured as deletable with every spec still green.

**Three Medium findings, eight Low, and — for the first time on this branch — no false sentence
about a document.** The citation pass checked roughly forty claims and found no invented quotation
and no misattribution. Phase 1 produced twelve such instances and both of Task 2's High findings
were prose, so this is a change worth naming rather than assuming.

**The worst finding was the orchestrator's, not the implementer's.** The Task 3 brief justified
running the timing spec at reduced Argon2 parameters on the grounds that production parameters
"would cost minutes". Measured on the development machine: **~36 ms per verification**, so the spec
would cost about 1.9 s — wrong by roughly 100×. The reduction stands on a different and now-written
argument (the property under test is parameter-independent, so real parameters buy CI flake risk
rather than proof), and the episode is recorded as carry-forward ruling 22: **a decision can be
right while the reason written beside it is false, and the false reason is still a defect.**

**Two known gaps were deliberately not closed here, and both are recorded rather than omitted.**
Timing equality holds against the dummy at *current* parameters but **not** against stored hashes
written before a parameter raise — a measured 4.6× difference, an enumeration oracle that opens on
the day an operator does the responsible thing and raises the cost. And a corrupted stored
credential is silently indistinguishable from a wrong password, with no log line at all. Both bind
**Task 9** as carry-forward rulings 24 and 25. A third, from ADR-0015: nothing yet meters the rate
of fail-open breach checks, and a check that has been failing open for a month is functionally a
check that was removed.

All findings and dispositions:
[`docs/superpowers/ledger/phase-2/task-03/`](../../docs/superpowers/ledger/phase-2/task-03/).

**Phase 1 was re-verified on 2026-08-24 at commit `40852c1` before this plan was written**, per
`sentinel-phase` step 2 — a status is a claim until a command proves it. All four exit criteria
were re-run and passed: `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm test` from a
**genuine clean clone** into a scratch directory (exit 0, 32 files / **414** tests, 5.14s); the
compose stack `Up (healthy)` on all four services; all four migrations applying to a **freshly
created empty database**; and CI run **`32707474182`** on `40852c1` concluding `success`. Docker
Desktop was not running at session start and was started, so criteria 2 and 3 are proven rather
than skipped.

Two figures have **moved** since Task 16 measured them, and both older numbers stay in this file
because they were correct for the commit they describe: the unit suite is now **414 tests** where
the Task 16 table records 403 — the E2E and CSP work in `53c3b0d`–`7479d31` added specs — and a
clean-clone `pnpm test` now takes **5.14s** against the 8.8s recorded there. Neither is a
correction of a false claim; they are the same measurement on a later tree.

The plan is
[`docs/superpowers/plans/2026-08-24-phase-2-identity.md`](../../docs/superpowers/plans/2026-08-24-phase-2-identity.md)
— **18 tasks plus one checkpoint** on branch `feat/phase-2-identity`. Order: 1 schema and
migrations · 2 contracts · 3 password hashing and breach check
· 4 single-use tokens · 5 mail · 6 sessions · 7 authentication guard, CSRF and CORS · 8
registration and verification · 9 login and lockout · 10 password reset · 11 TOTP MFA and
recovery codes · 12 tenant resolution and the authorization guard · 13 organisations and
switching · 14 memberships and roles · 15 invitations · 16 web auth screens · 17 web app shell
and `/settings/security` · 18 E2E journey, doc audit and this file.

**The branch reached CI early, on the operator's instruction, and it is green.** The plan put the
first CI run at Checkpoint A after Task 12; the operator moved it forward to after Task 2, and the
reason applied again at Task 3: **Task 3 added `@node-rs/argon2`, the first native binary dependency
in the repository**, and a prebuilt-binary resolution that works on Windows and fails on a Linux
runner is exactly the class of defect no local run can see. **The judgement was right and the run
below proves it was worth making** — though it proved the dependency resolves, not that it was ever
going to fail.

`feat/phase-2-identity` is pushed to `origin` at `6d6b582` and PR **#5** is open against `main`.
CI run **`32804873458`** on `6d6b582` concluded **`success`** on `ubuntu-latest` in 3m09s, with
every stage executed: format, lint, typecheck, unit tests, spec-project coverage, the compose
stack, integration tests against real Postgres, build, the OpenAPI contract diff, the tenant
registry check, and the Playwright E2E suite. **That was the first time any Phase 2 commit had been
built on Linux.**

**PR #5 was rebase-merged into `main` on 2026-08-25 at 04:37Z**, which supersedes this paragraph's
original closing sentence that the merge had not happened. `feat/phase-2-identity` is therefore
spent history: its tree is identical to `main`'s but its twenty commits are duplicates by content.
**Task 3 was built on a fresh branch, `feat/phase-2-task-03`, cut from `main`** — the phase-branch
model in the plan does not survive a rebase merge, and later tasks should cut per-task branches from
`main` the same way.

CI run **`32862806564`** on `7a7259e` concluded **`success`** on `ubuntu-latest` in **4m08s**
(14:57:54Z → 15:02:02Z), with every stage executed: format, lint, typecheck, unit tests,
spec-project coverage, the compose stack, integration tests against real Postgres, build, the
OpenAPI contract diff, the tenant registry check, and the Playwright E2E suite.

**This is the run that matters most in Phase 2 so far**, and it is the reason the operator moved CI
forward. It is the first time `pnpm install --frozen-lockfile` resolved `@node-rs/argon2`'s prebuilt
binary on Linux rather than on the Windows development machine — ADR-0014's central risk, and the
one class of defect no local run can observe. It is also the first time the statistical timing spec
ran on a shared runner, which is the environment its tolerance was chosen for and the reason the
spec runs at reduced Argon2 parameters (ruling 22). Both held.

**PR #6 was rebase-merged into `main` on 2026-08-25 at 15:55Z**, on the operator's instruction, with
CI green on `b9ce0ed` (runs `32868345161` and `32868350906`, both `success`). This paragraph
originally said no pull request had been opened; that was true when it was written and is recorded
here rather than deleted. `main` and `feat/phase-2-task-03` have identical trees at
`71132d6`. **Task 3 is on `main`.**

**GitGuardian failed on PR #6 and was not a merge gate**, exactly as on PR #5. Its findings on this
branch are the SHA-1 test fixture in `breach-check.service.spec.ts` and the passphrase it derives
from. Both were checked rather than assumed: `ABF7AAD6438836DBE526AA231ABDE2D0EEF74D42` was
recomputed and **is** the SHA-1 of `correct horse battery staple`, the published xkcd example, which
is the whole reason it was chosen as a fixture. Nothing live, nothing to revoke. **The standing cost
named under PR #5 is now larger, not smaller**: two consecutive pull requests on a security
product's repository have carried a red security check that everyone is expected to ignore. The
`.gitguardian.yaml` ignore list naming each match and why is **still not written.**

`main` is protected with `verify` as a required status check, `enforce_admins` enabled, linear
history required, and force pushes and deletions blocked, so no commit reaches `main` without that
run passing.

**GitGuardian reports three secrets on the pull request, and all three are false positives.** It is
not a required check and does not gate the merge. All three sit in commit `ed7eb03` — the
2026-08-24 Phase 1 ledger recovery — inside `docs/superpowers/ledger/phase-1/review-diffs/`, and
none is a live credential: a string in an `it.each` table labelled *"a base64url-ish token"*; the
`sentinel_local` password of an ephemeral Testcontainers Postgres, which is also in the committed
compose configuration; and a JWT header with the literal signature `.abc.def`, inside the test that
asserts the redacting logger removes it. **Nothing to revoke or rotate.** The standing cost is that
a security product's repository now carries a permanently red security check, which trains people
to ignore it — worth closing with a `.gitguardian.yaml` ignore list naming each match and why.
**That is not done.**

**Task 4 evidence, 2026-08-26 at commit `58fd35a`.** Every command re-run by the orchestrator on
the finished tree after the fix round, not taken from the implementer's report, with exit codes
captured outside a pipe.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. Including the new fence on `@sentinel/db/testing`, which was watched failing on a probe file before it was trusted. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. It is also the only one of the three that caught a stub missing a method (TS2345); `test` and `lint` were both green on it. |
| `pnpm test` | 0 | **53 files / 645 tests**, up from 48 / 596 at Task 3. |
| `pnpm check:specs` | 0 | 65 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **12 files / 163 tests** against real Postgres 16, up from 11 / 148 — the first `apps/api` integration spec to own a migrated database. Five consecutive green runs. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, unchanged — Task 4 added no table and no migration. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row. Task 4 touches no `apps/web` path and ships no
route, so it cannot reach a rendered page.

What that table licenses and nothing more: a token can be minted, hashed, stored, superseded and
redeemed exactly once, and the properties that need a real database are asserted against one.
**It says nothing about any user receiving a link**, because no endpoint issues one and no mail is
sent — that is Tasks 5, 8 and 10.

**What Task 4 delivered.** Two layers, because §6's one *discipline* is not one table:
`secret-token.ts` mints 256 bits from `crypto.randomBytes`, base64url-encoded, and hashes with
SHA-256 — the primitive Task 6 will use for `Session.tokenHash` and Task 15 for
`Invitation.tokenHash` — and `TokenService` owns `VerificationToken` persistence for the two
purposes the Prisma enum has. Consumption is a single conditional `updateMany` whose affected-row
count is the decision, so of two simultaneous redemptions of one reset link exactly one succeeds.
Three TTLs in seconds on `apiEnvSchema`'s base object. `TOKEN_INVALID` at 422 in both error lists —
one code for unknown, expired, consumed and superseded alike, because distinguishing them tells an
attacker the address is registered — with the `ERROR_CODES`↔`api/errors.md` parity spec that
carry-forward ruling 27 had been asking for since Task 3.

**The review found one High, and it was the task's own defect shape one layer up.** `consume` was
built correctly and its concurrency test is the best in the phase so far. `issue` was not: its
supersede-then-insert runs inside a transaction, which is exactly why it looks safe and is not —
under READ COMMITTED a second transaction cannot see the first's uncommitted `INSERT`, so both
tokens commit live. Measured at ten pairs out of ten rounds before the fix and one out of ten
after, with a negative control proving the new lock is not global. **A transaction is not a lock.**

**The redacting logger was measured leaking, and the measurement changed the link format.** Of four
shapes carrying a real 256-bit token, only the one under a denylisted key name was redacted; the
token survived verbatim inside a URL under `verifyUrl`, inside a message string, and as a `%s`
argument. A value-shape pattern now covers a secret in a query parameter — but `key` and `code`
were deliberately removed from its name list, because `redact()` blanks the **whole** field and
both collide with this product's own object-storage URLs and error codes. The consequence is a
constraint on Task 5: **a secret in a link travels as `?token=`**, and a path-segment link is
covered by nothing.

**Two latent defects were found in Phase 1 code while diagnosing an intermittent suite, and
neither was Task 4's.** `fileParallelism: false` on the integration project had never been in
force — Vitest resolves the pool's worker count from the root config, and `vitest.workspace.ts`
declares projects only. Measured: 140.60s of test time inside a 19.72s wall clock. Underneath it,
`rate-limit.integration.spec.ts`'s `beforeEach` deletes `ratelimit:login:*`, which is the exact
namespace `sliding-window.integration.spec.ts` writes its keys in on the one shared compose Redis,
while its comment claimed the narrowing "protects other suites". Root `test:integration` now passes
`--no-file-parallelism` and the comment says what is true. `development/testing.md`'s
"tests are parallel-safe" sentence was corrected in the same change: it is a statement about
Postgres rows and does not generalise to Redis.

**`@sentinel/db/testing` was added as a package export and arrived unfenced.** It is how an
`apps/api` integration spec reaches a *migrated* database, which the compose stack is not in CI —
but `startPostgresHarness()` returns the schema-owner DSN, which no RLS policy applies to. A
non-spec probe importing it passed both `eslint` and `tsc`. It is now a `no-restricted-imports`
fence, proven to fire, and `development/coding-standards.md` §6 records it beside the unscoped-client
rule it belongs with.

**Task 4 is on `main`.** Built on `feat/phase-2-task-04`, cut from `main`, with its history
rewritten before pushing so `apps/api/openapi.json` moves with the contracts commit that changes
it — before that, four commits failed `pnpm check:openapi` and a change to the shipped API contract
sat inside a commit typed `docs(ledger):`. **PR #8 was rebase-merged on 2026-08-26 at 01:10Z**
(merge commit `3473a6d`) and the branch was deleted. An earlier version of this paragraph said the
branch was unpushed with no pull request; that was true when it was written and is recorded here
rather than deleted.

**CI was green on a Linux runner before the merge** — run `32917703646`, `ubuntu-latest`, 3m24s,
conclusion `success`. The stage worth naming is integration: **12 files / 163 tests in 48.64s of
wall clock for 42.20s of tests**, which is sequential execution behaving on CI exactly as it does
locally, and which is also the first proof that `startPostgresHarness()` works in a runner where
the compose database has no migrations applied.

**GitGuardian failed on PR #8, as it had on PRs #5 and #6.** It is still not a required check and
still did not gate the merge.

**The `.gitguardian.yaml` ignore list this file recorded as owed from PR #5 was never written, and
it is no longer owed — it would not have worked.** `ignored_matches` in that file is read by the
**ggshield CLI**, which this repository does not run. The failing check is the GitGuardian **GitHub
App**, driven from the dashboard and cleared by a check-run skip action or by resolving the incident
there; a file in the repository never enters into it. Writing one would have produced a control that
looks like a control and does nothing, which is worse than an absent one.

**The model of the problem recorded here was also wrong.** This file said the findings were the
three phase-1 `review-diffs` matches. Reading each check run's own output shows four different sets:
**#5** three in `review-diffs/`, **#6** a `Generic Password` in `auth.module.spec.ts`, **#8** four
`Generic High Entropy Secret` in `redaction.spec.ts`, **#10** two in the email spec fixtures. The
recurring cause is **credential-shaped test fixtures**, and not one finding across four pull
requests was a real credential. What replaces the ignore list is `pnpm check:secrets`
(`scripts/check-secret-shaped-literals.ts`), a shape rule over committed files that fails before a
push rather than after one.

**Correction, 2026-08-26, made while verifying the claim rather than repeating it.** An earlier
version of this paragraph said PR #8 made it "three consecutive pull requests" and that the
repository "has now carried a red security check on every pull request it has ever had". Both are
false, and `gh api …/check-runs` over every pull request is what showed it: **#5 failure, #6
failure, #7 success, #8 failure, #9 success.** PRs #7 and #9 are the documentation follow-ups that
recorded the #6 and #8 merges, and they were green. The true statement is the narrower one now
written above. This is the same defect class the phase's citation pass exists to catch, found in
`roadmap.md` itself.

**Task 5 evidence, 2026-08-26 at commit `0088852`.** Every command re-run by the orchestrator on
the finished tree after the fix round, not taken from the implementer's report, with exit codes
captured outside a pipe.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks, uncached. |
| `pnpm typecheck` | 0 | 14 tasks. |
| `pnpm test` | 0 | **60 files / 828 tests**, up from 53 / 645 at Task 4. |
| `pnpm check:specs` | 0 | 73 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **13 files / 169 tests** against the real compose stack, up from 12 / 163. The new file sends real SMTP to Mailpit. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, unchanged — Task 5 added no table and no migration. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row. Task 5 touches no `apps/web` path and ships no
route, so it cannot reach a rendered page. It does change `webEnvSchema`, which `apps/web` boots
on — the scheme constraint described below — and that is covered by unit specs against both
schemas, not by a browser.

What that table licenses and nothing more: an email can be rendered in both parts and delivered
over real SMTP to a real server, and read back from that server with its recipient, subject, both
MIME parts and its `?token=` value intact. **It says nothing about any user receiving mail**,
because `Mailer.send` has no caller outside a spec — that is Tasks 8, 10, 11 and 15.

**What Task 5 delivered.** A `Mailer` port with a single SMTP adapter behind a DI token, and seven
templates behind a registry. Seven rather than the plan's six because MFA enabled and MFA disabled
became separate templates, which the brief permitted. Three carry a live single-use credential in a
`?token=` query parameter — discharging Task 4's rulings 34 and 36, which measured a path-segment
token leaking verbatim through the redacting logger — and four are notices carrying no link at all,
which is a deliberate widening of the brief: the phishing pretext for "your password was changed"
is a link, so those messages contain none.

**The registry is the load-bearing idea and it was verified destructively, not read.** Both sample
tables are `Record<EmailTemplateId, …>`, so a template added without its samples is a compile
error, and every rule — non-empty parts, a text part that is prose rather than stripped markup, no
unreplaced placeholder, no remote asset, an escaped attacker-chosen display name — is asserted by
iterating the registry rather than by six copied blocks. The reviewer added a deliberately broken
template: **eight assertions fired**, naming every planted defect; leaving it unclassified fired a
ninth; omitting it from the sample table produced the promised `TS2741`.

**The review found one High, and it was in a control nobody asked for.** `SmtpMailer` volunteered a
guard refusing a recipient containing CR, LF or NUL. It did not refuse a **comma**, and nodemailer
parses `to` as an address *list* — measured as two `RCPT TO` commands from one `send`, and against
the real compose Mailpit an attacker address on the right of the comma received a password-reset
message. The same probe established the guard was the only line of defence below Zod, because
nodemailer does not refuse a CRLF recipient on its own either. The guard now enforces *one address*.
**A guard that half-holds is still better than the absent guard it replaced**, and its existence is
what gave the review something specific to attack.

**Two false sentences reached the implementer's report, and the citation pass caught both.** The
dangerous one claimed Task 15 would add "the seventh template" when the registry already holds
seven and the invitation is one of them, built here — and it was written into four code docblocks
and proposed for the ledger's carry-forward section, which is the propagation path that produced
five of Phase 1's twelve instances. Every other claim in that report — every command, exit code,
file line count and commit SHA — was re-run rather than read, and reproduced exactly.

**A measured leak was closed at the config layer, and a residual was deliberately left open.**
`z.string().url()` delegates to `new URL()`, which accepts any scheme: `javascript:alert(1)` passed
`WEB_BASE_URL` validation and landed byte-identical in an email `href`, because `escapeHtml`
touches neither `:` nor `(` nor `)`. Both base URLs on **both** schemas — the API's and the web
app's, which declare their own copies — are now constrained to http/https, and `renderEmail`
refuses a non-http action URL as well. Underneath that fix sat a Zod behaviour worth recording: a
failed `.url()` check marks a result **dirty**, not aborted, so a `superRefine` still runs over the
invalid value, and an unguarded `new URL()` there threw a raw `TypeError` past `loadEnv`'s error
envelope. **A Phase 1 spec caught it** — the one asserting no sentinel value ever reaches an error
message.

The residual left open: a relay that quotes a token back **stripped of its URL** puts it in
`err.message` and `err.stack`. Measured. A token inside a rejected `?token=` URL *is* redacted, and
the primary control — the adapter logging no body, ever — is intact. It is not closed because
widening the value pattern is exactly what Task 4's ruling 34 records as dangerous: `redact()`
blanks the whole matched field, which is why `key` and `code` had to be removed from it.

**Mail delivery has no retry, no queue, and no alert, and that is the largest honest gap.**
ADR-0016 names it and `architecture/integrations.md` §7 now names it. A failed verification email is
survivable — Task 8 owes a resend path — but a failed *security notice* means the signal that would
reveal an account takeover never arrives, and nothing detects that. Phase 4's queue owns it.

**Task 5 is on `feat/phase-2-task-05`, unpushed, with no pull request.** Cut from `main` at
`c641b9d`. **ADR-0016 was committed before any implementation commit** — `09:28:54` against a first
implementation commit at `09:38:20` — and the reviewer verified that ordering rather than taking it
on trust, along with the fact that the brief has one commit and was never amended, so its twelve
rulings were not back-filled.

**A live-format token reached the ledger, and the branch history was rewritten to purge it before
the push.** The value was redacted in the working tree by `0088852` but survived in the history at
`aaa6d39` and `d5161c5`, and `main` blocks force pushes and requires linear history — so a merge
would have made it permanent. It is inert (minted for a Mailpit send; no `VerificationToken` row was
written and no account exists) and it was purged anyway, because a repository whose security check
has been red on three of its four code pull requests does not need a genuine-looking secret added to
the pile. Done behind a backup branch on Task 4's precedent: **the rewritten tree is
byte-identical to the pre-rewrite tree** — hash `4f1ff58…` on both sides, empty `git diff --stat`
against the backup — and all ten commands were re-run on the rewritten history before the backup was
deleted.

**CI is green on a Linux runner, before the merge.** Runs `32955708670` (push, 3m50s) and
`32955711939` (pull request, 3m28s) on `ubuntu-latest`, both `success`. The stage worth naming is
integration: it is the first time the Mailpit SMTP path has run anywhere but a developer's machine,
and **13 files / 169 tests** pass in a runner where the mail container is started by
`.github/workflows/ci.yml` alongside Postgres, Redis and MinIO. `check:openapi` reports four routes
on CI as it does locally.

**GitGuardian passed — "25 commits were scanned without uncovering any secrets"** — and getting
there took two history rewrites rather than one, which is the part worth recording. The first
attempt changed both offending constants at the **tip** of the branch; the check stayed red and
kept citing `1cd9b0a`, the commit that introduced them, because **GitGuardian scans every commit in
a pull request rather than the final tree**. That is the same lesson the ledger-token rewrite had
taught an hour earlier, arriving a second time in the same task. The values themselves were never
credentials: two 43-character random base64url constants used as opaque round-trip fixtures in
`links.spec.ts` and `registry.spec.ts`, replaced with `FIXTURE_not_a_real_token-…`, which keeps the
length and charset the specs actually need and none of the entropy. Ruling 63.

**Task 6 evidence, 2026-08-26 at commit `4fbcdb3`.** Every command re-run by the orchestrator on
the finished tree rather than taken from the implementer's report, with exit codes captured outside
a pipe. Task 5 was re-verified the same way on `main` at `2fceaaa` before Task 6 began — all eleven
commands exit 0, with `pnpm test` at 61 files / 847 tests, which is 1 file and 19 tests above the
table Task 5 recorded for itself because the two `check:secrets` commits landed after it.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. ESLint clean, including the no-`any` and no-`console` rules. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **63 files / 917 tests**, up from 61 / 847 at Task 5. |
| `pnpm check:specs` | 0 | 77 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **14 files / 192 tests** against real Postgres 16 and the compose Redis, up from 13 / 169. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, unchanged — Task 6 added no table and opened no migration. |
| `pnpm check:secrets` | 0 | 332 tracked files, no credential-shaped literals. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row. Task 6 touches no `apps/web` path and ships no
route, so it cannot reach a rendered page.

What that table licenses and nothing more: a session can be issued, resolved, rotated and revoked
by a caller inside the API process, and the properties that only a real Postgres and a real Redis
can falsify have been falsified deliberately and then fixed. **It says nothing about anybody being
able to log in**, because nothing calls any of it.

**What Task 6 delivered.** `SessionService`, `SessionRepository`, `RedisSessionCache` and
`cookies.ts` under `apps/api/src/modules/auth/`: a 256-bit token whose SHA-256 hash is all that is
stored, both of §3's clocks enforced independently, rolling renewal only past the halfway mark of
the idle window, rotation on privilege change with the absolute cap inherited rather than restarted,
single and bulk revocation, and the `__Host-session` cookie's attributes as one authority. Five
`SESSION_*` environment variables with a cross-field rule, added inside `apiEnvSchema`'s base object
because it is a `ZodEffects` (carry-forward ruling 30).

**Revocation is immediate by a mechanism `security/authentication.md` §3 did not describe, and the
document was corrected in the same change.** §3 and ADR-0005 both said revocation "deletes the cache
entry and the row together". Measured, a delete does not achieve that in either order: a resolve
that has already read a live row can land its cache write *after* the delete, and the next resolve
serves a revoked session until the TTL expires. So revocation writes a **tombstone** and every live
write goes through a Lua compare-and-set that refuses to overwrite one — Redis runs a script
atomically, so there is no interleaving in which a live entry replaces a tombstone. **ADR-0005 was
deliberately not edited**: `CLAUDE.md` makes an accepted ADR immutable, the decision it records is
unchanged, and only an implementation sentence inside it is now known to be insufficient, so §3
carries the correction and names the ADR as predating the measurement (ruling 53).

**Two measurements the brief demanded in advance, both re-run by the reviewer.** A `__Host-` cookie
**is** accepted over `http://localhost` — Chromium 151.0.7922.34, the cookie stored and sent back,
with the two negative controls (`Domain=localhost` and `Path=/sub`) both rejected, which is what
rules out the browser ignoring the prefix. Task 18's E2E suite therefore has no surprise waiting in
it. And **rotation does not need carry-forward ruling 31's advisory lock**: unlike token issuance it
supersedes one committed row by primary key, so Postgres arbitrates. 60 rounds of two parallel
rotations gave 60/60 single successors; a read-then-write substitute gave 60/60 double successors —
one credential, two live sessions, which is a session-fixation defence that does not defend.

**Two High findings, one Medium, four citation findings, and both Highs were in the gap between what
a test asserts and what it appears to assert.** A rotation test compared two `Date.now()`-derived
values at millisecond precision, so the mutation that restarts the 7-day absolute cap passed or
failed on a coin flip (ruling 49). And `rotateSessionInputSchema` defaulted `status` to `'ACTIVE'`,
contradicting the argument written twelve lines above it in the same file: `rotate({ sessionId })`
on a ten-minute `PENDING_MFA` session returned a thirty-day `ACTIVE` credential with
`mfaCompletedAt: null` and nothing proved. The default is gone and a promotion without evidence now
throws (ruling 50). The Medium was a revocation-immediacy residual the task had not disclosed:
a session created between the enumeration and the write in `revokeMany` **is** revoked in Postgres
but was never tombstoned, and the reviewer measured it resolving as valid from a warm cache entry
with Redis healthy. Bulk revocation now poisons twice (ruling 51). All ten findings are
dispositioned in
[`docs/superpowers/ledger/phase-2/task-06/rulings.md`](../../docs/superpowers/ledger/phase-2/task-06/rulings.md).

**The implementer overturned one of the reviewer's claims by measurement, and was right.** The
review called the weak assertion vacuous; it was flaky — it caught the mutant when two clock
readings straddled a millisecond and missed it when they did not, and both agents' runs were real.
The finding and the fix are unchanged, because a test that fails on a coin flip teaches a reader to
re-run CI rather than to believe it. It is recorded because "vacuous" was the sentence heading into
the carry-forward ledger, and it is the second task running in which a downstream agent corrected an
upstream claim with a command instead of deferring to it.

**What is built and not reachable, stated because §3 now reads as settled.** No endpoint issues a
session, no guard reads one, and **no cookie has ever reached a browser from the application** —
`serialiseSessionCookie`'s output has been produced in specs and in one throwaway probe and attached
to no response. `PENDING_MFA` is recorded and its short lifetime is enforced, but the rule that such
a session authenticates nothing except the MFA endpoint is Task 7's and does not exist. Revocation
keeps one residual nothing here can close: if Redis is unreachable *at the moment of revocation* the
row is revoked and no tombstone can be written, so an entry cached before the outage serves until it
expires — bounded by `SESSION_CACHE_TTL_SECONDS`, default 60 (ruling 52).

**Task 6 is on `feat/phase-2-task-06`, cut from `main` at `2fceaaa`, unpushed, with no pull
request** — twelve commits. Tasks 1–5 were each one branch and one PR with CI green on a Linux
runner before the merge; **that is owed here and has not happened**, so nothing on this branch has
been proven anywhere but this machine.

**Task 7 evidence, 2026-08-27 at commit `f877a12`.** Every command re-run by the orchestrator on
the finished tree rather than taken from the implementer's report, with exit codes captured outside
a pipe.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **69 files / 1025 tests**, up from 63 / 917 at Task 6. |
| `pnpm check:specs` | 0 | 84 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **15 files / 205 tests** against real Postgres 16 and the compose Redis, up from 14 / 192. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, still **4 routes**. **This is the proof that no endpoint shipped.** |
| `pnpm check:registry` | 0 | 14 models, unchanged — Task 7 added no table and opened no migration. |
| `pnpm check:secrets` | 0 | 345 tracked files, no credential-shaped literals. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row: Task 7 touches no `apps/web` path.

What that table licenses and nothing more: the guards behave as their specs pin them against
purpose-built test controllers, and the boot assertion still refuses an undeclared route now that
there are three ways to declare one. **It says nothing about any real endpoint being protected**,
because there is none.

**What Task 7 delivered.** `AuthenticationGuard` resolving the session cookie to a `Principal` and
keeping `UNAUTHENTICATED` and `SESSION_EXPIRED` distinct, as `api/authentication.md` §6 requires;
`CsrfGuard` doing double-submit over a token **derived from the session token by HMAC** rather than
stored, so binding is by construction and rotation re-derives for free; a cookie-header parser, the
third access declaration `@AuthenticatedOnly()` that `security/authorization.md` §5 has named since
Phase 1 without it existing, `@AllowPendingMfa()`, and a CORS middleware implementing ADR-0017.
**ADR-0017 was committed at `7029038` before any implementation commit**, as 0014, 0015 and 0016
were.

**The boot assertion was extended to three arms, not relaxed, and proved in both directions.** An
undeclared route makes the real `dist/main.js` exit 1 naming the offender; the same route carrying
`@AuthenticatedOnly()` boots. Running only the first would not have shown the new arm actually
satisfies the assertion; running only the second would not have shown the check still refuses.

**No High findings, and that is a narrower result than it sounds.** Both of Task 6's Highs were
mutations that survived the suite. Here the reviewer wrote twelve mutations beyond the implementer's
five and the only survivor was a **missing test over correct code**: the `PENDING_MFA` class-metadata
exemption held only because one line reads `getHandler()` and nothing else, and widening it to
`getAllAndOverride([handler, class])` left 1000 unit and 205 integration tests green. **This
codebase has already shipped that exact bug once** — `@RateLimitExempt()`, where a single class-level
line disabled every rate limit beneath it. Three attacking controllers now hold it, including one
inheriting the metadata from a base class. Ruling 61.

**The orchestrator wrote a false sentence and it propagated into a code comment and two documents.**
The Task 7 brief claimed the rate limiter's `unresolvedWarned` path would make the unresolvable
per-principal scope visible at runtime. It cannot fire for `generalSession`, which is fail-open with
`perPrincipal` as its only scope, while the warn requires fail-closed *and* a resolved scope. So
`abuse-prevention.md` §1's **1000 requests per minute per principal is promised and enforced by
nothing, and nothing reports that** — corrected in all three places rather than papered over with a
new warning invented to make the old sentence true. Ruling 55. The rule that implementers do not
write status prose exists because prose is where this project's defects live; it does not exempt
whoever writes the brief.

**A `@Public()` unsafe route was 403-able by anyone's stale session cookie**, because `CsrfGuard`
read no access declaration — and the page could not satisfy the refusal, since the expected token
derives from the `HttpOnly` cookie a script cannot read. Task 9's login endpoint would have inherited
it, failing for exactly the users who already had a stale session. Fixed by reading the same metadata
key the authentication guard reads. **Login CSRF is consequently not covered by this control** — a
cross-site login `POST` carries no session cookie, so double-submit has nothing to bind to — and
`security/authentication.md` §4 now says so, with Task 9 owing its own mechanism. Ruling 56.

**Two things are now measured that were previously read.** A credentialed cross-origin `fetch` from
the configured web origin **is not blocked** by the `Cross-Origin-Resource-Policy: same-origin`
header Phase 1 puts on every response — Chromium 151.0.7922.34, with the same URL blocked in
`no-cors` mode in the same run to prove CORP is live rather than absent, and the 401 envelope
readable cross-origin, which is what makes the two-code distinction usable by a browser at all
(ruling 60). And Node's repeated-header semantics differ per header: `Cookie` joins with `'; '`, an
ordinary header with `', '`, `Set-Cookie` is an array, and **`Authorization` keeps the first value
and silently drops the second** — which binds whichever task builds API-key authentication, because
a header the parser never sees fails worse than one it mis-parses (ruling 57). Both began as an
implementer disclosing that a claim was a reading rather than a measurement.

All ten findings are dispositioned in
[`docs/superpowers/ledger/phase-2/task-07/rulings.md`](../../docs/superpowers/ledger/phase-2/task-07/rulings.md).

**Task 7 is on `feat/phase-2-task-07`, stacked on `feat/phase-2-task-06`, both unpushed with no
pull request.** Tasks 1–5 were each one branch and one PR with CI green on a Linux runner before the
merge. **Two tasks of work have now accumulated without that**, and nothing on either branch has been
proven anywhere but one Windows machine.

**One local-environment fact, measured twice.** The compose Postgres has drifted:
`has_schema_privilege('sentinel_app','public','USAGE')` returns `f`, where
`infra/docker/postgres/init/01-app-role.sql:13` grants it — Postgres init scripts run only against an
empty data directory, and this volume predates that line. **The suites are unaffected**, because
every table-touching integration spec starts its own Testcontainers Postgres, but the real
application run against the compose database answers 500 from any path that reaches the database.
Nothing was changed on the operator's machine to fix it.

**Task 8 evidence, 2026-08-31 at the branch head after the second review's fixes.** Every command re-run by the orchestrator on
the finished tree, exit codes captured outside a pipe. Task 7 was re-verified the same way before
Task 8 began — all eleven commands exit 0 at the numbers its own table records.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **76 files / 1120 tests**, up from 69 / 1025 at Task 7. |
| `pnpm check:specs` | 0 | 93 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **17 files / 230 tests** against real Postgres 16 and the compose Redis, up from 15 / 205. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | **7 routes**, byte-identical. The number that had read 4 since Phase 1. |
| `pnpm check:registry` | 0 | **15 models** — 3 tenant-owned, 1 tenant root, 11 deliberately global. `PlatformAuditEvent` is the new one. |
| `pnpm check:secrets` | 0 | 368 tracked files, no credential-shaped literals. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row: Task 8 touches no `apps/web` path.

What that table licenses and nothing more: three endpoints exist, answer, and behave as their specs
pin them against a real Postgres. **It says nothing about anybody being able to log in** — there is
no login endpoint until Task 9 — and nothing about a person using any of this, because no screen
calls it until Task 16.

**The API publishes seven routes, and a dozen sentences in this file stop applying.** Every task
since Phase 1 has cited `check:openapi` reporting 4 as the proof that no endpoint shipped. That
proof is spent. `POST /api/v1/auth/register`, `POST /api/v1/auth/verify-email` and
`POST /api/v1/auth/resend-verification` are live, `AuthModule` registers a controller, and the
mailer has a caller for the first time since Task 5 built it.

**What Task 8 delivered.** Registration writing `User`, `Credential`, a verification token and an
audit event in one transaction with the mail sent after it commits (carry-forward ruling 44, which
Task 5 could only write as a docblock because no endpoint existed to demonstrate it — Tasks 10, 11
and 15 copy this). Verification consuming the token through Task 4's conditional update and checking
`User.status` afterwards, per ruling 37. A resend path, which ruling 45 made this task owe because a
failed first send is otherwise authoritative. An eighth email template. `PlatformAuditEvent` and its
migration. The partial unique index on `VerificationToken` that ruling 32 had owed since Task 4 and
assigned to whichever task next opened a migration. And an `emailVerifiedAt` gate that governs
**zero routes today** — Task 8's three are all `@Public()`, so there is nothing for it to guard
until Task 13 applies it, and it is proved against test controllers exactly as Task 7's
`@AllowPendingMfa()` was.

**ADR-0019 decides where an audit event goes when there is no organisation**, and it was written and
committed before any implementation, as 0014–0017 were. `AuditEvent.organizationId` is NOT NULL with
a `Restrict` FK — but the column type is the smaller half. The table carries RLS
`USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`, so relaxing
the column does not make the write work: **measured** on a scratch table carrying that exact policy,
as `sentinel_app`, the tenant-scoped insert succeeded and the NULL insert was refused with `new row
violates row-level security policy`. The reviewer reproduced it independently. So a second table,
registered as deliberately global, with the same tamper resistance — and the cost named rather than
hidden: the platform-admin cross-tenant view `audit.md` §6 describes becomes a union, paid by a
reader that does not exist yet instead of by a table that already has readers. **0018 stays reserved
for Task 11.**

**One High, and it was a live behaviour rather than a missing test.** An unauthenticated caller
could put up to 512 characters of chosen text, **including a URL**, into the security notice this
product mails to any address they could guess was registered: `POST /auth/register` against an
existing address renders the caller's `User-Agent` as `Device: <value>` in a message wearing
Sentinel's branding, under a footer promising it never includes a link. Mail clients autolink a bare
URL in a text part, so the message contradicted itself in the recipient's inbox. Fixed structurally
— the template's context type cannot carry an IP or a user agent, so there is no parameter for the
value to travel through — and the values go to the `PlatformAuditEvent` row instead, which is where
attacker-supplied text belongs. **The spec that should have caught it ran the benign fixture**, and
the hostile fixture two declarations away contained no `http`, so swapping it in would still not
have failed. Carry-forward ruling 58, third instance in three tasks.

**The OpenAPI document now describes request bodies, which it had never been able to do.**
`ApiDocDeclaration` had no field for one, invisible while Phase 1 shipped only `GET` health probes.
The first three `POST` routes therefore published what they answer and nothing about what to send —
including that every request schema is `.strict()`, which now reaches the document as
`additionalProperties: false`, so a client can see that an unknown field is a 400 `UNKNOWN_FIELD`
rather than a value quietly dropped.

**A known enumeration residual, measured and open: the resend is distinguishable by timing.**
Twenty-five samples: no account 4.0 ms, already verified 4.2 ms, awaiting confirmation 8.6 ms, with
non-overlapping ranges — so a response over roughly 7 ms identifies the case. The response body is
byte-identical for all three, which is what the contract requires; the latency is not. Closing it
needs the Phase 4 queue, and it is recorded in `security/authentication.md` §6 rather than left to
be discovered. Registration's own two paths were measured at 47.8 ms against 44.5 ms median with
near-total overlap, and a statistical timing assertion was deliberately **not** committed on that
evidence — the spec asserts the hash happens on both paths instead.

**The fix round was finished by the orchestrator, not the implementer, and it was then reviewed by
a second fresh agent — which is the only reason this branch is not shipping an open High.** The implementer subagent hit the weekly usage limit after landing the High
fix. Seventeen of eighteen findings are fixed and every fix is proved by re-applying the reviewer's
own mutation, but the separation of author from reviewer that the rest of this phase relies on is
absent for that round, so a **scoped adversarial review was run over the fix commits before the
branch was pushed**. It found that **H1 was still open** — the round had closed the attacker-supplied
`User-Agent` channel into the registration notice and left the attacker-supplied *display name*
open, and its own test had gone red on that field and been reasoned into silence with an argument
that was true about the data flow and false as an inference. **An attacker seeds a victim's
`User.name` by registering the victim's address first.** Now closed the same structural way:
`emailVerification` and `registrationAttempt` render no name, no IP and no user agent at all, so no
parameter exists for the value to travel through. Ruling 70, which binds Task 10's password reset —
the one remaining template that renders a name into an unauthenticated, unverified-address message,
and it carries a live link.

That review also found **a false claim this file carried**: the fix round asserted that the
redacting serialiser blanks the `body` and `text` field names outright. It does not. It is a
value-shape net — measured, `redact({ body: '<a notice body>' })` returns it verbatim, and only a
value matching a secret pattern such as `?token=` is blanked — so the three link-carrying templates
are rescued by their own link and the five link-free notices are not rescued at all. One unverified
sentence had reached four places. Ruling 67 is rewritten.

The earlier round had already found **two defects in its own  a vacuous test that passed for an unrelated reason, and a claim about the
redacting serialiser that the scoped review then measured as false. All of it is in
[`docs/superpowers/ledger/phase-2/task-08/fixes.md`](../../docs/superpowers/ledger/phase-2/task-08/fixes.md).

**One finding is upheld as false and deliberately not fixed.** A comment in the applied
`platform_audit_event` migration overstates what replacing the append-only trigger function changes
— measured, `AuditEvent`'s message is byte-identical, because `TG_TABLE_NAME` on that table *is*
`AuditEvent`. Editing it would change the migration's checksum and break `prisma migrate dev` for
every developer until a reset that carry-forward ruling 3 says an agent cannot perform. One
misleading clause is cheaper than the operator's database. Recorded as ruling 65: **a migration
comment is immutable the moment it runs, so measure before applying.**

All eighteen findings are dispositioned in
[`docs/superpowers/ledger/phase-2/task-08/`](../../docs/superpowers/ledger/phase-2/task-08/).

**Tasks 6 and 7 are on `main` and CI is green on them**, which corrects the sentences above that
call them unpushed with no pull request: both were merged and runs `33088717123` and `33088206506`
concluded `success`. **Task 8 was merged to `main` on 2026-08-31 as PR #14** (rebase, branch
deleted), with CI green on a Linux runner before the merge: run `33370530376` on the pull request
and `33370501611` on the branch head, both `success`, every stage executing — format, lint,
typecheck, unit, `check:specs`, the compose stack, integration, build, `check:openapi`,
`check:registry`, Playwright install and 5 E2E tests. Run **`33370854350`** on `main` after the
merge also concluded `success`. **Nothing on this branch is now unproven
outside this machine**, which was the gap Tasks 6 and 7 had carried.

**The compose Postgres privilege drift has cleared.**
`has_schema_privilege('sentinel_app','public','USAGE')` now returns `t` where Task 7 measured `f`
twice, and **all eight migrations are applied** — the six from Phase 1 and Task 1, plus this
task's two. The real application can reach the database on this
machine again, which is what let this task's integration suite exercise the endpoints end to end.

**Task 9 evidence, 2026-08-31 at the branch head after the fix round and the second review.** Every
command re-run by the orchestrator on the finished tree rather than taken from an implementer's
report, exit codes captured outside a pipe. Task 8 was re-verified the same way before Task 9 began
— all ten commands exit 0 at the numbers its own table records.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **81 files / 1279 tests**, up from 76 / 1120 at Task 8. |
| `pnpm check:specs` | 0 | 99 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **18 files / 286 tests** against real Postgres 16 and real Redis, up from 17 / 230. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:secrets` | 0 | No credential-shaped literal in a committed file. |
| `pnpm check:openapi` | 0 | Byte-identical, and **10 routes** where Task 8 published 7. |
| `pnpm check:registry` | 0 | 15 models, unchanged — Task 9 added no table and **opened no migration**. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row: `git diff --stat main..HEAD` is empty for both
`apps/web` and `packages/ui`, so nothing this task changed can reach a rendered page.

What that table licenses and nothing more: six endpoints exist and behave as their specs pin them,
against a real database. **It says nothing about authorization**, because there is none — every
route Task 9 ships is `@Public()` or `@AuthenticatedOnly()`, and `permissions: []` is what the
session document returns.

**What Task 9 delivered.** `POST /auth/login` returning either a session cookie plus a derived CSRF
cookie or `{ mfaRequired: true, pendingToken }`; `POST /auth/logout` at 204, revoking the row and
tombstoning the cache entry; `GET /auth/session` carrying the user, the active organisation, an
empty permission set and an entitlements placeholder. A per-account lockout ladder — 1, 5, 15 then
30 minutes — on the columns Task 1 created, with **no migration**. Failed logins audited into
`PlatformAuditEvent` including attempts against addresses that have no account, which is the
enumeration-sweep signal Task 8 could not write because its refusal rolled the transaction back. A
new `failedLoginBurst` notice, and a cross-site guard covering the login route `CsrfGuard` cannot.

**`ACCOUNT_LOCKED` is returned only when the password was otherwise correct**, which the plan did
not specify. Answering it to any attempt on a locked account would confirm an address is registered
to exactly the caller who has just proved they will make five attempts; wrong password on a locked
account is `INVALID_CREDENTIALS`, byte-identical to every other failure.

**Two Highs, and both were invisible to a fully green gate.** The lockout ladder did not count
concurrent attempts: five parallel wrong passwords left the counter at **1**, no lock, no audit row
and no notice, with a correct password afterwards answering 200 — because every lockout test in both
lanes was sequential. And the unfamiliar-sign-in notice rendered the signing-in party's `User-Agent`
to the victim under a footer promising no link, which is **the same defect for the third time in
three tasks**. The second was closed by withdrawing ruling 63's carve-out rather than patching the
template: no notice renders a user agent now.

**The fix round was reviewed by a second fresh agent — the step Task 8 skipped, and the reason it
shipped an open High.** That review returned 8 findings closed, 4 closed with caveats, **0 open**,
and 5 of its own. One caveat was a real defect: the **success** path carried H1's shape one arm
over, erasing a lock a sibling had just committed. All five are closed.

**Two of the orchestrator's own written claims were measured false by the agents it briefed.** The
brief's instruction for proving the organisation lookup would have shipped a lookup returning `null`
in production with a green test, because the integration harness connects as the schema owner and
bypasses RLS; and a disposition asserted that an IP address "cannot carry a URL", which was true of
`request.ip` and false of the rendered line. Both are carry-forward rulings 75 and 72.

**A gap this task owns and did not close.** ADR-0014 says a credential stored at weaker parameters
is rehashed transparently "on next successful login", and login is the caller that clause names.
`PasswordService.verify` returns `needsRehash` and nothing acts on it. That also leaves
carry-forward ruling 24 open by construction: rehash-on-login is what would migrate old hashes, so a
parameter raise opens the timing oracle and never closes it. **Task 10 is the natural owner** — it
already writes credentials — but it is Task 9's debt.

**One review finding is accepted rather than fixed**: the burst notice's SMTP send happens inside
the request, which is ruling 68's timing oracle on a new endpoint and is not closable before the
Phase 4 queue. It is named in `security/authentication.md` §2 and §7 rather than left implicit.

**Task 9 was merged to `main` on 2026-08-31 as PR #17** (rebase, branch deleted), with CI green on
a Linux runner before the merge: runs `33427279769` on the pull request and `33427247840` on the
branch head, both `success`, every stage executing — format, lint, typecheck, unit, `check:specs`,
the compose stack, integration, build, `check:openapi`, `check:registry`, Playwright install and the
E2E tests. Nothing on this branch is unproven outside this machine.

All findings and dispositions:
[`docs/superpowers/ledger/phase-2/task-09/`](../../docs/superpowers/ledger/phase-2/task-09/).

**Task 10 evidence, 2026-08-31 at the branch head after the fix round, its second review, and the
orchestrator's fixes for that review.** Every command re-run by the orchestrator on the finished
tree, exit codes captured outside a pipe. Task 9 was re-verified the same way on `main` **after its
rebase** before Task 10 began — a branch that was green is a claim about a tree that no longer
exists once its commits are replayed.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks. |
| `pnpm typecheck` | 0 | 14 tasks. The types compile — and nothing about behaviour. |
| `pnpm test` | 0 | **83 files / 1363 tests**, up from 81 / 1279 at Task 9. |
| `pnpm check:specs` | 0 | 102 spec files, each claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | **19 files / 325 tests** against real Postgres 16 and real Redis, up from 18 / 286. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:secrets` | 0 | No credential-shaped literal in a committed file. |
| `pnpm check:openapi` | 0 | Byte-identical, and **13 routes** where Task 9 published 10. |
| `pnpm check:registry` | 0 | 15 models, unchanged — Task 10 added no table and **opened no migration**. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)`. |

`pnpm test:e2e` was **not run** and has no row: `git diff --stat main..HEAD` is empty for both
`apps/web` and `packages/ui`.

**What Task 10 delivered.** `POST /auth/forgot-password` answering identically for an unknown
address, an unverified one and an active one; `POST /auth/reset-password` consuming the token,
breach-checking and hashing the new password and revoking **every** session; `POST /auth/change-password`
requiring the current password, revoking every **other** session and rotating the one in hand. Audit
rows for all three, two new rate-limit classes written into `abuse-prevention.md` §1 as decisions
rather than transcriptions, and the transparent Argon2 rehash on login that ADR-0014 has specified
since Phase 1 and that Task 9 shipped login without.

**The High was a session that survived the reset meant to kill it.** A login racing a completed
password reset kept a fully privileged session minted with the **old** password — 25 of 25 survivors
across five rounds, each lasting up to 30 days, on the endpoint whose entire purpose is evicting the
party who knows that password. Writing the new hash before revoking narrows that window and does not
close it, because `updateMany` cannot revoke a session row that does not exist yet. The fix is on the
login path: after issuing a session, re-read the credential and revoke the session just issued if it
moved. The second reviewer measured **0 survivors** against 16 with the check disabled.

**Ruling 70 is closed after three tasks and five channels**, and the fifth was found in the registry
this task had just declared closed: the invitation rendered the **inviter's** stored display name
into the text part of a message carrying a live token link, invisible to both ruling-70 test blocks
because one made only the recipient's name hostile and the other ran over notices only. A sixth
channel — the organisation name — is characterised and bounded rather than closed, and binds Task 13.

**The second review of the fix round found 2 Medium and 3 Low that a single review would not have.**
The sentence explaining the High's fix named the wrong mechanism, and the control doing the real work
had no test at all — deleting it refused three of four concurrent correct-password sign-ins during a
parameter migration, with the whole suite green. The burst notice's "once per burst" guarantee was
defeated by concurrency, which is the same defect class as Task 9's High, recurring **inside the fix
round for a finding whose own dispositions cite it**.

**Three claims of the orchestrator's were measured false by the agents it briefed**, including one
quoted from `session.service.ts`'s own docblock — so it was false in the codebase before the brief
repeated it. All three are corrected at the site and in the rulings register.

**Two things are deliberately not fixed and are recorded instead.** A reset for an account with no
credential row sets a password, which keeps SSO-only accounts from being stranded today and is a
Phase 11 bypass once `IdentityProviderLink` accounts exist. And the reset's credential predicate is
covered by a probe that cannot deterministically fail — the kill is a distribution at roughly one run
in twenty-five — so the docblock says plainly that deleting the predicate does not turn it red.

**The last two commits on this branch were written by the orchestrator and reviewed by nobody.**
They close the second review's five findings, each test-first with the mutation re-run, but that is
the author checking their own work.

**Task 10 was merged to `main` on 2026-09-01 as PR #19** (rebase, branch deleted), with CI green on
a Linux runner before the merge: runs `33541294585` and `33541330475`, both `success`. The
pull-request run failed once on `Failed to connect to Reaper` — Testcontainers' Ryuk cleanup
container failing to start, in a Phase 1 spec, with the other run on the same commit passing all 19
files — and was green on a re-run of the failed job alone.

All findings and dispositions:
[`docs/superpowers/ledger/phase-2/task-10/`](../../docs/superpowers/ledger/phase-2/task-10/).

**Checkpoint A falls after Task 12** — the identity API enforced end to end with no UI. At that
point the branch is pushed, CI must be green on a Linux runner, and this file gets an evidence
table moving Phase 2 to **Partially Implemented** with the gap named: no authentication UI, so the
E2E journey criterion is unmet. Twelve tasks is the largest unrecorded window in the plan and the
checkpoint exists to close it.

**How Phase 2 is executed, decided by the operator on 2026-08-24** and binding on every task
(protocol in the plan's *Execution protocol* section):

- **One session per task**, each starting with `sentinel-phase` and verifying **the previous task
  only** — Phase 1's exit criteria are proven above and do not need repeating per task. A fresh
  session that cannot pick up Task N from the committed record is a documentation defect found
  early rather than in Phase 7.
- **Execution mode varies by task shape**, because Phase 2 is a chain where Phase 1 was a set of
  independent packages. Fresh implementer plus adversarial reviewer for the self-contained tasks
  (1, 3, 4, 5, 11); one implementer across each chained run (6→7, 9→10, 13→15, 16→17), since a
  cold agent re-invents conventions rather than inheriting them; the orchestrator takes the two
  gates (12, 18). **The reviewer is fresh for every task in every mode.**
- **Implementers report commands and exit codes, not prose.** No status sentences, no `roadmap.md`
  edits, no `.claude/` narrative from an implementer — the orchestrator writes every sentence that
  asserts anything. And **the reviewer's first pass is citation, not code**: re-verify every claim
  against the repository before opening a diff. Both rules exist because Phase 1's recurring
  defect was never the commands, it was the sentences written about them.
- **Ledgers are committed and never gitignored**, one folder per phase under
  [`docs/superpowers/ledger/`](../../docs/superpowers/ledger/) — `phase-1/` and `phase-2/` today.
  Phase 1's was recovered out of gitignored `.superpowers/` on 2026-08-24; `.superpowers/` itself
  stays ignored as the subagent tooling's scratch space, and anything written there that belongs in
  the record is moved into the phase folder as part of the task. The safeguard that makes a
  committed ledger safe rather than a second source of false claims: **a ledger entry never moves a
  status and is never cited as evidence that something works.** This file, backed by captured
  command output, remains the only authority on status.
- **Every migration is generated with `prisma migrate dev --create-only` and its SQL reviewed by
  the operator before it is applied.** Task 1 is why this matters immediately: Prisma cannot detect
  a column rename and will emit `DROP COLUMN` + `ADD COLUMN` for `Session.expiresAt` →
  `idleExpiresAt`, which is data loss wearing a rename's name, and it cannot express the partial
  unique index at all. Both statements are hand-written into the generated file.
- **Documentation ships in the task that makes it false**, not in Task 18. Each task in the plan
  carries a *Doc ownership* line; Task 18 audits that they were honoured rather than doing the
  work itself.

**Six decisions were taken before the plan was written**, four of them by the operator:

| Decision | Choice | ADR |
|---|---|---|
| Argon2 implementation | `@node-rs/argon2` — prebuilt Rust/napi binaries, no node-gyp on Windows or CI | 0014, owed by Task 3 |
| Password breach check | Real HIBP k-anonymity client, env-flagged, off in test, **fails open** | 0015, owed by Task 3 |
| Email delivery | Mailer port with an SMTP adapter against Mailpit; Resend deferred to the first staging deploy | 0016, **written** in Task 5 |
| Web↔API credentials | Explicit CORS allowlist with `credentials: true`, not a Next-side proxy | 0017, owed by Task 7 |
| Pending MFA credential | A `Session` row in `PENDING_MFA` status, not a Redis-only token | 0018, owed by Task 11 |
| Journey UI scope | Full — register, verify, login, MFA, reset, org switcher, `/settings/security`. The exit criterion says E2E, and there is no E2E without screens | — |

**Both Phase 1 residuals landed in Task 1 on 2026-08-25**, and one of them turned out to be
larger than it was recorded as.

`packages/db/src/id.ts`'s docstring example is fixed — the old one had a 25-character body where
`ID_BODY_LENGTH` is 26 and contained `U`, `I` and `O`, so `parseIdPrefix()` returned `undefined`
for the file's own example. `id.spec.ts` now reads `id.ts`'s source and parses every backticked
example in it, so a copy in the spec cannot drift from the docstring.

`Membership`'s full unique index over a soft-deleting table is replaced by a **partial** unique
index, `WHERE "deletedAt" IS NULL`, and the `KNOWN ISSUE` comment that described it is gone. The
larger part: an adversarial review showed the partial index alone **did not** enforce the invariant
its own comments claimed, because `deletedAt` and `status` were uncorrelated — two rows for one
`(organizationId, userId)` could both be `status = 'ACTIVE'` if one carried a `deletedAt`, so an
authorization query written the natural way would see two roles. Migration A therefore also carries
`CHECK (("deletedAt" IS NULL) = (status <> 'REMOVED'))`, making removed and soft-deleted the same
fact. **The constraint turned two pre-existing Phase 1 integration tests red on the first run** —
both wrote `status: 'REMOVED'` without `deletedAt`, which was always semantically wrong and which
nothing could detect until the invariant was written down.

**API keys are deliberately not in Phase 2.** The `Principal` union defines the `apiKey` arm so
downstream guards are written once, but no key is issued, accepted, or stored in this phase.

### Phase 3 — SaaS core
Projects, assets, **asset ownership verification**, scope and scope rules with the
evaluation engine, the **global deny list**, tags, search, notifications, the append-only
audit log.

*Exit:* an unverified asset cannot be scheduled; scope evaluation passes its table-driven
suite; the cross-tenant isolation matrix passes for every resource; audit events are written
transactionally and cannot be updated or deleted.

### Phase 4 — Execution platform
BullMQ queues, worker orchestration, container isolation, job lifecycle with retry/timeout/
cancellation, worker-side re-validation, SSRF-guarded HTTP client, progress, SSE realtime,
worker health and metrics.

*Exit:* a scan runs end to end against a controlled local target; cancellation stops it;
timeout is enforced; an engine container provably cannot reach the database, Redis, storage,
or metadata endpoints; scope narrowed after enqueue is refused by the worker.

### Phase 5 — Web security engine
Real checks (security headers, TLS, cookies, CORS, information disclosure, open redirect,
technology fingerprinting, and further checks per
[`../scanners/architecture.md`](../scanners/architecture.md)); normalisation; verification;
fingerprinting and deduplication; evidence capture and storage; risk scoring; findings UI.

*Exit:* scanning a deliberately vulnerable local target produces true findings with real
evidence; a rescan deduplicates rather than duplicating; no fabricated results anywhere.

### Phase 6 — API security engine
OpenAPI/Swagger import, endpoint and parameter discovery, authenticated scanning, BOLA/IDOR
workflows, injection, SSRF, rate-limit checks, API inventory.

### Phase 7 — Pentest workspace
Engagements, engagement scope, methodology and test cases, manual findings, evidence upload,
assignment, comments, retests with `PASSED`/`FAILED`/`INCONCLUSIVE`, timeline.

### Phase 8 — Reports
Technical, executive, and retest reports generated from live data as real downloadable PDF
and HTML, queued and stored in object storage with authorised download.

### Phase 9 — Integrations
Outbound webhooks with signing, retry, backoff and delivery logs; GitHub, Jira, Slack;
integration framework decoupled from domain logic.

### Phase 10 — Billing
Stripe checkout, subscription lifecycle, webhook-driven state, entitlement projection,
usage metering, invoices, upgrade/downgrade/cancel, payment failure handling.

### Phase 11 — Enterprise
SAML/OIDC SSO, SCIM, custom roles, advanced audit, configurable retention, Terraform IaC,
platform administration.

### Phase 12 — Additional engines
SAST, dependency, container, cloud, network, mobile, LLM, performance, accessibility —
each behind the same engine contract.

## MVP definition

The smallest thing worth charging for is **Phases 1–5 plus 8**: a customer can register,
verify, create an organisation and project, register and verify an asset, define scope, run
a real web security scan, review real findings with real evidence, and generate a real
report. Phases 6, 7, 9, and 10 make it a business; 11 and 12 make it an enterprise product.
