# Task 15 / D9 — Adversarial review

**Reviewer:** fresh adversarial reviewer (did not write this code)
**Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Baseline diff:** `git diff 53f40aa..HEAD`
**Started:** session start, document created before any reading (carry-forward ruling 131)

## Status

- [ ] Read brief, ADR-0026, d9-brief, d9-report
- [ ] Read diff
- [ ] Code pass (concurrency, RLS, cross-tenant, rollback)
- [ ] Citation pass (report claims, code comments, ADR-0026, `.claude/` edits)
- [ ] Final judgement

## Findings

_(appended as they land)_

## What I could NOT verify

_(appended as they land)_

## Overall judgement

_(pending)_

---

## Finding 1 — MEDIUM (citation pass) — `d9-report.md` claims a grep it did not perform, and the citation it claims to have fixed is still broken

**What is wrong.** `d9-report.md`, §"Documentation changed in the same change", states of
`invitation.service.ts`:

> It now says CLOSED, cites both new tests **by their exact names** (ruling 129; I grepped for my
> own citations afterwards and both resolve)

Both halves are false. The citation at `apps/api/src/modules/invitations/invitation.service.ts:734`
reads `an invitation does NOT outlive its issuer's authority` with a **straight** apostrophe
(U+0027). The test it names, at `invitations.integration.spec.ts:1777`, is
`an invitation does NOT outlive its issuer’s authority` with a **curly** apostrophe (U+2019). A
grep for the cited string finds nothing.

**How I established it** (from the repository root):

```
$ grep -rn "an invitation does NOT outlive its issuer's" apps/api/src --include=*.spec.ts
exit=1        # no match

$ grep -rn "an invitation does NOT outlive its issuer’s" apps/api/src --include=*.spec.ts
apps/api/src/modules/invitations/invitations.integration.spec.ts:1777:  it('D9 — CLOSED BY ADR-0026: an invitation does NOT outlive its issuer’s authority', ...
apps/api/src/modules/memberships/memberships.integration.spec.ts:1051: * `D9 — CLOSED BY ADR-0026: ... issuer’s authority`,
```

The *other* citation in that same comment block —
`the invitation cascade on a membership write (ADR-0026)` — does resolve
(`memberships.integration.spec.ts:1061`). So one of the two resolves, not "both".

**This is a regression the change had the chance to fix and instead reasserted.** The baseline had
exactly the same mismatch:

```
$ git show 53f40aa:apps/api/src/modules/invitations/invitation.service.ts | grep -n "RECORDS AN OPEN WINDOW" -A1
653:   *    by `D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's
$ git show 53f40aa:apps/api/src/modules/invitations/invitations.integration.spec.ts | grep -n "RECORDS AN OPEN WINDOW"
1773:  it('D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer’s authority', ...
```

and the *replacement* comment says, in the same breath, "because the first version of this line
paraphrased its test and a grep for the citation found nothing (ruling 129)". The line was rewritten
to fix a ruling-129 defect and reintroduced it.

**Two other copies of the same break, outside the code:**
- `.claude/product/roadmap.md:2435` cites the new name with a straight apostrophe — broken.
- `.claude/product/roadmap.md:2420` and `ADR-0026` line 9 cite the *old* name
  `D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's authority` — straight
  apostrophe, and the test no longer exists under any spelling. Two ways broken.

The correctly-spelled citations are `invitation-revocation.cascade.ts:90` and
`memberships.integration.spec.ts:1051` (both curly).

**Cost if left.** Directly the cost ruling 129 was written for: a future reader or agent greps the
cited name, finds nothing, and concludes the guarantee is unpinned — which is how the previous
paraphrase defect was found in the first place. Worse, the report asserts a verification that was
not done, which is Phase 1's single recurring defect class reappearing inside the document written
to prevent it.

## Finding 2 — LOW (citation pass, ruling 108) — the moved `LIVE_INVITATION` docblock states a count that is wrong under the reading its own words invite

**What is wrong.** `invitation-revocation.cascade.ts:16` says the constant exists "rather than
**four** inline object literals". The baseline said "three". There are **7** spread sites, not four:

```
$ grep -rn "\.\.\.LIVE_INVITATION" apps/api/src | wc -l
7
```
(`invitation-revocation.cascade.ts` 152, 176; `invitation.service.ts` 375, 381, 593, 599, 833.)
At baseline there were **5**, and the docblock said "three" — so the sentence was already wrong and
the edit that touched it (three → four) did not compute the count either.

**In fairness:** four *methods* touch it (`create`'s supersession, `revoke`, `accept`, the cascade),
and three did at baseline, so the numbers are right under a "call site = method" reading. The words
chosen are "inline object literals", and there would be seven of those. I am recording it as a Low
rather than a Medium because the intent is recoverable, but ruling 108 says compute the count and
the count as written does not check out.

**How I established it.** The two greps above, plus
`git show 53f40aa:apps/api/src/modules/invitations/invitation.service.ts | grep -c "\.\.\.LIVE_INVITATION"` → `5`.

**Cost if left.** Small: a reader who greps to find "the four places" finds seven and does not know
which three they are not looking at. It matters mostly as evidence that the count was copied and
incremented rather than measured.

## Finding 3 — LOW (citation pass) — `memberships.tokens.ts` states there is "no runtime edge from `memberships/` into `invitations/` at all", and there is one

**What is wrong.** `memberships.tokens.ts` (docblock on `INVITATION_REVOCATION_CASCADE`) says:

> `membership.service.ts` takes the type with `import type`, which TypeScript erases, so there is
> **no runtime edge from `memberships/` into `invitations/` at all**.

The premise is right and the conclusion overreaches by one file.
`apps/api/src/modules/memberships/memberships.module.ts:6-9` imports `invitationRevocationCascade`
— a **value** — from `../invitations/invitation-revocation.cascade.js`. That is a runtime edge from
`memberships/` into `invitations/`.

**How I established it.**
```
$ grep -rn "from '../invitations/" apps/api/src/modules/memberships/
memberships.module.ts:6:} from '../invitations/invitation-revocation.cascade.js';      # value import
membership.service.ts:18:import type { InvitationRevocationCascade } from '../invitations/invitation-revocation.cascade.js';   # type-only
memberships.integration.spec.ts:21:import type { InvitationRevocationCascade } ...        # type-only
```

`d9-report.md` states the same claim but correctly qualified ("the only runtime import in that
direction is in `memberships.module.ts`, which nothing in `invitations/` imports"). The code comment
is the copy that dropped the qualifier, and the code comment is the one a future reader will find.

**Cost if left.** A reader who believes the absolute statement will not look for the module-level
edge when reasoning about a future cycle, and the acyclicity argument in this change rests entirely
on which direction the edges point. The claim it should make is the true and still-sufficient one:
the only runtime edge is `memberships.module.ts` → `invitation-revocation.cascade.ts`, and nothing
in `invitations/` imports `memberships.module.ts`.

## Finding 4 — HIGH (code pass) — ADR-0026 §3's race is NOT closed. I reproduced the original D9 escalation end to end, through the real routes, on this branch

**What is wrong.** ADR-0026 §3 and `d9-brief.md` item 3 both assert that re-reading the actor's
membership inside `create`'s transaction closes the in-flight window:

> ADR-0026 §3: "…so a `create` already in flight when the removal commits cannot slip past the
> cascade… it is closed here rather than recorded as owed, because a cascade that a concurrent
> request can walk around is not a control."

It can still be walked around. The re-read makes `create` decide on the database's state rather than
the guard's, but **it does not serialise `create` against `remove`/`updateRole`**, and it does not
change the isolation level. Under READ COMMITTED a `create` whose re-read runs *before* the removal
commits sees a live membership, is allowed, and inserts its row *after* the cascade's `findMany` has
already looked. The cascade cannot revoke a row that did not exist when it ran — which is the exact
sentence ADR-0026 uses to justify the fix, and it remains true of the fix.

**How I established it — measured, on this branch, through the real endpoints.**

I temporarily inserted an env-gated `setTimeout` into `invitation-revocation.cascade.ts` immediately
after its `findMany`, still inside the caller's transaction, to widen the window to something a test
can hit. Then, in a temporary block appended to `invitations.integration.spec.ts`, I fired
`DELETE /api/v1/organizations/:id/members/:membershipId` (real route, real guard chain), waited
1200 ms, and fired `POST /api/v1/organizations/:id/invitations` as the member being removed (real
route, real guard chain, `roleKey: OWNER`).

```
$ npx vitest run --project integration --no-file-parallelism \
    -t "PROBE: a create in flight" \
    apps/api/src/modules/invitations/invitations.integration.spec.ts
EXIT=0
PROBE removal status 204 {}
PROBE invite status 201 {"id":"inv_01M1YC93WN…","roleKey":"OWNER","revokedAt":null,…}
PROBE invitation row {"id":"inv_01M1YC93WN…","revokedAt":null,"acceptedAt":null,…}
PROBE issuer membership after {"deletedAt":"2026-09-07T16:47:30.497Z","status":"REMOVED"}
PROBE accept status 201 {"…","roleKey":"OWNER","status":"ACTIVE",…}
PROBE VERDICT RACE OPEN: live OWNER invitation from a removed member
```

The last line is the whole point: **the invitation was then redeemed and minted an `OWNER`
membership** in that organisation, issued by a user whose membership row reads
`status: REMOVED, deletedAt: <set>`. That is byte for byte the outcome the deleted test
`D9 — RECORDS AN OPEN WINDOW…` used to pin, reproduced on the branch that claims to have closed it.

The demotion arm is the same:

```
$ npx vitest run --project integration --no-file-parallelism -t "PROBE2" …
PROBE2 demotion status 200
PROBE2 invite status 201 {"…","roleKey":"OWNER","revokedAt":null,…}
PROBE2 issuer role after MEMBER invitation {"…","revokedAt":null}
PROBE2 VERDICT RACE OPEN: live OWNER invitation from a member demoted to MEMBER
```

**Why it is open, established by inspection to explain the measurement (not to replace it):**

1. `packages/db/src/tenant-transaction.ts` calls `scoped.$transaction(fn)` with **no**
   `isolationLevel`. `grep -rn "isolationLevel" apps packages --include=*.ts` finds no application
   call site — only Prisma's generated types. So every transaction here is Postgres' default
   READ COMMITTED, under which a non-locking `SELECT` reads the last committed row version and does
   not block on another transaction's uncommitted `UPDATE`.
2. `InvitationService.create` **does not take the organisation lock.**
   `grep -rn "lockOrganization" apps/api/src --include=*.ts | grep -v spec` gives exactly three call
   sites: `invitation.service.ts:765` (that is `accept`), `membership.service.ts:517` (`updateRole`),
   `membership.service.ts:651` (`remove`). `create` takes only
   `pg_advisory_xact_lock(hashtext('inv:<org>:<email>'))` (`invitation.service.ts:172`), a different
   key, so it contends with nothing the two membership writes hold.
3. `actorAuthority` uses `tx.membership.findFirst` — a plain read, not `FOR UPDATE` — so it acquires
   nothing that would make it wait for the removal.

**On the artificial delay.** The probe widens the window; it does not create it. The window is
`create`'s re-read → `create`'s commit overlapping `remove`'s cascade-read → `remove`'s commit, and
its natural width is the duration of two ordinary transactions on the same tenant. Points 1–3 are
what make it exist at all, and none of them is affected by the delay. I did not attempt to measure
how often it reproduces without the delay, and I am not claiming it is easy to hit unaided.

**The repository already knows the remedy and wrote it down.** `lockOrganization`'s docblock
(`membership.service.ts:102-176`) says: *"Every membership write that can change the owner count
takes it… A writer that skips it is outside the serialisation and reopens the race for everyone"*,
and records that `SERIALIZABLE` was considered and rejected in favour of the lock. `create` is now,
by ADR-0026, a writer whose correctness depends on that same serialisation, and it is outside it.
`lockOrganization` is exported and `invitation.service.ts` already imports it (line 25) for `accept`.
I have not measured whether adding it to `create` closes the probe, because the brief forbids me
changing code — but that is the shape of the fix, and it costs one lock on a path that already
takes one.

**Cost if left alone.** The highest-value open security item in Phase 2 is recorded as closed while
a re-escalation path for a just-removed `OWNER` remains open, reachable by that person timing one
request against their own removal — which is precisely the person motivated to try, and the removal
is an event they can observe (their session dies). Every downstream document now says the window is
shut: `.claude/security/authentication.md` deleted its open-window paragraph, `roadmap.md` moved the
item to closed, and the test named to warn about it was rewritten. A future reader has nothing left
telling them to look.

**A narrower, honest claim the change is entitled to make.** The re-read *does* work, and my probe
confirms the mechanism: a `create` whose re-read runs *after* the removal commits is refused (that
is what the implementer's two direct-service tests show, and they are sound). What is not true is
that the window is closed. ADR-0026 §3's final sentence, `d9-brief.md` item 3, the
`invitation.service.ts:290-317` docblock and `d9-review-brief.md`'s opening paragraph all overstate
it in the same words, and all four need correcting whether or not the lock is added.

**Working tree restored.** `git checkout apps/api/src/modules/invitations/invitation-revocation.cascade.ts apps/api/src/modules/invitations/invitations.integration.spec.ts` — confirmed clean with
`git status --short` (only this review document is modified).
