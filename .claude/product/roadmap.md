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
| 1 | Production foundation | **Partially Implemented** |
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
Button, Input, Label, Field and Skeleton are still exercised only by jsdom unit tests, and no
human has judged any of it by eye.

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
tiles, no seeded findings table. **Nothing has been looked at by a human**: the pages are
verified by Playwright (renders in both colour schemes, no console errors, no horizontal
overflow at 375px) and by asserting on returned HTML and headers, which says nothing about
whether the typography and spacing are any good. And **every HTML route is `force-dynamic`**,
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

Nothing is deployed, and no request reaches this code from outside a test or a developer's own
machine — so Phase 1 is Partially Implemented, not Implemented. Nothing in this product runs,
scans, stores, bills, or authenticates for an actual user today.

### Blocked items

| Item | Blocker | Owner |
|---|---|---|
| Go worker engines | **Go toolchain not installed**; deferred by [ADR-0010](../decisions/ADR-0010-engine-contract.md) | Operator, if Go is wanted |
| Terraform IaC execution | **Terraform not installed**; Phase 11 anyway | Operator |

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

#### Where Phase 1 stopped — read this before resuming

Phase 1 is being executed as 16 tasks from
`docs/superpowers/plans/2026-08-20-phase-1-foundation.md`, subagent-driven: a fresh implementer
per task, then a separate adversarial reviewer, then scoped re-reviews per fix round.

**Tasks 1–15 are complete.** Task 15 was implemented, independently reviewed (0 Critical, 3
Important, 6 Minor), and the fix round that corrected all three Importants has been re-reviewed
clean. 1 workspace and CI · 2
`packages/config` · 3 `packages/observability` · 4 compose stack, schema, prefixed UUIDv7 IDs,
first migration · 5 `packages/contracts` · 6 tenant-scoped Prisma client and RLS · 7 seed · 8
`packages/storage` · 9 `apps/api` bootstrap · 10 rate limiting · 11 route-access assertion and
OpenAPI · 12 `packages/ui` tokens and primitives · 13 `apps/web` Next.js shell · 14 CI checks ·
15 the two project skills.

**Task 16 remains:** ADRs, documentation, and the full exit-criteria verification pass.

The execution ledger — every ruling with its cost if wrong, every review finding, per-task
briefs and reports, and the review diffs — lives in
`.superpowers/sdd/2026-08-20-phase-1-foundation/`. **That directory is gitignored and exists
only on the machine that built it.** `progress.md` is the file to read first; it ends with the
current pause state and the carry-forward rulings for Tasks 15–16.

Known outstanding, none of it blocking Task 16:

- **`pnpm test` fails from a clean clone.** This is one of Phase 1's own exit criteria, so it is
  the most important item on this list. Four `apps/api` unit specs (and now one under `scripts/`)
  import workspace packages by name, root `postinstall` runs only `prisma generate` and never a
  build, so the `dist` those imports resolve to does not exist yet. Proved by moving
  `packages/contracts/dist` aside: 7 files fail. CI survives **only** as a side effect — `pnpm lint`
  and `pnpm typecheck` are turbo tasks with `dependsOn: ["^build"]` and happen to run first. The fix
  is roughly one line (a `pretest` that builds, or routing root `test` through turbo), but it is a
  workspace-topology change and deserves its own review rather than riding into a CI-checks task.
  **Owed to Task 16, not suggested.** The failure mode — a gate whose correctness rests on an
  earlier step's task graph — is exactly the rot Task 14 exists to stop.
- **CI's supply-chain policy will red the build again, and time was the only fix last time.**
  Between commits `daf7fd7` and `486fc34` every run died in 30 seconds at
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
