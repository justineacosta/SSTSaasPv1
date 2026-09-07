# Task 15 — D9 fix round: fixer's ledger

**Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Round:** D9 security fix round, following `d9-review.md` and `d9-fix-brief.md`.
**Rule in force:** carry-forward ruling 131 — this document is created and committed
*first*, and appended to and committed *after each fix*. Two agents have already died
mid-task in this task's history; one of them lost a complete adversarial review by
writing its document last. Nothing here is written in advance of the work it describes.

## Status

- [x] Read the brief, the review, ADR-0026, and the implementer's report
- [x] Item 1 — organisation lock in `InvitationService.create` (the reproduced escalation)
- [ ] Remaining items, in the brief's order
- [ ] Six commands green, exit codes captured outside a pipe

## Honesty rule

Nothing below is claimed as fixed, closed, or passing unless the run that establishes
it is recorded here with its actual output. The two tests the brief demands red-then-green
runs for get both runs recorded, with the exact command and the exact result.

## Log

_(appended as the work happens)_

### Entry 0 — ledger created

Created before reading anything but `CLAUDE.md`'s auto-loaded contents and listing this
directory. Committed immediately, per ruling 131.

### Entry 1 — reading done, and the lock-order check the brief asked me to repeat

Read in the brief's order: `CLAUDE.md`, `d9-fix-brief.md`, `d9-review.md` (all 695 lines),
ADR-0026, `d9-report.md`. Then the code: `invitation.service.ts` (`create`,
`actorAuthority`, `lockInvitationSlot`), `invitation-revocation.cascade.ts`,
`membership.service.ts` (`lockOrganization`, `remove`), and both integration specs.

**The lock-order check, run rather than trusted** (the brief asked me to verify it and say
that I did):

```
$ grep -rn "lockInvitationSlot" apps/api/src packages --include=*.ts
apps/api/src/modules/invitations/invitation.service.ts:167:  (the definition)
apps/api/src/modules/invitations/invitation.service.ts:355:  (the only call site — `create`)
...plus two spec comments naming it.

$ grep -rn "lockOrganization" apps/api/src packages --include=*.ts | grep -v spec
invitation-revocation.cascade.ts:34   (a comment)
invitation.service.ts:25              (the import)
invitation.service.ts:682             (a comment)
invitation.service.ts:765             (`accept`)
membership.service.ts:176             (the definition)
membership.service.ts:517             (`updateRole`)
membership.service.ts:651             (`remove`)
```

`lockInvitationSlot` has **one** caller and it is `create`. The three other takers of
`lockOrganization` take no advisory lock at all. So nothing in this codebase takes the slot
lock before the organisation lock, and `create` taking organisation-then-slot introduces no
cycle and no deadlock. That is the check to repeat before a fifth taker is added, and the
sentence is now in `create`'s own comment rather than only here.

### Entry 2 — Finding 4 (HIGH): the organisation lock in `create`, RED then GREEN

**The test, written first.** `POST /api/v1/organizations/:id/invitations — a create racing
its own issuer’s removal (ADR-0026 §3)` at the foot of
`apps/api/src/modules/invitations/invitations.integration.spec.ts`. One blocker transaction
on a second `sentinel_app` connection takes `FOR NO KEY UPDATE` on the `Organization` row,
writes the removal (`status`/`deletedAt` together, ruling 10) and holds; the real
`POST .../invitations` is then fired as the member being removed, offering `OWNER`; after
1s the test asserts the request has **not** answered; the blocker commits; the request must
then be refused 403 `PERMISSION_DENIED` with no `Invitation` row and no `MEMBER_INVITED`
event.

`FOR NO KEY UPDATE` and not `FOR UPDATE` — ruling 121, and the same reasoning the accept-side
detector already records: the tenant-scoping extension forces `organizationId` into every
write payload, so Postgres re-checks the foreign key and takes `FOR KEY SHARE` on the
organisation row, which conflicts with `FOR UPDATE` whether or not the handler locks
anything. A `FOR UPDATE` blocker would pass under its own mutation.

**RED — against the code exactly as the review left it, before the lock existed:**

```
$ npx vitest run --project integration --no-file-parallelism \
    -t "a create racing" apps/api/src/modules/invitations/invitations.integration.spec.ts
EXIT=1
 × POST .../invitations — a create racing its own issuer’s removal (ADR-0026 §3)
   > BLOCKS while another session holds FOR NO KEY UPDATE on the organisation row,
     and is refused once that removal commits   1109ms
   → ...expected true to be false
 Tests  1 failed | 36 skipped (37)
```

The request answered inside the 1s window while the organisation row was locked. That is
Finding 4, measured on this branch by this test, with no instrumentation in production code.

**The fix.** `await lockOrganization(tx, ctx.organizationId);` as the first statement inside
`create`'s transaction, before `actorAuthority` and before `lockInvitationSlot`, with the
reasoning in a comment: a re-read is not a lock, READ COMMITTED is why, and `create` is the
fourth writer in the set the other three serialise.

**GREEN — same command, same test, after the one-line change:**

```
EXIT=0
 ✓ ...BLOCKS while another session holds FOR NO KEY UPDATE on the organisation row,
     and is refused once that removal commits   1127ms
 Tests  1 passed | 36 skipped (37)
```

**And the three specs the lock could have disturbed:**

```
$ npx vitest run --project integration --no-file-parallelism \
    invitations.integration.spec.ts memberships.integration.spec.ts last-owner.integration.spec.ts
EXIT=0   Test Files 3 passed (3)   Tests 86 passed (86)
```

**What this proves, stated as narrowly as it deserves.** It proves `create` serialises behind
a holder of the organisation lock, and that once that holder's removal commits `create`
refuses and writes nothing. It does not prove the absence of every interleaving — no test
does. It is a detector for the one statement (ruling 120), and it is deterministic: nothing
in it races, because the blocker holds the lock before the request is sent.

**The stated limit.** The blocker writes the removal as raw SQL rather than driving
`MembershipService.remove`, because `remove` opens its own `withTenantTransaction` and cannot
be composed into the transaction that has to hold the lock. It writes the same two columns
`remove` writes. What it skips is the cascade — which is the point, there is no invitation
yet for it to find — and the session revocation, which the racing request has by definition
already got past, since `TenantContextGuard` ran before the removal committed. This is in the
test's own docblock too, not only here.
