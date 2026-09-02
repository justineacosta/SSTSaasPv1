# Task 12 — tenant resolution and the authorization guard

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

**Mode:** orchestrator, per the plan's execution-mode table — Task 12 is a *gate*, "where the
security model becomes real". No implementer subagent was dispatched. **No adversarial review has
happened yet**, and the plan requires one for every task in every mode; it is the open item at the
bottom of this file.

**Branch:** `feat/phase-2-task-12-authorization`, cut from `main` at `a0b2963`.
**Commits:** `5460ebf` (code), `543cf0c` (`.claude/` documents), and the roadmap/ledger commit
this file is part of.

**Date:** 2026-09-02.

---

## 1. What was verified before building

Per the plan's protocol, **the previous task only**. Task 11 re-verified on `main` at `a0b2963`,
every command re-run by the orchestrator with the exit code captured outside a pipe:

| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm test` | 0 | 88 files / 1513 tests |
| `pnpm check:specs` | 0 | 108 spec files |
| `pnpm check:openapi` | 0 | 18 routes |
| `pnpm check:registry` | 0 | 15 models |
| `pnpm test:integration` | 0 | 20 files / 354 tests |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)` |

The Blocked table was checked: the only entry is Terraform, which is Phase 11. Nothing had
cleared and nothing needed correcting.

**A note on that first run, because it is the kind of thing this ledger exists for.** The very
first attempt to capture the cheap lane redirected into `$TMPDIR/gate-cheap.txt` with `TMPDIR`
unset, so the shell wrote `/gate-cheap.txt`, was refused with `Permission denied`, and the loop
never executed — while the wrapper's trailing `echo` made the background task report **exit 0**.
The evidence above is from the re-run. A green exit code from a command whose output you have not
read is not evidence.

---

## 2. The one decision put to the operator

The plan's Task 12 asks for "a permission cache invalidated **on write, not on a timer**".

Presented as three options with a recommendation. The operator chose **no cache — one query per
request**, on 2026-09-02.

The argument for it: `product/permissions.md` invariant 4 is a *correctness* requirement, and a
cache satisfies it only for as long as every future writer remembers to call `invalidate()`.
Task 14's role change and Task 15's invitation acceptance are both unwritten. Reading the
membership, its role and the seeded grants fresh makes the invariant **structural** — there is
nothing to invalidate. This branch's ledger is a list of what happens to invariants maintained by
remembering: rulings 51 and 82 are the same shape twice, each proved wrong by measurement.

The cost is one indexed statement pair inside one tenant transaction, paid only when the session
names an organisation — which in Phase 2 is never. Adding a cache later is additive, and would put
the "invalidated on write" clause back into force as a requirement on whoever adds it.

---

## 3. What was built

**The six layers of `security/authorization.md` §2, in order.** New files:

| File | What it is |
|---|---|
| `apps/api/src/common/guards/tenant-context.ts` | Layers 2 and 3. `resolveTenant` is the layer order as a pure function; `TenantContextGuard` applies it. |
| `apps/api/src/common/guards/authorization.guard.ts` | Layer 4. Evaluates `@RequirePermission()` for the first time since Task 7 wrote it. |
| `apps/api/src/common/guards/entitlement.guard.ts` | Layer 6, a Phase 10 stub that admits everything. |
| `apps/api/src/common/decorators/ctx.decorator.ts` | `@Ctx()`, plus `tenantRunnerFor` — the tenant-scoped client, handed over as a runner rather than a client. |
| `apps/api/src/modules/roles/tenant-resolver.store.ts` | The one query, inside `withTenantTransaction`. Also `mfaEnrolmentPolicy`, which discharges Task 11's unprovided `MFA_ENROLMENT_POLICY`. |
| `apps/api/src/modules/roles/roles.module.ts`, `roles.tokens.ts` | Wiring. `@Global()`, because an `APP_GUARD`'s dependencies resolve from the module that declares it. |

**Guard array: four to nine.** Rate limit, authenticate, **tenant resolve**, CSRF, cross-site
refusal, **email verified**, **MFA enrolment**, **authorize**, **entitlement**. Four positions are
decisions and each is asserted separately in `app.module.spec.ts`.

**Three previously-unregistered guards are now registered.** `EmailVerifiedGuard` (Task 8) and
`MfaEnrolmentGuard` (Task 11) both shipped with specs asserting their own absence from every
module. Those specs now assert the registration **plus** the absence of any decorated handler, so
the property they were really protecting — that neither control governs a route yet — is still
held by a test rather than by a sentence.

**Changed behaviour outside the new files:**

- `AuthenticationGuard` now sets `request.activeOrganizationId` from the session row it already
  resolved. It is a fact about the *credential*, not a resolved tenant: it says which organisation
  the cookie is pointed at and nothing about whether the holder may act there. Reading it here
  avoids a second `resolve` per request, and two resolutions that could disagree.
- `SessionDocumentService.forPrincipal` takes the resolved `TenantContext` and reports the real
  permission set, sorted.
- `startAuthHarness` gained `connectAs: 'owner' | 'app'` and `controllers`.
- `seedReferenceData` is exported from `@sentinel/db`.

---

## 4. Evidence

At `543cf0c`. Reproduced in `roadmap.md`'s Checkpoint A section, which is the authority.

| Command | Exit | Notes |
|---|---|---|
| `pnpm format:check` | 0 | |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm test` | 0 | 91 files / 1553 tests (was 88 / 1513) |
| `pnpm check:specs` | 0 | 113 spec files (was 108) |
| `pnpm check:openapi` | 0 | 18 routes, unchanged — **Task 12 shipped no endpoint** |
| `pnpm check:registry` | 0 | 15 models, unchanged — no table, no migration |
| `pnpm build` | 0 | 8 tasks |
| `pnpm test:integration` | 0 | 22 files / 380 tests (was 20 / 354) |
| `pnpm test:e2e` | 0 | 5 passed. Proves only that the Phase 1 smoke specs still pass |
| `docker compose ps` | 0 | all four `Up (healthy)` |
| `prisma migrate deploy`, fresh empty database | 0 | see below |

**The fresh-database run needed the app role, and that is worth recording.** A bare
`postgres:16-alpine` fails at `20260820121229_row_level_security` with
`role "sentinel_app" does not exist` (SQLSTATE 42704). Mounting
`infra/docker/postgres/init/01-app-role.sql` as an init script makes the whole history replay to
`20260901185059_mfa_factor_last_accepted_step` and exit 0. **The migration history is not
self-contained**; a first deploy has to create that role out of band. Not a Task 12 defect — it
has been true since Phase 1 — but this is the first time anything ran the criterion literally
enough to find it.

---

## 5. Mutation testing

Five mutations applied to the finished tree and re-run. A passing suite is not evidence that the
suite would fail.

| Mutation | Result |
|---|---|
| `withTenantTransaction` removed from the tenant resolver | **9 of 18** integration assertions red |
| Membership and organisation-state layers swapped | 1 unit + 1 integration red |
| `AuthorizationGuard` stops denying | 4 red |
| The matrix skips one route | The coverage assertion red |
| A route gains `@RequireVerifiedEmail()` | 1 red |

The first is carry-forward ruling 75 discharged. `authorization.integration.spec.ts` drives the
application as **`sentinel_app`**, not the harness's default schema owner; under the owner that
mutation is invisible, because RLS cannot bite for a superuser.

The nine assertions that survived it are the ones whose expected answer *is* 404 or an empty set —
404 is the fail-closed direction, so a resolver that can see nothing produces the right answer for
the wrong reason. Stated because "9 of 18 red" would otherwise read as broader coverage than it is.

---

## 6. Two defects found while building, both by the same class of check

**The guards were not running, and eighteen assertions passed anyway.** The first version of
`tenant-context.spec.ts` registered its guards with `app.useGlobalGuards()` *after*
`buildGuardedApp` had already called `app.init()`, which is a no-op. Every test passed. It was
caught only because three of them expected a **denial** — including one asserting that two refusals
were byte-identical, which they were, at 200. Carry-forward rulings 58 and 66's family. Fixed by
registering through `APP_GUARD`, and the byte-identity test now asserts the status outright rather
than only its equality.

**A new spec passed alone and failed in the lane.** The authorization matrix reported
`POST /auth/mfa/enroll answered 429, expected 401` under `pnpm test:integration` while passing in
isolation. The rate limiter runs before authentication by design (`architecture/backend.md` §3), so
a spent window pre-empts the 401, and carry-forward ruling 33's shared compose Redis is what spends
it. Fixed by clearing the windows per request — the limiter is not a variable in a suite about
authorization. **Running a new spec on its own is not running it.**

A third, smaller: the first `globSync` in the email-verified spec pointed at the wrong directory
and found zero controller files, which would have made "no route carries the decorator" true
forever. Caught by the `expect(controllers.length).toBeGreaterThan(0)` guard written beside it.

---

## 7. What was deliberately not done

- **No `GET /api/v1/roles`.** The plan lists `modules/roles/*` under Task 12 *and* Task 14, and
  names the endpoint explicitly in **Task 14**. Building it here would have taken Task 14's
  deliverable. The consequence is that the matrix's 403 and cross-tenant-404 arms run over zero
  shipped routes, which is stated in the matrix file, in `roadmap.md` and in
  `security/authorization.md` §10 rather than left for a reader to discover.
- **No `@RequireEntitlement()` decorator.** Phase 10 ships the decorator and its evaluation
  together. A decorator routes could carry while nothing evaluated it is the state
  `@RequirePermission()` was in for five tasks.
- **No audit event on a denial.** `security/audit.md` §4 lists `PERMISSION_DENIED`, and CLAUDE.md
  rule 10 requires an audit event for security-relevant actions. A row per refusal is an unbounded
  write a hostile caller can drive, and the throttling that would bound it does not exist. Owed,
  and it belongs with Phase 3's `/audit-logs`.
- **No ADR.** Judged: the no-cache decision is significant but cheap to reverse, and the layer
  order is `security/authorization.md` §2's, already decided. Both are in the documents they belong
  to and pinned by tests. **This judgement is the operator's to overturn** — if it should be an
  ADR, the one to write is "the effective permission set is read per request".
- **The default harness still connects as the schema owner.** Switching every existing suite to
  `sentinel_app` would change what a dozen specs test, in a change nobody reviewed for that. New
  suites choose deliberately; ruling 75 is now discharged for the suite that needed it and remains
  open for the rest.

---

## 8. Open

**No adversarial review has happened.** The plan requires a fresh reviewer for every task in every
mode, and this task was built by the orchestrator, so nobody has checked this work but its author.
The review should also fold in commit `7540279` — Task 11's fix round, which the Task 11 pause
state records as never reviewed.

**The branch is not pushed and CI has not run.** Checkpoint A's second bullet requires a green run
on a Linux runner, cited by run ID. That has not happened, so the Checkpoint A section in
`roadmap.md` records the local evidence and **does not claim CI**.
