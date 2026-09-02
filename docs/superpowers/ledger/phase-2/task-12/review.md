# Task 12 review — tenant resolution and the authorization guard

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial review, 2026-09-02. Range reviewed: `a0b2963..a52a486` on
`feat/phase-2-task-12-authorization` (five commits: `5460ebf`, `543cf0c`, `81194bf`, `f4ddb4b`,
`a52a486`) **plus** `7540279` on `main`, Task 11's fix round, treated as unexamined.

Everything below was re-run by this reviewer on this workstation, with exit codes captured outside
a pipe. Docker Desktop was running and all four compose services were `Up (healthy)` throughout.
**Every mutation was applied, run, reverted, and the tree confirmed clean with `git status`
afterwards.** No file under `packages/db/prisma/` was touched, so carry-forward ruling 39's
`prisma generate` caveat did not arise.

---

## 1. Verdict table

### Evidence table (report.md §4 / roadmap.md Checkpoint A)

| Claim | Re-run result | Held? |
|---|---|---|
| `pnpm format:check` exit 0 | exit 0 | **Yes** |
| `pnpm lint` exit 0, 14 tasks | exit 0, 14 tasks | **Yes** |
| `pnpm typecheck` exit 0, 14 tasks | exit 0, 14 tasks | **Yes** |
| `pnpm test` exit 0, **91 files / 1553 tests** | exit 0, 91 files / 1553 tests | **Yes** |
| `pnpm check:specs` exit 0, **113 spec files** | exit 0, "113 spec files" | **Yes** |
| `pnpm check:openapi` exit 0, **18 routes** | exit 0, `"routes":18`, byte-identical | **Yes** |
| `pnpm check:registry` exit 0, **15 models** | exit 0, "15 models, 3 tenant-owned, 1 tenant root, 11 global" | **Yes** |
| `pnpm build` exit 0, 8 tasks | exit 0, 8 tasks | **Yes** |
| `pnpm test:integration` exit 0, **22 files / 380 tests** | exit 0, 22 files / 380 tests | **Yes** |
| `pnpm test:e2e` exit 0, **5 passed** | exit 0, 5 passed | **Yes** |
| `docker compose ps` all four healthy | all four `Up (healthy)` | **Yes** |

### The load-bearing prose claims

| Claim | How checked | Held? |
|---|---|---|
| "**No shipped route declares `@RequirePermission()`**" (7+ places) | `grep` over all non-spec sources: `@RequirePermission(` appears on **zero** handlers. `auth.controller.ts` carries 7 `@Public()` + 7 `@AuthenticatedOnly()`; `health.controller.ts` 3 `@Public()`; `openapi.controller.ts` 1 `@Public()` = **18**, matching `check:openapi` | **Yes** |
| "`check:openapi` still reports 18 routes, because Task 12 shipped no endpoint" | ran it | **Yes** |
| Mutation 1 — `withTenantTransaction` removed → **9 of 18** integration assertions red | applied; `9 failed \| 9 passed (18)`; the exact nine named in the report | **Yes** |
| Mutation 2 — layers swapped → **1 unit + 1 integration** red | applied; unit `1 failed \| 17 passed`, integration `1 failed \| 17 passed` | **Yes** |
| Mutation 3 — `AuthorizationGuard` stops denying → **4 red** | applied; **4 red in the unit lane *and* 4 more in the integration lane (8 total)** | **Partly — see L-1** |
| Mutation 4 — matrix skips one route → coverage assertion red | applied; exactly `exercised every route the application registered` red | **Yes** |
| Mutation 5 — a route gains `@RequireVerifiedEmail()` → **1 red** | applied to `POST /auth/logout`; **2 red** (the email-verified spec *and* `auth.controller.spec.ts`'s per-route assertion) | **Partly — see L-1** |
| Ruling 97 / report §5: the 9 survivors of mutation 1 are all "404 or an empty set" | measured the survivor list | **NO — see M-3** |
| `prisma migrate deploy` on a bare `postgres:16-alpine` fails at `20260820121229_row_level_security`, SQLSTATE 42704 | reproduced verbatim on a throwaway container | **Yes** |
| With `01-app-role.sql` mounted the whole history replays, exit 0 | reproduced, exit 0 | **Yes (with an unstated extra precondition — L-5)** |
| "Three previously-unregistered guards are now registered, and all three govern zero routes" | read the code | **NO — see H-1 and M-6** |
| "The two specs that asserted their absence now assert the registration **plus** the absence of any decorated handler" | read both specs | **NO — see M-4** |
| `authorization.integration.spec.ts` drives the application as `sentinel_app` (ruling 75) | `auth-harness.ts:138,152` binds `PRISMA` to `postgres.appUrl`; fixtures use `harness.prisma` (owner). Mutation 1 turning 9 red is the proof it bites | **Yes** |
| `EntitlementGuard.canActivate()` with no parameter satisfies `CanActivate` at runtime | integration suite returns 200 through the real nine-guard array | **Yes** |
| The matrix's "403 and cross-tenant-404 arms" exist and "will begin governing real endpoints without further work the moment one carries the decorator" | added a `@RequirePermission()` route and ran the matrix | **NO — see M-2** |
| `roles.integration.spec.ts` asserts the seeded rows expand to `ROLE_PERMISSIONS` (cited in 3 source files) | **that file does not exist** | **NO — see M-5** |
| `f4ddb4b`: "Five more broken links remain, all in phase-1 ledger entries and the phase-1 plan" | link-checked all 199 tracked `.md` files: exactly 5 broken, all in `phase-1/task-01`, `phase-1/task-05` and the phase-1 plan | **Yes** |
| `7540279`: the H1 advisory lock is what stops two regenerations leaving twenty codes | removed the lock → `expected 20 to be 10`, red on the first run | **Yes** |
| `7540279`: the M1 advisory lock is what stops concurrent enrolment answering 500 | removed the lock → `expected 500 to be less than 500`, red on the first run | **Yes** |
| `7540279` M5: 333,333 guesses at 60/hour is 0.63 years | 333,333 / 60 = 5,555.6 h = 0.634 y | **Yes** |
| `7540279` M5: "Five logins an hour times five attempts each caps an account near 100 attempts/hour" | `login.perPrincipal = { limit: 5, windowSeconds: 900 }` = **20/hour**, and 5 × 5 = 25 | **NO — see M-7** |

---

## 2. Findings

### High

#### H-1 — `MfaEnrolmentGuard` is an **opt-out** control over every authenticated route, and its exemption decorator is applied to zero handlers

**Where:** `apps/api/src/app.module.ts:161` (registration);
`apps/api/src/modules/auth/require-mfa.ts:35-51` (the claim), `:56` (the decorator),
`:134-175` (the guard).

**What is wrong.** Task 12 registered `MfaEnrolmentGuard` globally. Unlike `EmailVerifiedGuard`
— which is opt-**in**, and governs nothing because no handler carries `@RequireVerifiedEmail()` —
`MfaEnrolmentGuard` has no opt-in decorator. It runs on **every** authenticated request and denies
whenever the organisation named by the session sets `requireMfa` and the user has no confirmed
factor. The only escape is `@AllowWithoutMfaEnrolment()`, and:

```
$ grep -rn "AllowWithoutMfaEnrolment" apps/api/src --include=*.ts | grep -v require-mfa
apps/api/src/modules/auth/require-mfa.spec.ts:8,9,76,87,176,193,210     <- the spec only
```

**Zero shipped handlers carry it.** Not `POST /auth/mfa/enroll`, not `POST /auth/mfa/confirm`,
not `POST /auth/logout`, not `GET /auth/session`.

The file's own docblock states the consequence in advance:

> "The exemption is not a convenience, it is what stops the rule bricking the account … A member
> forced into enrolment must still be able to REACH enrolment, sign out, and read their own
> session document. A rule with no exemption refuses the only endpoints that could satisfy it,
> and a control that cannot be complied with is an outage wearing a control's name."
> — `require-mfa.ts:35-41`

That is exactly the state the code is in. The exemption exists as a decorator and is applied to
nothing.

**A second defect in the same guard: it reads the wrong field.** `require-mfa.ts:158` reads
`request.activeOrganizationId` — the raw session column — rather than `request.tenant`. So the
guard applies an organisation's MFA policy to a caller whose **membership did not resolve**. On an
`@AuthenticatedOnly()` route (where `TenantContextGuard` deliberately does not deny), a *removed*
member of an MFA-requiring organisation is refused with 403 `MFA_ENROLMENT_REQUIRED` — the precise
account-bricking that ruling 95 and `tenant-context.ts:171-178` argue the asymmetry prevents. The
asymmetry protects layers 2–4 and is undone one guard later.

**How I proved it.** By reading and grepping — the failure is not reachable today, and that is the
only reason this is latent rather than live. `Organization.requireMfa` cannot be set to `true`
because no endpoint creates an organisation, and `Session.activeOrganizationId` is never written.
**Both of those change in Task 13.** No test holds the property: the spec asserts the decorator's
*mechanics* against purpose-built controllers and asserts the guard is *registered*, and nothing
asserts which shipped handlers are exempt.

**Why High rather than Medium.** The blast radius is total account lockout including the logout
route, the guard is already in the pipeline, the trigger is a single `requireMfa = true` row, no
test would catch it, and no document records the gap — `security/authentication.md` §5 was
rewritten by this task and does not mention the exemption at all.

---

### Medium

#### M-2 — The authorization matrix runs **one** of the four arms, and three documents say it runs four

**Where:** `apps/api/src/common/authorization-matrix.integration.spec.ts:166-200`
(`describe('every permission-guarded route runs the four arms')`);
`.claude/security/authorization.md:226-238` §10; `report.md` §7; `roadmap.md` Checkpoint A.

**What is wrong.** The block named "every permission-guarded route runs the four arms" contains
two `it`s: `there are none yet, and that is recorded rather than implied`, and
`refuses each of them without a credential`. The 403 arm, the cross-tenant-404 arm and the
correct-permission-succeeds arm **are not written**. The matrix docblock says otherwise:

> "the arms exist, they are exercised against purpose-built controllers … and **they will begin
> governing real endpoints without further work the moment one carries the decorator**."
> — `authorization-matrix.integration.spec.ts:33-36`

and `security/authorization.md` §10 says "**The 403 and cross-tenant-404 arms run over zero
shipped routes**", which reads as "the arms are there, the set is empty" rather than "the arms are
not written".

**How I proved it.** I added one `@RequirePermission('organization.read')` route to
`health.controller.ts` and ran the matrix:

```
✓ every non-public route refuses an unauthenticated caller with 401 > refuses each of them
× every permission-guarded route runs the four arms > there are none yet ...
    → expected [ { …(6) } ] to deeply equal []
✓ every permission-guarded route runs the four arms > refuses each of them without a credential
✓ the matrix covers the whole inventory > exercised every route the application registered
Tests  1 failed | 7 passed (8)
```

The new guarded route was exercised by **exactly one arm** (anonymous → 401), the coverage
assertion counted it as covered, and the only failure is the `there are none yet` sentinel — which
is designed to fail on that day and whose natural disposition is deletion. Delete it and Task 13
ships a permission-guarded endpoint with 401-only matrix coverage and a green suite. The exit
criterion the file quotes at the top ("unauthenticated → 401; authenticated without the permission
→ 403; authenticated in a different tenant → 404; correct permission → success", generated "so a
new endpoint gets tests automatically") is met for one quarter of itself.

Reverted; tree clean.

#### M-1 — `tenantResolver` reads one membership row out of a set that may legitimately hold several, with no ordering — and the comment defending it is wrong

**Where:** `apps/api/src/modules/roles/tenant-resolver.store.ts:82-100`.

```ts
const membership = await tx.membership.findFirst({
  where: { organizationId, userId },
  select: { id: true, status: true, role: { ... } },
});
```

No `deletedAt` predicate, no `status` predicate, **no `orderBy`**. The uniqueness constraint is
*partial*:

```
"Membership_organizationId_userId_active_key" UNIQUE, btree ("organizationId","userId")
    WHERE "deletedAt" IS NULL
"Membership_status_deletedAt_agree_check" CHECK (("deletedAt" IS NULL) = (status <> 'REMOVED'))
```

so **any number of `REMOVED` rows may coexist with the one live row** for the same
(organizationId, userId) — which is exactly what Task 14's member removal followed by Task 15's
re-invitation produces. `findFirst` with no `orderBy` emits `… LIMIT 1` with no `ORDER BY`, so
Postgres may return any of them.

**How I proved it.** On a fresh `postgres:16-alpine` with the migration history replayed, I
inserted two `REMOVED` rows and then one `ACTIVE` row for the same pair — all three accepted — and
ran the statement shape `findFirst` emits:

```
   id   | status
--------+---------
 mbr_a1 | ACTIVE
 mbr_r1 | REMOVED
 mbr_r2 | REMOVED
(3 rows)

-- SELECT id,status FROM "Membership" WHERE ... LIMIT 1;
   id   | status
--------+---------
 mbr_r1 | REMOVED     <-- the resolver would read this
```

`isActive: false` → `not-a-member` → **404 on every permission-guarded route for a member who is
active**. The direction is fail-closed, so this is availability and not escalation — but it is a
silent, non-deterministic, total denial for a re-added member, and nothing in the suite covers it
because `authorization.integration.spec.ts`'s `member()` fixture creates exactly one row.

**The comment defending the omission is factually wrong.** `tenant-resolver.store.ts:82-87` says
`deletedAt` is left out because "filtering on both would be filtering on one fact twice". The
query filters on **neither** `deletedAt` nor `status`; there is no "twice". The real consequence —
a multi-row result set with no ordering — is not addressed anywhere.

#### M-3 — Ruling 97's caveat is false: two of the nine survivors are not 404-or-empty, and one expects 200

**Where:** `docs/superpowers/ledger/phase-2/progress.md:747-751` (ruling 97);
`report.md:151` (§5).

> "every one of the survivors expects a 404 or an empty set, and got the right answer for the
> wrong reason."

**How I proved it.** I applied mutation 1 and listed the survivors verbatim:

```
✓ the seeded rows are the authority ... > expands every system role to exactly ROLE_PERMISSIONS
✓ layer 2 — membership > answers 404 for a session pointed at an organisation with no membership
✓ layer 2 — membership > answers 404 for a membership that exists and is not active
✓ layer 2 — membership > answers 404 for a removed member
✓ layer 2 — membership > is byte-identical to the refusal for a session with no organisation
✓ layer 2 — membership > still admits an @AuthenticatedOnly() route for a removed member
✓ layer 3 — organisation state > answers 404, not 403, for a NON-member of a suspended organisation
✓ GET /auth/session ... > reports an empty set for a member of a suspended organisation
✓ GET /auth/session ... > reports an empty set when the session names no organisation
```

Two survivors are not what the caveat says:

- **`expands every system role to exactly ROLE_PERMISSIONS`** issues no HTTP request at all — it
  reads through the owner client and cannot be affected by any mutation of the resolver. It is a
  survivor by irrelevance, not by fail-closed construction.
- **`still admits an @AuthenticatedOnly() route for a removed member`** asserts **200** twice
  (`/api/v1/probe/anyone` and `/api/v1/auth/session`). It expects a success, not a 404 and not an
  empty set.

The brief asked precisely this question and named the consequence: "If any survivor expects a 200,
the caveat is understated and the coverage claim is worse than written." It is. The honest count
is 9 red, 7 survivors by fail-closed construction, 1 survivor expecting a 200, 1 survivor outside
the mutation's reach entirely.

#### M-4 — "the two specs … now assert the registration **plus** the absence of any decorated handler" is false for one of the two

**Where:** `report.md:87`; `progress.md:774`; `.claude/product/roadmap.md:1747`; and the `5460ebf`
commit message ("both specs … assert the registration plus the absence of any decorated handler").
Four places.

`email-verified.guard.spec.ts` does both halves: it reflects over `AppModule`'s providers for the
registration and globs every `*.controller.ts` for `@RequireVerifiedEmail(`. Correct.

`require-mfa.spec.ts:251-279` — the replacement block — contains exactly two `it`s:

```ts
it('is registered as a global guard in app.module.ts', () => {
  expect(read('../../app.module.ts')).toContain('MfaEnrolmentGuard');
});
it('has its DI token provided, so registering it cannot fail at boot', () => {
  expect(read('../roles/roles.module.ts')).toContain('MFA_ENROLMENT_POLICY');
});
```

**Neither asserts the absence of any decorated handler.** There is no such assertion in the file,
and there could not be a useful one of the same shape, because `MfaEnrolmentGuard` has no opt-in
decorator — which is finding H-1. The sentence is not a rounding error: it is the sentence that
would have made a reader believe the property in H-1 was held by a test.

#### M-5 — Three source docblocks cite a spec file that does not exist, as the proof of a security claim

**Where:** `apps/api/src/common/guards/authorization.guard.ts:29`;
`apps/api/src/common/guards/tenant-context.ts:135`;
`apps/api/src/modules/roles/tenant-resolver.store.ts:66`.

All three cite **`roles.integration.spec.ts`** as the assertion that the seeded `RolePermission`
rows expand to exactly `ROLE_PERMISSIONS`. In `authorization.guard.ts` that citation is what makes
the two-sources-for-one-fact design safe ("they cannot disagree, because `roles.integration.spec.ts`
asserts …").

```
$ find . -name "roles.integration.spec.ts" -not -path "*/node_modules/*"
(no output)
```

The assertion is real — it lives at
`apps/api/src/modules/roles/authorization.integration.spec.ts:207`, and I saw it pass. **The
claim is true; the citation is to a file that has never existed**, three times, in the two guards
and the store. A reader who does the thing this repository asks reviewers to do — open the file
named — finds nothing, and the safe reading of that is "the drift is not closed".

#### M-6 — "all three govern zero routes" conflates an opt-in control with an opt-out one

**Where:** `report.md` §3; `progress.md` pause state; `roadmap.md` Checkpoint A ("**Both still
govern zero routes.** No handler carries `@RequireVerifiedEmail()`, and no organisation can be
created to set `requireMfa`").

Those are two different facts wearing one sentence. `EmailVerifiedGuard` governs zero routes
because zero routes opted in — a structural fact, held by a test. `MfaEnrolmentGuard` governs
**every** authenticated route and refuses nobody only because no data exists yet — a fact about
rows, not about wiring, which evaporates on the day Task 13 writes one. `require-mfa.ts:27-33`
states this correctly ("a fact about DATA rather than about WIRING"); the three status documents
flatten it back into "governs zero routes". Given H-1, the flattened version is the one that
matters.

Separately: "**Three previously-unregistered** guards are now registered" (report §3, brief §2)
counts `EntitlementGuard`, which was not previously unregistered — it did not exist before this
task.

#### M-7 — Commit `7540279` introduced a false arithmetic sentence into the security paragraph it was correcting

**Where:** `.claude/security/abuse-prevention.md:231-232`;
`apps/api/src/common/guards/rate-limit.config.ts:235-237`.

> "login is 5 / 15 min per address — **five logins an hour** times five attempts each caps an
> account near 100 attempts/hour"

Two errors in one clause:

1. `rate-limit.config.ts:73-75` sets `login: { perPrincipal: { limit: 5, windowSeconds: 900 }, perIp: { limit: 20, windowSeconds: 900 } }`. Five per **fifteen minutes** is **twenty** logins an hour, not five.
2. The stated multiplication does not produce the stated result: 5 × 5 = 25, not 100. (20 × 5 = 100, which is the figure they wanted and which the downstream "3,333 hours, about 4.6 months" is consistent with.)

The conclusion happens to be right; the working shown is wrong. `abuse-prevention.md` also says
"5 / 15 min per **address**" in a paragraph whose other uses of "address" mean IP — the per-IP
login limit is 20 / 15 min, and the account-keyed limit is the one that does the bounding.

This is the same defect class the commit set out to fix — M5 was "the premises were right and the
division was wrong" — reintroduced in the replacement paragraph, in a security document, with a
block quote above it explaining why a security document's arithmetic matters. Phase 1's pattern of
false sentences introduced while correcting a false sentence, a second time in this phase.

---

### Low

- **L-1 — Two of the five mutation counts are incomplete.** "AuthorizationGuard stops denying → **4 red**" is 4 in the unit lane **and 4 more in the integration lane** (`layer 4 — permission` ×2 and `invariant 4` ×2); the whole-tree figure is 8. "A route gains `@RequireVerifiedEmail()` → **1 red**" is route-dependent: applied to `POST /auth/logout` it is 2 red (`email-verified.guard.spec.ts` plus `auth.controller.spec.ts`'s per-route assertion). Both mutations were caught, so the conclusions stand; the numbers do not, and ruling 97 exists precisely because these numbers get read as coverage.
- **L-2 — `require-mfa.spec.ts:267-269` is satisfied by an import, and one ordering assertion is satisfied by absence.** Its docblock claims the block is what makes "removing [the registration] a failing test rather than a silent loss of the control". **Measured:** I deleted `{ provide: APP_GUARD, useClass: MfaEnrolmentGuard }` from `app.module.ts:161` while leaving the `import` line — `require-mfa.spec.ts` reported **14 passed, exit 0**, because `toContain('MfaEnrolmentGuard')` matches the import. `app.module.spec.ts` did catch it (`3 failed | 6 passed`), so nothing is actually unguarded. But note *which* of its assertions survived: `forces MFA enrolment before it evaluates a permission` **passed with the guard entirely absent**, because `classes.indexOf(MfaEnrolmentGuard)` returns `-1` and `-1 < 6`. Two of the four separately-argued "decision" assertions lean on `indexOf` and are vacuously true when a guard is missing; only `runs the nine stages …` and `registers exactly nine global guards` hold the line. Reverted; tree clean.
- **L-3 — `expect(controllers.length).toBeGreaterThan(0)` does not pin the count.** `email-verified.guard.spec.ts:301` guards against the wrong-directory glob that shipped once, but a glob that found 1 of 3 controllers would still pass. The current glob does find all three (verified). Pinning the count, or asserting the three known controller paths, would close it.
- **L-4 — `Session.activeOrganizationId` has no foreign key.** Verified against the replayed schema: `Session` has exactly one FK, `Session_userId_fkey`. A session may point at a deleted organisation. Behaviour is correct (both reads return nothing → `not-a-member` → 404, fail-closed), and the gap predates Task 12 — but Task 12 is the task that made this column drive tenant resolution, and `CLAUDE.md`'s "database integrity belongs in the database" applies.
- **L-5 — Ruling 96 understates the out-of-band precondition.** `infra/docker/postgres/init/01-app-role.sql` also hard-codes the database name: `GRANT CONNECT ON DATABASE sentinel TO sentinel_app`. My first replay with the script mounted and `POSTGRES_DB=freshdb` failed with `database "sentinel" does not exist`; re-run with `POSTGRES_DB=sentinel` it replayed and exited 0. Ruling 96 says "the role is created out of band"; the script that creates it also assumes a database name. Worth carrying into whatever `.claude/operations/` page ruling 96 asks for.
- **L-6 — "ignored rather than authorised" is not an observable distinction.** `authorization.guard.ts:108` and `tenant-context.ts:269` both `return true` for an unrecognised `AccessDeclaration.kind`, and `access-assertion.ts:23` only rejects `access === undefined`. So a fourth arm would boot and be governed by neither guard — "ignored" and "authorised" are the same outcome for that route. The test at `authorization.guard.spec.ts:233` does discriminate between the two *implementations* (the exclude-public alternative would 404), so it is not vacuous — but the docblock's reassurance is stronger than what the code buys. Matter of degree, not a live defect.
- **L-7 — Two readers of `activeOrganizationId` with different freshness, binding Task 13.** `AuthenticationGuard:205` takes it from `SessionService.resolve`, which may be served from the Redis session cache (`session.service.ts:303,318,343` — the column is inside `cachedSessionSchema`). `SessionDocumentService:103-104` reads it fresh from Postgres via `SessionRepository.findById`. Today both are always `null`. Once Task 13 writes the column, an in-place `UPDATE` (as opposed to `SessionService.rotate`, which poisons the cache and does carry `activeOrganizationId`) would make `GET /auth/session` report the *new* organisation alongside a permission set resolved for the *old* one, for up to `SESSION_CACHE_TTL_SECONDS`. The `AuthenticationGuard` docblock argues this design avoids "a window in which they disagree"; the window moved rather than closed.
- **L-8 — Byte-identity compares header *names*, not values.** `authorization.integration.spec.ts:307` compares `Object.keys(headers).sort()` only; the unit twin (`tenant-context.spec.ts:350-351`) additionally compares `content-type`. Comparing every value would be flaky (`date`, `x-request-id`), so this is a reasonable stopping point — but the plan says "same status, same body, same headers" and what is asserted is "same header names, same content-type". Worth stating as the limit it is.

### Things I attacked and could not break

Stated plainly, because a review that only lists failures is not a measurement.

- **`resolveTenant`'s layer order.** The `activeOrganizationId === null` branch returning
  `no-active-organization` before the membership is correct: the guard passes `membership: null`
  on that path, so no membership can be shadowed. `INVITED` and `REMOVED` are both excluded on
  every path — `isActive` is computed once, at `tenant-resolver.store.ts:117`, as
  `status === 'ACTIVE'`, and there is no other producer of `TenantResolutionInput` outside tests.
- **A membership row violating the `deletedAt`/`status` CHECK.** Cannot exist; the constraint is
  present in the replayed schema and is an equality, not an implication.
- **A session pointed at a deleted organisation.** Both reads return nothing → `not-a-member` →
  404. Fail-closed and in the right order (the caller does not learn the organisation is gone).
- **Can a non-member reach a 403?** Not through `AuthorizationGuard`: `PERMISSION_DENIED` requires
  `request.tenant`, which requires a resolved `ACTIVE` membership, and `TenantContextGuard` (guard
  3) runs before `AuthorizationGuard` (guard 8). Proven by
  `answers 404, not 403, for a NON-member of a suspended organisation`. **But see H-1**:
  `MfaEnrolmentGuard` (guard 7) can 403 a caller whose membership did not resolve, on an
  `@AuthenticatedOnly()` route.
- **The 403 disclosure.** `details` carries `required`, `yourRole`, `rolesWithPermission` and
  nothing else; `all-exceptions.filter.ts:223-226` passes `DomainError.details` through the
  structural `redact()`; `authorization.guard.spec.ts:191` asserts no `usr_`/`mbr_`/`org_` prefix
  appears in the body. `@Ctx()`'s plain `Error` falls to the filter's final arm
  (`{ status: 500, code: INTERNAL_ERROR, message: SERVER_GENERIC_MESSAGE }`) — no leak.
- **Widening the permission set.** `new Set(membership.permissions)` is constructed per request
  inside `resolveTenant`; nothing is shared across requests, and the contract type is
  `ReadonlySet`.
- **`knownPermissions` dropping unknown keys.** I could not construct a case where dropping is
  unsafe: `@RequirePermission()` is typed against `PERMISSIONS`, so an unknown key can never be
  the thing being required. The dangerous direction (a *missing* grant) is covered by the seeded-
  rows assertion — which is real, though mis-cited (M-5).
- **`mfaEnrolmentPolicy` and ruling 9.** `userId` comes from `request.principal.userId`, set only
  by `AuthenticationGuard` from a resolved session. That is the proof ruling 9 asks for, on every
  path — there is no route-parameter path into this port.
- **Guard order and the "database gates after the forgery checks" argument.** Sound as argued, and
  `app.module.spec.ts` asserts each of the four decisions separately rather than only the array.
  `EntitlementGuard.canActivate()` taking no parameter works at runtime (JS ignores extra
  arguments) and is exercised through the real array in the integration lane.
- **Concurrency (rulings 74, 84, 87).** A role change committing during a request lands wholly on
  one side: the resolver's two statements read `Membership` and then the `Role` it named, and
  Phase 2's roles are seeded and immutable, so there is no mixed read. The window is one request
  wide, which is what invariant 4 promises.

---

## 3. Commit `7540279` — Task 11's fix round

Treated as unexamined, as the brief directed. I re-ran its two central fixes as mutations rather
than trusting the pasted transcripts.

**What holds.**

- **H1 (twenty live recovery codes).** Deleting `await this.lockUser(tx, command.userId)` from
  `regenerateRecoveryCodes` turned
  `two concurrent regenerations leave exactly one live set, and every code it returned works` red
  on the **first** run: `expected 20 to be 10`. The rewritten five-round probe is not a
  distribution — it bit immediately. Ruling 88's concern does not apply here.
- **M1 (concurrent enrolment answering 500).** Deleting the lock from `enroll`'s transaction
  turned `two concurrent enrolments never answer 500, and leave exactly one factor` red on the
  first run: `expected 500 to be less than 500`. The in-transaction confirmed-factor re-read at
  `mfa-enrolment.service.ts:119-125` is a genuine second half of that fix, not decoration.
- **The advisory lock's shape.** Taken as the first statement inside each transaction and released
  by commit; every caller does its Argon2 work before opening the transaction, so the lock is never
  held across it. Keyed on the user rather than the factor, correctly, because `enroll` races over
  a row that does not exist. `hashtext()` is 32-bit so unrelated users can collide — that costs
  serialisation, never correctness.
- **L6 (`orderBy` on the recovery-code read).** Now a required field of the port type in
  `mfa.store.ts`, so a caller cannot reintroduce the unordered read by omission. Enforced by
  `typecheck`, which passes.
- **M5's headline arithmetic.** 333,333 expected guesses, 5,556 hours, 0.63 years, ten addresses
  under a month — all correct. The 630-year sentence really was wrong by 1000×.
- **M4 (the eighth notice template).** `sendMfaRecoveryCodesRegenerated` is sent after the commit,
  with no display name in the signature (rulings 44 and 85 respected).
- **L5.** The three `select: { id, email, emailVerifiedAt }` reads are narrowed to
  `select: { email }`, and the decision not to gate on a verified address is recorded at the port
  rather than implied by a discarded column.

**What does not hold.** M-7 above: the replacement paragraph in `abuse-prevention.md` and
`rate-limit.config.ts` contains a new false arithmetic sentence. It is the only defect I found in
this commit, and it is in the same paragraph as the fix.

**One note, not a finding.** `orderBy: { createdAt: 'asc' }` returns the *oldest* ten. If a
double-set ever existed the consumer would honour the superseded set rather than the newest one.
The advisory lock is what prevents a double-set, so this is not reachable — but `desc` would be
the safer tie-break if the ordering is meant as defence in depth rather than determinism.

---

## 4. Claims I could NOT verify, and why

- **"CI is green on a Linux runner."** Not claimed by this task — `roadmap.md` records the absence
  explicitly and correctly. I confirmed the branch is unpushed (`git status` reports no upstream)
  and did not push it.
- **The `pnpm test` / `check:specs` / `test:integration` baselines attributed to Task 11 at
  `a0b2963`** (88 / 1513, 108 spec files, 20 / 354). Verifying these would require checking out
  `a0b2963` and re-running three lanes; I ran everything at `HEAD` instead, where the deltas
  (+3 files/+40 tests, +5 spec files, +2 files/+26 tests) are consistent with what Task 12 added.
  Not disputed — not independently re-measured.
- **Report §6's account of the two defects found *while building*** — the `useGlobalGuards()`
  after `app.init()` no-op (ruling 91) and the 429-preempting-401 lane failure (ruling 92). These
  describe states of the tree that no longer exist. I verified the *fixes*: the byte-identity test
  now asserts `404` outright rather than only equality (`tenant-context.spec.ts:347-348`), the
  guards register through `APP_GUARD`, and `clearRateLimits` is called per request
  (`authorization-matrix.integration.spec.ts:95`). The narratives themselves are unfalsifiable
  now.
- **"The operator chose no cache on 2026-09-02."** A record of a conversation. Nothing in the
  repository can confirm or deny it; I verified only that what shipped matches what is described
  (no cache, one query per request, `permissions.md` invariant 4 rewritten to match).
- **`7540279`'s "16 tests red until four lists knew about it"** and **M3's "3 ms against 370"**.
  Both describe measurements taken on trees that no longer exist. The end states are correct
  (the eighth template is registered; the suite is green).
- **The Phase 2 plan's execution-mode table** naming Task 12 a gate built by the orchestrator. I
  did not open the plan to confirm the mode was legitimately chosen; the brief and report agree on
  it and nothing turns on it for this review.

---

## 5. Tree state at the end of this review

```
$ git status --porcelain
(empty)
```

Five Task 12 mutations, two `7540279` mutations, one exploratory `@RequirePermission()` probe and
one guard-deregistration probe were applied and reverted individually, each followed by
`git checkout --` and a clean `git status`. Final re-runs on the reverted tree: `pnpm test` exit 0, 91 files / 1553 tests;
`pnpm test:integration` exit 0, 22 files / 380 tests. Two throwaway Postgres containers
(`sentinel-review-freshdb*`) were created for the migration and multi-membership probes and removed.
The compose stack was not modified.

Nothing was fixed. Dispositions are the orchestrator's.
