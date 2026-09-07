# Task 15 — the D9 fix round: dispositions, and the brief for the fixer

> **A dated record of what was decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

**Date:** 2026-09-08 · **Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Review:** [`d9-review.md`](d9-review.md) — 1 High, 4 Medium, 6 Low.

## The headline, stated plainly

**The review reproduced the exact escalation this change claims to prevent, on this branch.** A
`create` racing the removal of its own issuer still lands a live `OWNER` invitation, and accepting
it still mints an `OWNER`. Meanwhile six documents had already been rewritten to say the window was
shut, and the test named to warn about it had been renamed.

That ordering is the worst part and it is the orchestrator's fault, not the implementer's:
**ADR-0026 §3 asserted that re-reading the actor's authority inside the transaction closes the
race, and that assertion was wrong.** A re-read makes `create` decide against the database instead
of against the guard — which is a real improvement and worth keeping — but it does not *serialise*
`create` against the membership writes. `withTenantTransaction` passes no isolation level, so this
is READ COMMITTED; `create` takes only the `(organisation, address)` advisory lock; `actorAuthority`
uses a non-locking `findFirst`. A `create` whose re-read runs before the removal commits inserts
its row after the cascade's `findMany` has already looked.

This is carry-forward rulings 82 and 122 for the **fourth** time, and this time the orchestrator
wrote the reasoning into an ADR while citing those very rulings. The lesson is not "check first is
insufficient" — everyone here already knew that. It is that **a re-read is not a lock**, and that
naming the rulings in a docblock is not the same as obeying them.

## Dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 4 | **High** | The race is not closed; escalation reproduced end to end | **FIX — you.** `lockOrganization` in `create`, plus a test that fails without it |
| 1 | Med | Cited test name uses `'`; the real test uses `’`. Grep exit 1 | **FIX — you**, in code. `roadmap.md` is the orchestrator's |
| 5 | Med | `roadmap.md` retitled CLOSED over an unedited present-tense body | **FIX — orchestrator.** Do not touch `roadmap.md` |
| 6 | Med | `.claude/security/audit.md` never updated | **FIX — you** |
| 9 | Med | "a set comparison, never a ranking" asserted four times, tested nowhere | **FIX — you** |
| 2 | Low | Moved docblock says "four inline object literals"; there are seven | **FIX — you** |
| 3 | Low | "no runtime edge from `memberships/` into `invitations/` at all" — there is one | **FIX — you** |
| 7 | Low | Mutation 3's survival credited to RLS; the tenant-scoping extension is what neutralises it | **FIX — you** |
| 8 | Low | Self-removal — the ADR's principal stated cost — has no test | **FIX — you** |
| 10 | Low | `ISSUER_DEMOTED` is written for lateral role changes that are not demotions | **FIX — you** |
| 11 | Low | `actorAuthority` re-reads the role but not the route's own permission | **FIX — you**, the disclosed half only |

Nothing is dismissed. The two items marked orchestrator are `roadmap.md` and the ADR amendment,
because status and decisions are not a fixer's to move.

## What to do, in this order

### 1. Finding 4 — take the organisation lock in `create` (do this first)

`await lockOrganization(tx, ctx.organizationId)` as the **first statement inside `create`'s
transaction**, before `actorAuthority` and before `lockInvitationSlot`.

`lockOrganization` is `SELECT id FROM "Organization" WHERE id = $1 FOR UPDATE`, exported from
`membership.service.ts`, already imported by `invitation.service.ts`, and already taken by
`accept`, `updateRole` and `remove`. Taking it makes `create` the fourth writer in the set those
three already serialise, which is precisely the set that can move a member's authority.

**The lock order is safe and you should confirm it rather than trust this sentence.** Nothing in
the codebase takes `lockInvitationSlot` before `lockOrganization`; `accept` takes only the
organisation lock. So `create` taking organisation-then-slot introduces no cycle. Verify with a
grep of both call sites before you write the line, and say in your report that you did.

**The test must fail without the lock**, and it must not need instrumentation in production code —
the review's `setTimeout` probe was a diagnostic, not a fixture. The shape that works: open one
transaction that takes the organisation lock and holds it, fire `create` concurrently and observe
that it blocks, then let the first transaction perform the real removal and commit, then observe
`create` refuse. Without the lock in `create` that test sees a `201`. Write it, run it red against
the code as it stands now, then add the lock and watch it go green — and record both runs.

State honestly in the report what the test proves: it proves `create` serialises behind a holder
of the organisation lock. If you cannot make it deterministic, say so and say what you did instead.

### 2. Finding 11's disclosed half, while you are in `actorAuthority`

Re-check the route's own permission too: an actor whose live role no longer carries
`organization.manage_members` is refused, not merely one whose membership has gone. With the lock
above, this closes the demotion arm the implementer disclosed — an in-flight `create` by someone
demoted `OWNER`→`MEMBER` landing a `MEMBER` invitation.

**Do not** widen it further. Organisation suspension and `status === 'ACTIVE'` are *not* in scope:
record them in your report as residuals with a sentence each on why they are out.

### 3. Finding 9 — the test that distinguishes a set from a ranking

The review found the counterexample in the seeded data: `ADMIN` issues an `AUDITOR` invitation,
then moves to `SECURITY_LEAD`. `AUDITOR` carries `audit.read` and `billing.read`, which
`SECURITY_LEAD` does not, so the set test revokes and a ranking by permission count would not. Add
it. **Then verify it earns its place**: replace the subset filter with a count ranking and confirm
your new test goes red. Record both runs. The review measured `78 passed (78)` under that mutation
today, which is why this finding exists.

### 4. Finding 10 — name the reason accurately

`ISSUER_DEMOTED` is written for any role change that drops a permission, including a lateral move
that is not a demotion. Rename the constant and its written value to `ISSUER_ROLE_CHANGED`, and say
in the type's docblock that a lateral change losing a permission is included and why. `ISSUER_REMOVED`
stays. ADR-0026 names neither constant, so nothing there is invalidated.

### 5. Findings 1, 2, 3, 7 — the prose that is wrong

- **1.** Rename the test so its name contains a **straight apostrophe**, not U+2019, then make
  every citation in code match it exactly. A test name nobody can grep for is the ruling-129 defect
  the line was rewritten to fix. Grep for each citation afterwards and paste the exit code.
- **2.** Count the spread sites and write the number you counted (ruling 108: compute the count).
- **3.** Drop or qualify "no runtime edge … at all" — `memberships.module.ts` has one, and it is
  the factory. The claim that matters is that the *cycle* does not exist; say that instead.
- **7.** Credit the layer that actually neutralises the mutation: `Invitation` is in
  `TENANT_OWNED_MODELS` and the tenant-scoping extension scopes both operations. Verify that before
  you write it.

### 6. Findings 6 and 8 — the missing document and the missing test

- **6.** `.claude/security/audit.md` enumerates audit producers and their metadata keys, and Tasks
  13, 14 and 15 each recorded theirs. `INVITATION_REVOKED` has gained a producer and two metadata
  keys. Add them. Nothing currently in that file is false, so this is an omission, not a correction
  — do not rewrite what is already there.
- **8.** A test for self-removal: a member who leaves voluntarily also loses their outstanding
  invitations. ADR-0026 calls this its principal negative consequence and nothing exercises it.

## Rules for this round

Work test-first where a test is owed. **Create `d9-fixes.md` in this folder and commit it before
you change anything**, then append and commit as you go — two agents have already died mid-task in
this task's history, one of them losing a complete review.

Do not touch `.claude/product/roadmap.md` or `.claude/decisions/ADR-0026-*.md`. Do not touch
`apps/web`. Do not merge or push.

All six commands green before you finish, exit codes captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`): `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration`, `pnpm check:specs`, `pnpm format:check`.

**Note the review's warning about caching**: `lint` and `typecheck` can return a turbo cache hit and
tell you nothing. Re-run at least one of them with `--force`, or run `npx tsc --noEmit` and `npx
eslint` directly over the changed modules, and say which you did. The review also hit an
intermittent Windows `EPERM` on the Prisma query-engine DLL under `turbo run --force`; if you see
it, it is a file lock and not your change — retry and say so.

The honesty rule is absolute, and this round exists because a claim outran its evidence. Do not
write that the race is closed unless you have a test that goes red without your fix.
