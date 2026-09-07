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
- [x] Remaining items, in the brief's order
- [x] Six commands green, exit codes captured outside a pipe

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

### Entry 3 — Finding 11's disclosed half: `actorAuthority` re-checks the route's own permission

`actorAuthority` re-read the actor's role and handed it only to `assertActorMayGrant`, which
asks "may they grant *this* role" and nothing else. `AuthorizationGuard` had separately decided
`organization.manage_members`, before the handler ran, from the row the guard saw. So an
in-flight `create` by somebody demoted `OWNER` → `MEMBER` was refused an `OWNER` invitation and
**allowed** a `MEMBER` one — a member with no authority over the roster still adding somebody to
it. The implementer disclosed this as residual risk 1; the review recorded it as Finding 11's
disclosed half.

**The change.** `ROUTE_PERMISSION` is declared once in `invitation.service.ts` as a
`satisfies Permission` literal — a second copy of the string `@RequirePermission` puts on the
handler, deliberately not read from the decorator's metadata, because a check derived from the
guard cannot disagree with a wrong guard. `actorAuthority` builds the live context first and
then refuses if that set does not contain it, with the refusal built from the **live** context
so `yourRole` names the role the database holds now.

**The test.** `refuses an actor demoted out of organization.manage_members, even for a role they
could grant`. `MEMBER` is the demotion target precisely because a `MEMBER` invitation passes
`assertActorMayGrant` — `MEMBER`'s permissions are a subset of themselves — so the only thing
that can refuse the call is the new check. It also asserts, from `ROLE_PERMISSIONS`, that
`MEMBER` still lacks the permission, so the case cannot go quietly vacuous if the seeded roles
move.

**Its mutation.** With the one line deleted:

```
$ npx vitest run --project integration --no-file-parallelism \
    -t "demoted out of organization.manage_members" invitations.integration.spec.ts
MUT EXIT=1
  × refuses an actor demoted out of organization.manage_members, even for a role they could grant
  Tests 1 failed | 37 skipped (38)
```
Restored with `cp` from a backup taken before the mutation; `git diff --stat` confirms only the
intended lines remain.

**One existing test had to change, and the change is not a weakening.** `decides on the role the
database holds, not the role the context claims` demoted the actor to `MEMBER` and then asserted
that a `MEMBER` invitation was **allowed** — which is exactly the behaviour Finding 11 says is
wrong, pinned as correct. Its demotion target is now `ADMIN`, which still carries
`organization.manage_members`, so the case stays about the no-minting rule alone: `OWNER`
refused, `MEMBER` allowed. The `MEMBER` arm is the new test above, and it is a different
refusal for a different reason.

**Whole spec after both changes:**
```
$ npx vitest run --project integration --no-file-parallelism invitations.integration.spec.ts
EXIT=0   Test Files 1 passed (1)   Tests 38 passed (38)
```

**Deliberately NOT widened, per the brief — recorded here as residuals.**

- **Organisation suspension.** `resolveTenant` refuses a suspended organisation;
  `assertPathIsActiveTenant` is only an id comparison and reads no row, so an in-flight `create`
  during a suspension is in the same position Finding 11 item 2 describes. It is out of scope
  because suspension is a different control with its own lifecycle and its own callers, and
  widening a function named for ADR-0026 §3 into it would put the suspension rule in a place
  nobody looking for the suspension rule would find. The organisation lock added above narrows
  this window to the same width as every other membership write's.
- **`status === 'ACTIVE'`.** `actorAuthority` filters on `deletedAt: null` only. The
  `Membership_status_deletedAt_agree_check` biconditional ties `deletedAt` to `REMOVED`, so an
  `INVITED` row would have `deletedAt IS NULL` and would resolve here. It is unreachable today —
  nothing in the codebase writes `'INVITED'` — and adding the predicate would pin a claim about
  the data in a place that does not own it. The claim is now written into `actorAuthority`'s
  docblock instead (ruling 128), which is where the predicate that depends on it lives.

### Entry 4 — Finding 9: the test that can tell a set comparison from a ranking

"A set comparison, never a ranking" is asserted in ADR-0026, in the cascade's docblock under
its own heading, in `membership.service.ts` and in the demotion test's own comment. The review
replaced the subset filter with a ranking by permission count and measured **78 passed (78)**
across both integration specs. Four assertions, zero measurements — ruling 128's shape.

**Why the suite could not tell.** Every role change it exercised lay on a totally ordered
chain: `OWNER`→`MEMBER`, `MEMBER`→`ADMIN`, `ADMIN`→`ADMIN`. On a chain a ranking and a subset
test agree on every row.

**The counterexample, from the seeded lattice.** `AUDITOR` (15 permissions) carries `audit.read`
and `billing.read`, which `SECURITY_LEAD` (33) does not. So an `ADMIN` who issued an `AUDITOR`
invitation — permitted, `AUDITOR` ⊆ `ADMIN` — and is then moved to `SECURITY_LEAD` can no longer
issue it. The set test revokes; a count ranking asks whether 15 > 33, answers no, and leaves a
live invitation offering two permissions the issuer no longer holds.

**The test.** `revokes on a LATERAL role change that a ranking would keep — the set test,
measured`, in `memberships.integration.spec.ts`, through the real `PATCH .../members/:id`. A
`MEMBER` invitation is the control — `MEMBER` ⊆ `SECURITY_LEAD`, so it survives under both
readings, which is what stops the case passing because the cascade revoked everything. Three
preconditions are computed from `ROLE_PERMISSIONS` rather than assumed (ruling 108): that
`AUDITOR` is not a subset of `SECURITY_LEAD`, that it is the *smaller* of the two, and that
`MEMBER` is a subset. If a reseeding breaks any of them the case says so instead of passing
quietly.

**GREEN against the real filter:**
```
$ npx vitest run --project integration --no-file-parallelism \
    -t "LATERAL role change" memberships.integration.spec.ts
EXIT=0   Tests 1 passed | 42 skipped (43)
```

**RED under the exact mutation the review measured as green.** Subset filter replaced with
`candidates.filter((candidate) => candidate.role.permissions.length > retained.size)`:
```
$ npx vitest run --project integration --no-file-parallelism \
    memberships.integration.spec.ts invitations.integration.spec.ts
MUT5 EXIT=1
  × the invitation cascade on a membership write (ADR-0026)
    > revokes on a LATERAL role change that a ranking would keep — the set test, measured
  Test Files 1 failed | 1 passed (2)   Tests 1 failed | 80 passed (81)
```
The review's 78/78 is now 80 passed and **one** failure, and the failure is this case. The file
was restored from a backup taken before the mutation and `git diff --stat` on it is empty.

### Entry 5 — Finding 10: `ISSUER_DEMOTED` → `ISSUER_ROLE_CHANGED`

`updateRole` always passed `reason: 'ISSUER_DEMOTED'`. Because the rule is a set test and the
seeded lattice is only partially ordered — `AUDITOR` is incomparable with `SECURITY_LEAD`,
`MEMBER` and `VIEWER` — a **lateral** move revokes. The test added in Entry 4 is exactly such a
move, so the suite was, as of the previous commit, pinning `ISSUER_DEMOTED` on a change that is
not a demotion. Ranking vocabulary on the one rule the design insists is not a ranking.

Renamed in the type and in the value `updateRole` writes. `ISSUER_REMOVED` is untouched: a
removal is a removal under any ordering. ADR-0026 names neither constant, so nothing there is
invalidated, and the ADR is not mine to edit in any case.

The type's docblock now says which changes are included and why — that a lateral move losing a
permission revokes, with `AUDITOR` named as where the lattice forks. `audit.actions.ts` §
`INVITATION_REVOKED` carries the new spelling and drops "demoted" from its prose.

**Also corrected in the same docblock, and it is Finding 8's related half.** It said of the
cascade's `actorId`: *"that person is the one who removed or demoted the issuer, not the
issuer."* On a self-removal they are the same person, and ADR-0026 says self-removal will be the
common case — so a reader using that sentence to tell the two producers apart would be wrong
precisely where it matters most. It now says `actorId` is usually somebody else and on a
self-removal is the leaver, and that `reason` — present on exactly one of the two producers — is
what distinguishes them.

```
$ npx vitest run --project integration --no-file-parallelism memberships.integration.spec.ts
EXIT=0   Test Files 1 passed (1)   Tests 43 passed (43)
```

### Entry 6 — Findings 1, 2, 3, 7: the prose that was wrong

**Finding 1 — the citation nobody could grep for.** The test was named with U+2019
(`issuer’s`) and cited from three other files with U+0027 (`issuer's`), so a grep for any
citation exited 1. The line had been rewritten in the previous round *to fix* a ruling-129
defect and reintroduced it.

The test now carries a **straight** apostrophe. Prettier switched the `it(...)` to double
quotes on its own, which is `singleQuote` picking the quote that needs fewer escapes, not a
style choice — that is said in a comment above the test so nobody "fixes" it back. Every
citation was rewritten to match exactly, and each was reflowed onto **one line**, because a
name broken across two comment lines is not greppable either.

The greps, with their exit codes, from the repository root:

```
$ grep -rn "an invitation does NOT outlive its issuer's authority" apps/api/src --include=*.ts
invitation-revocation.cascade.ts:107   (docblock citation)
invitation.service.ts:829              (accept's docblock)
invitations.integration.spec.ts:1784   (the test itself)
memberships.integration.spec.ts:1051   (the cascade block's docblock)
exit=0

$ grep -rn "outlive its issuer’s" apps/api/src --include=*.ts        # the curly spelling
exit=1

$ grep -rn "the invitation cascade on a membership write (ADR-0026)" apps/api/src --include=*.ts
invitation.service.ts:831, invitations.integration.spec.ts:1797, memberships.integration.spec.ts:1061
exit=0

$ grep -rn "refuses an actor demoted out of organization.manage_members, even for a role they could grant" apps/api/src --include=*.ts
invitation.service.ts:234, invitations.integration.spec.ts:2074
exit=0

$ grep -rn "a create racing its own issuer's removal (ADR-0026 §3)" apps/api/src --include=*.ts
invitations.integration.spec.ts:2188
exit=0
```

Two of those are citations **this round** introduced, and one of them was wrong when I wrote
it: `actorAuthority`'s new docblock cited a test called `an actor demoted out of
organization.manage_members mid-flight is refused`, which is not the name I gave the test.
Caught by running the grep rather than by reading it back. It also said `@RequirePermissions`
where the decorator is `@RequirePermission`. Both corrected. The new `describe` this round
added carries a straight apostrophe for the same reason.

`roadmap.md`'s two broken citations are the orchestrator's, per the brief, and are untouched.

**Finding 2 — the count.** `grep -rn '\.\.\.LIVE_INVITATION' apps/api/src --include=*.ts | wc -l`
gives **7**: two in `create` (the supersession's read and its write), two in `revoke`, one in
`accept`, two in the cascade. Seven literals across four methods. The docblock said "three",
then "four" — the *method* counts at two moments — while the words it uses are "inline object
literals". It now states the seven, says where they are, and records that the figure was
incremented rather than measured (ruling 108).

**Finding 3 — the runtime edge that exists.** `memberships.tokens.ts` said there is "no runtime
edge from `memberships/` into `invitations/` **at all**". There is exactly one:
`memberships.module.ts:6-9` imports `invitationRevocationCascade`, a value. The docblock now
says the *service* carries no runtime edge, names the module's factory as the one that does, and
states the claim that is both true and sufficient — that no **cycle** exists, because nothing in
`invitations/` imports `memberships.module.ts`.

**Finding 7 — the layer that actually neutralises mutation 3.** Verified before writing it:
`TENANT_OWNED_MODELS` is `['Membership', 'Invitation', 'AuditEvent']`
(`packages/db/src/tenant-resources.ts:12`), `findMany` is in `SCOPED_WHERE_MANY_OPERATIONS`
(`tenant-scope.ts:27`) and `updateMany` in `SCOPED_WHERE_AND_DATA_MANY_OPERATIONS` (`:35`). So
layer 1 — the tenant-scoping extension — injects `organizationId` back into the `where` before
the statement is issued; it never reaches Postgres without it, and RLS is the second line rather
than the first. `d9-report.md`'s mutation-3 cell is corrected in place, marked as a correction
rather than silently rewritten. The code comment in the cascade already had this right.

**Also corrected in `d9-report.md`:** the claim "I grepped for my own citations afterwards and
both resolve". It is false and it is the claim the review called Phase 1's recurring defect
class reappearing inside the document written to prevent it. Marked as a correction, with the
grep that exited 1.

```
$ npx vitest run --project integration --no-file-parallelism \
    invitations.integration.spec.ts memberships.integration.spec.ts
EXIT=0   Test Files 2 passed (2)   Tests 81 passed (81)
```

### Entry 7 — Findings 6 and 8: the missing document and the missing test

**Finding 6 — `.claude/security/audit.md` §4.** Tasks 13, 14 and 15 each recorded their audit
producers in that file, in the same change; ADR-0026's producer was the first in that section's
history not to get its paragraph. Nothing in the file was false, so this is an omission and the
existing text is untouched. Added, in the same convention as the Task 13 and Task 14 paragraphs
beside it:

- `INVITATION_REVOKED` gained a **second producer** — the cascade, called by
  `MembershipService.remove` and `updateRole`, writing inside the same transaction as the
  membership write, with `resourceId` still the `Invitation`.
- The two metadata keys the deliberate revocation does not write: **`reason`**
  (`ISSUER_REMOVED` / `ISSUER_ROLE_CHANGED`) and **`issuerUserId`** (the user id, not the
  membership id, for the reason `MEMBER_REMOVED` gives for `memberUserId`).
- That `reason` is the **only** thing that tells the two producers apart, and that `actorId` is
  not — on a self-removal the actor *is* the issuer, and ADR-0026 expects that to be common.
- That a removal no longer writes a constant number of audit rows, so nothing downstream may
  size one.
- That supersession still writes no event, and that §5 is unaffected because the cascade's
  `select` never loads `tokenHash`.

**Finding 8 — self-removal, ADR-0026's principal stated cost.** Every one of the seven cascade
cases had the actor act on somebody else, so the one consequence users will actually notice —
"a member who leaves for entirely benign reasons takes their outstanding invitations with them"
— was reasoned about and never measured. Added
`takes the invitations of a member who removes THEMSELVES, and names them as the actor`: the
actor deletes their own membership through the real endpoint (a second owner exists so the
last-owner invariant does not refuse at 422 first), their `ADMIN` invitation is revoked, a
colleague's is not, and the single event has `actorId === issuerUserId === the leaver`.

That last assertion is the half that matters beyond coverage: it pins the case that made
`audit.actions.ts`'s "the one who removed or demoted the issuer, **not the issuer**" wrong, so
the sentence cannot come back.

```
$ npx vitest run --project integration --no-file-parallelism memberships.integration.spec.ts
EXIT=0   Test Files 1 passed (1)   Tests 44 passed (44)
```

It goes red when the feature is removed (cascade returns before revoking anything), which I
measured rather than assumed:
```
MUT EXIT=1
  × the invitation cascade on a membership write (ADR-0026)
    > takes the invitations of a member who removes THEMSELVES, and names them as the actor
  Tests 1 failed | 43 skipped (44)
```
File restored from a backup taken before the mutation; `git diff --stat` on it is empty.

### Entry 8 — `create`'s docblock stops overstating the fix

The docblock at `invitation.service.ts` still ended on "the re-read makes the check and the fact
come from the same snapshot", which is the sentence the review says overstates it in four
places. Two of the four (ADR-0026 §3, `roadmap.md`) are the orchestrator's; the two in code are
mine. The `create` docblock now carries the correction in the strongest form available to it —
that a re-read is not a lock, that READ COMMITTED is why, that the review reproduced a `201`
minting an `OWNER` on the code that made the claim, and that **naming rulings 82 and 122 in a
docblock is not obeying them**. It names `lockOrganization` as what closes it and cites the
detector by its exact name. `invitation-revocation.cascade.ts`'s claim is about the cascade and
was not one of the four.

### Entry 9 — the six commands

Every exit code captured outside a pipe with `out=$(pnpm <cmd> 2>&1); code=$?` (ruling 105).

| Command | Exit | Result |
|---|---|---|
| `pnpm lint` | `0` | 14/14 tasks. `@sentinel/api:lint` was a **cache miss** and executed. |
| `pnpm typecheck` | `0` | 14/14 tasks. `@sentinel/api:typecheck` was a **cache miss** and executed. |
| `pnpm test` | `0` | 115 files, **1983 tests passed** |
| `pnpm test:integration` | `0` | 29 files, **558 tests passed** (302.9s). Baseline 554; +4 = the race detector, the `manage_members` re-check, the lateral set-vs-ranking case, and self-removal. |
| `pnpm check:specs` | `0` | 144 spec files, each claimed by exactly one of unit / integration / ui |
| `pnpm format:check` | `0` | All matched files use Prettier code style |

**On the caching warning.** Turbo reported `cache miss, executing` for `@sentinel/api` on both
`lint` and `typecheck`, so neither was a replayed log. I also ran both independently of turbo,
which is what the brief asked for: `npx tsc -p tsconfig.json --noEmit` in `apps/api` → **exit
0**; `npx eslint src/modules/invitations src/modules/memberships src/modules/audit` → **exit 0**.
I did **not** use `turbo run --force`, because the review recorded an intermittent Windows
`EPERM` on the Prisma query-engine DLL under it and the two direct runs answer the same question
without that risk. I did not see the EPERM at any point in this round.

`pnpm lint` was red once during this round, on my own new code:
`@typescript-eslint/no-unnecessary-type-assertion` at `invitations.integration.spec.ts:2104` —
a `ROLE_PERMISSIONS.MEMBER as readonly Permission[]` that changed nothing. Removed; lint green
on the re-run, again as a cache miss.

## What I did not do, and why

- **`.claude/product/roadmap.md`** (Finding 5) and **`.claude/decisions/ADR-0026-*.md`** — the
  brief assigns both to the orchestrator and forbids me either. Untouched. `git diff --name-only`
  from my first commit confirms it, along with `apps/web`.
- **ADR-0026 §3's own wording** still asserts that the re-read closes the race. That assertion
  was wrong when written and is now *incomplete* rather than wrong — the window is closed, by a
  mechanism the ADR does not name. Amending it is the orchestrator's.
- **`d9-brief.md` and `d9-review-brief.md`**, the two other places the review says overstate the
  claim. They are dated instruction documents from earlier rounds, not descriptions of current
  state, and rewriting somebody else's brief after the fact destroys the record of what was
  actually asked. The correction lives where a reader will hit it: the code, and this file.
- **`pnpm check:openapi` and `pnpm check:registry`** — not among the six, and nothing in this
  round touches a contract, a response schema or the tenant resource registry. My changes are
  confined to two service files, one cascade, one tokens file, one audit constants file, two
  integration specs and three documents.
- **A test for the unaided (undelayed) hit rate of the original race.** The review did not
  measure it and neither did I; the detector proves the lock is taken, not how often the window
  used to open.

## Residual risks I am aware of

1. **The detector proves serialisation, not the absence of every interleaving.** It shows
   `create` waits behind a holder of the organisation lock and then refuses. A different
   interleaving — one that does not contend for that row — is not covered by it. What makes me
   think the set is now complete is `lockOrganization`'s own argument: the four writers that can
   move a member's authority (`accept`, `updateRole`, `remove`, and now `create`) all take it. A
   fifth writer added without it reopens this, and the docblock in `create` says so.
2. **The blocker writes the removal as raw SQL**, not by driving `MembershipService.remove`.
   Same two columns; no cascade (there is nothing yet to cascade over) and no session revocation
   (the racing request already passed the guard). Stated in the test and above.
3. **Organisation suspension is still not re-read** inside `create`'s transaction. Out of scope
   by the brief; the window is now one organisation-lock-width, the same as every other
   membership write's.
4. **`status === 'ACTIVE'` is still not checked** by `actorAuthority`; `deletedAt: null` is the
   only predicate. Unreachable today because nothing writes `'INVITED'`. That is a claim about
   the data and it is now written into the docblock beside the predicate that depends on it
   (ruling 128), which is the most I can do without pinning it.
5. **Mutations 3 and 4 still survive**, as the implementer reported. Finding 7 corrected which
   layer explains mutation 3; neither mutation became distinguishable.
6. **`create` now serialises per organisation.** Two invitations to different addresses in one
   tenant queue behind each other where before they did not — `lockInvitationSlot`'s finer key no
   longer buys that back on this path. It is the same cost `updateRole`, `remove` and `accept`
   already pay, for one short transaction, and the existing test
   `does not take that lock for a DIFFERENT address in the same organisation` still passes
   because it blocks on the advisory key rather than the row. If invitation throughput per tenant
   ever matters, this is the line that bounds it.
7. **The invitee is still not told.** ADR-0026's stated and accepted cost, unchanged by this
   round.
8. **`d9-report.md` is now a corrected document rather than a contemporaneous one.** Both
   corrections are marked in place as `[CORRECTED IN THE D9 FIX ROUND]` rather than rewritten
   silently, so the original claims and the fact that they were wrong are both still readable.
