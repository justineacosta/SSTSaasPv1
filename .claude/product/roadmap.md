# Roadmap and current status

**This is the authoritative answer to "what actually works?"** Every other document
describes design. This one describes reality. It is updated at the end of every phase, and
a status is only raised after the functionality has been run and verified — not after the
code was written.

Status vocabulary (specification §79): **Implemented** / **Partially Implemented** /
**Not Implemented** / **Blocked**.

## Current state — 2026-08-22

| Phase | Scope | Status |
|---|---|---|
| **0** | Repository audit, architecture, documentation foundation | **Implemented** |
| 1 | Production foundation | **Implemented** — all four exit criteria proven 2026-08-22 |
| 2 | Identity | **Not Implemented** |
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
**`@RequirePermission()` is still metadata no guard reads** — the authorization guard is
Phase 2 — so declaring a permission records an intention, it does not enforce one.

The OpenAPI document is generated from the route inventory and the Zod contracts, served at
`/api/v1/openapi.json`, and committed as `apps/api/openapi.json`; a test asserts the committed
file is byte-identical to what the code generates. `pnpm check:openapi` now enforces the same
thing in CI's cheap lane, without Postgres.

Rate limiting is built and globally registered — a Redis sliding window over the table in
`security/abuse-prevention.md` §1 — but it limits **nothing today**, and that distinction
matters more than the checkmark. No route carries any limit class: the only routes that exist
are the health probes, and liveness is deliberately exempt from the limiter so that it depends
on no backing service. What Phase 1 delivers
is a control that is correct and tested in advance of the endpoints it will govern, not a
control that is currently governing anything.

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

The execution ledger — every ruling with its cost if wrong, every review finding, per-task
briefs and reports, and the review diffs — lives in
`.superpowers/sdd/2026-08-20-phase-1-foundation/`. **That directory is gitignored and exists
only on the machine that built it.** `progress.md` is the file to read first; it ends with the
current pause state and the carry-forward rulings for Tasks 15–16.

Known outstanding. **None of it blocks Phase 1, which is complete.** All of it is owed to a later
phase or to the operator:

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
