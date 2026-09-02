# Task 12 fix round — dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Orchestrator, 2026-09-02, against [`review.md`](review.md). **1 High, 7 Mediums, 8 Lows.**

**Every High and Medium is closed. Three Lows are recorded as owed rather than fixed**, because
each needs a change outside this task; three are fixed; two are accepted with the limit stated.

**This fix round has not itself been reviewed** — the author checking their own work, the same
status Task 10's and Task 11's carried into the tasks that followed them. Task 13's reviewer may
treat it as unexamined.

---

## High

### H-1 — `MfaEnrolmentGuard` was an opt-out control with an empty exemption list — **FIXED**

Accepted in full, including the severity. The reviewer is right that this is the worst kind of
latent defect: total account lockout, one row away, held by no test, and predicted word for word
by the docblock sitting above it.

**Not fixed by decorating the six handlers.** That was the obvious repair and it is the wrong
one — it makes the safety of the control depend on somebody remembering to decorate every route a
locked-out member needs, which is the failure mode this branch's ledger is a list of. The guard
now acts **only on a route that declares a permission**. Under `security/authorization.md` §1
authorization is the triple (user, organisation, permission), so a route that acts within an
organisation is exactly a route that declares one — which is the set §5's "before any other
action" means. A member with no factor keeps enrolment, logout, their session document and Task
13's organisation switching, and can do nothing in the organisation itself.

`@AllowWithoutMfaEnrolment()` survives for what this cannot cover: a *permission-guarded* route
that must stay reachable without a factor. There is none, and the spec now asserts that.

**Second half — it read `request.activeOrganizationId` rather than `request.tenant`.** Fixed. The
raw column says which organisation the cookie points at and nothing about membership; reading it
applied an organisation's policy to somebody whose membership had not resolved.

**Mutation-checked, because a fix nobody tried to break is a claim:**

| Mutation | Result |
|---|---|
| the permission gate removed | 2 red — the `@AuthenticatedOnly()` and `@Public()` cases |
| reverted to reading `activeOrganizationId` | 3 red |

`require-mfa.spec.ts`'s fixture now carries a `permission` declaration by default, because after
this fix a fixture declaring nothing would pass through the first early return and every
assertion in the file would be vacuous — carry-forward ruling 58's shape.

---

## Medium

### M-1 — unordered membership read over a multi-row set — **FIXED**

Accepted. `(organizationId, userId)` is unique only where `deletedAt IS NULL`, so a
removed-then-re-added member has several rows and `findFirst` with no predicate and no `orderBy`
may return a `REMOVED` one — which resolves as `not-a-member`, a silent non-deterministic 404 for
a member who is active.

Fixed with `where: { …, deletedAt: null }` rather than an `orderBy`: the partial unique index then
guarantees at most one matching row, so there is nothing left to disambiguate, and the CHECK
constraint means a live `REMOVED` row cannot exist to be hidden. `INVITED` is inside the predicate
and is still judged by `resolveTenant`.

**The comment defending the omission was false and is replaced.** It said `deletedAt` was left out
because filtering on both would be "filtering on one fact twice"; the query filtered on neither.

**The regression test did not bite on its first attempt, and that is worth more than the fix.**
The first version inserted the removed rows *after* the live one, with a comment claiming that was
the arrangement least likely to catch the defect by luck. The opposite is true — with no
`ORDER BY` Postgres seq-scans a small table in physical order, so the live row came back first and
the mutated resolver answered 200. Rewritten to remove-then-re-add, which puts the live row last,
it fails on the mutated resolver with `expected 404 to be 200`. Carry-forward ruling 88, and new
ruling 100.

### M-2 — the matrix ran one of four arms — **FIXED**

Accepted, and the reviewer's proof (add a `@RequirePermission()` route, watch it pass on 401-only
coverage) is the right way to have found it.

All four arms are now written: 401 anonymous, 403 for a role that lacks the permission, 404 for a
member of a different tenant, and admitted for a role that holds it. The roles are computed from
`ROLE_PERMISSIONS` rather than hard-coded, so a new permission needs no edit; for a permission
every role holds, the 403 arm is recorded as *evaluated and inapplicable* rather than skipped.

**Coverage is now asserted per (route, arm)**, so a guarded route reached by one probe fails the
same way an unexercised route does. Verified both directions: with a real guarded route added, all
four arms ran and the per-arm assertion passed; with arm 2 made to `continue`, it went red.

**The sentinel no longer invites deletion.** `there are none yet` used to assert an empty set and
nothing else, so on the day it went red the cheapest way out was to delete it. It now throws with
a message naming what has to replace it.

**One limit, recorded rather than papered over.** `callAs` sends the session cookie and no CSRF
token, so an *unsafe* guarded route would be refused by `CsrfGuard` before authorization ran, and
arms 2 and 4 would report the wrong reason. The first guarded route Task 13 ships is a `GET`;
whoever ships an unsafe one has to teach the helper to mint a CSRF pair. Stated in the file.

### M-3 — ruling 97's caveat is false — **FIXED**

Accepted without qualification. This is the exact class the brief told the reviewer to attack, and
it was mine. The honest split is **7 survivors by fail-closed construction, 1 expecting a 200, 1
outside the mutation's reach entirely**. Ruling 97 now says so and lists them; `roadmap.md` and
`report.md` carry the correction.

A caveat about a mutation score is a claim, and claims get enumerated.

### M-4 — "both specs assert the registration plus the absence of any decorated handler" — **FIXED**

Accepted. It was true of `email-verified.guard.spec.ts` and false of `require-mfa.spec.ts`, in
four places, and it is the sentence that would have made a reader believe H-1 was held by a test.

Corrected in all four, and — more usefully — made true: `require-mfa.spec.ts` now asserts that no
shipped controller declares a permission, which is what bounds what the guard can refuse after
H-1's fix.

### M-5 — three docblocks cite `roles.integration.spec.ts`, which has never existed — **FIXED**

Accepted. The assertion is real and lives in `authorization.integration.spec.ts`. All three
citations corrected. In `authorization.guard.ts` this was load-bearing: the citation is what makes
a two-sources-for-one-fact design safe, so a reader who opened the named file would have concluded
the drift was open.

### M-6 — opt-in and opt-out conflated as "governs zero routes" — **FIXED**

Accepted, and after H-1 the distinction is the whole point rather than a nicety.
`EmailVerifiedGuard` governs nothing because nothing opted in; `MfaEnrolmentGuard` governs nothing
because no route declares a permission. Both structural, both held by tests, different facts.
Corrected in `report.md`, `progress.md` and `roadmap.md`.

Also accepted: "three previously-unregistered guards" miscounted `EntitlementGuard`, which was not
unregistered — it did not exist.

### M-7 — commit `7540279` introduced a false arithmetic sentence — **FIXED**

Accepted, and verified against the config rather than the review:
`rate-limit.config.ts:74-75` is `perPrincipal { limit: 5, windowSeconds: 900 }` and
`perIp { limit: 20, windowSeconds: 900 }`. So five per fifteen minutes is **twenty** an hour, 5 × 5
is 25 rather than 100, and the bounding limit is the account-keyed one while "address" reads as IP
elsewhere in the paragraph. The conclusion — 100 attempts/hour, about 4.6 months — was right and
every step shown to reach it was wrong.

Fixed in `security/abuse-prevention.md` and in the `rate-limit.config.ts` comment. **Both the
wrong sentence and the one it was correcting are left on the record**, because a false sentence
introduced while correcting a false sentence, twice in this phase, is worth more as a pattern than
either fix.

---

## Low

| # | Disposition |
|---|---|
| L-1 | **FIXED.** Mutation 3 is 8 red across both lanes, not 4; mutation 5 is 2 red, not 1. Corrected in `report.md` and `roadmap.md`. |
| L-2 | **FIXED, both halves.** `require-mfa.spec.ts` now asserts registration against `Reflect.getMetadata('providers', AppModule)` rather than `toContain` over source text, which an import satisfied. And `app.module.spec.ts`'s ordering assertions go through `positionOf`, which throws on `-1` — `indexOf(A) < indexOf(B)` was vacuously true whenever A was absent, which the reviewer demonstrated by deleting a provider. New ruling 103. |
| L-3 | **FIXED.** The controller glob is pinned to 3 rather than `> 0`; a glob finding 1 of 3 would have satisfied the old assertion. |
| L-4 | **OWED, not fixed.** `Session.activeOrganizationId` has no foreign key. Needs a migration, and the operator reviews migration SQL before it is applied (plan §5) — so this belongs to **Task 13**, the task that starts writing the column. Recorded in `roadmap.md`. |
| L-5 | **FIXED.** Ruling 96 now records both out-of-band preconditions: the `sentinel_app` role *and* the database being called `sentinel`, which the init script hard-codes. |
| L-6 | **ACCEPTED, wording softened.** "Ignored rather than authorised" is not an observable distinction for a fourth `AccessDeclaration` arm — both guards `return true` and the boot assertion only rejects `undefined`. The test does discriminate between the two implementations, so it is not vacuous; the docblock's reassurance was stronger than what the code buys, and no longer claims more. |
| L-7 | **OWED, and it binds Task 13.** Two readers of `activeOrganizationId` with different freshness — `AuthenticationGuard` through the Redis session cache, `SessionDocumentService` fresh from Postgres. Both `null` today. Once Task 13 writes the column, an in-place `UPDATE` would let `GET /auth/session` report the new organisation beside a permission set resolved for the old one, for up to `SESSION_CACHE_TTL_SECONDS`. The remedy is to switch organisations through `SessionService.rotate`, which poisons the cache and already carries the column. Recorded in `roadmap.md`. |
| L-8 | **ACCEPTED, limit stated.** Byte-identity compares header names plus `content-type`, not every header value — `date` and `x-request-id` would make that flaky. The plan asks for "same headers"; what is asserted is narrower and now says so. |

---

## One claim the reviewer verified that was still wrong

`f4ddb4b`'s commit message said "five more broken links remain, all in phase-1 ledger entries and
the phase-1 plan", and the review's verdict table confirms it: "link-checked all 199 tracked `.md`
files: exactly 5 broken". **Both are wrong, and wrong the same way** — the checker did not skip
fenced code blocks, so two of the five are the literal `| [0011](ADR-0011-...) |` rows inside a
```` ```markdown ```` block in the phase-1 plan, which are content for `.claude/decisions/README.md`
and resolve correctly there.

Three were real: a `../../../` from a directory five levels below the root. Fixed, and the
repository now has zero broken relative markdown links.

Recorded as ruling 104, because it is the first claim in this phase that a second pair of eyes
independently reproduced **and it was still false**. Reproducing a number with the same method is
not verification.

## What the reviewer could not verify, and what I did about it

The review lists six. Three describe trees that no longer exist (the two build-time defects, and
`7540279`'s intermediate measurements) and are unfalsifiable now — correctly identified as such,
and the *end states* were verified. One is a record of a conversation (the operator's no-cache
decision) and nothing in the repository can confirm it; what shipped matches what is described.

**One is worth acting on:** the Task 11 baselines attributed to `a0b2963` (88 files / 1513 tests,
108 spec files, 20 / 354) were not independently re-measured, because doing so means checking out
that commit and re-running three lanes. They came from this session's own verification run before
any Task 12 code existed, and the deltas are consistent. Not disputed, not re-measured, and now
recorded as such rather than left implicit.

The sixth — whether Task 12's execution mode was legitimately the orchestrator's — is answered by
the plan's execution-mode table, which puts tasks 12 and 18 in the "Gate" row.
