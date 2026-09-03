# Task 14 fix round — dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-03, after reading
[`review.md`](review.md) and re-verifying its two most serious claims against the tree. Every
finding below is dispositioned: **FIX**, **ACCEPT** (with the reason), or **CORRECT** (a sentence
rather than code).

The review found 0 Critical, 2 High, 3 Medium, 5 Low, and ruled on the two open questions the
implementer flagged rather than decided. **Nine of the ten findings are FIX.**

---

## HIGH-1 — the integration lane is intermittently red, on this task's own race test. FIX.

`last-owner.integration.spec.ts`'s unlocked-race arm has a **one-sided barrier**. Reading the
order in `demote`: each transaction counts owners *first*, then Alice (`'first'`) opens
`bothCounted` and immediately falls through her own `await bothCounted.wait`. **Nothing makes
Alice wait for Bob to have counted.** If Bob is slow to start, Alice's `UPDATE` lands before Bob's
count, Bob counts 1, returns 1, and `expect(seenByBob).toBe(2)` fails.

Measured by the reviewer: two full-lane runs on this tree, the first `EXIT=1` with 1 failed / 478
passed at `last-owner.integration.spec.ts:211`, the second `EXIT=0`. Reproduced deterministically
by inserting a 500 ms delay before Bob's count.

**This blocks any completion claim.** A lane that is red on a coin flip is a red lane.

The comment above the gate says the interleaving is "arranged rather than hoped for — a race test
that depends on timing reports green on the machine that is fast enough". It is hoped for, and it
failed in exactly the way its own comment describes. **Fix the barrier and fix the comment**: a
true two-participant barrier that both transactions must arrive at *after counting* and before
either writes. Then prove it — run the file at least ten times, and demonstrate the barrier is
load-bearing by removing it and watching the arm become flaky again.

## HIGH-2 — the role-change path's lock has no test that can detect its removal. FIX.

Deleting `await lockOrganization(...)` from `updateRole` **only** left the memberships lane
36/36 `EXIT=0`, and survived 1 of 4 runs of `last-owner.integration.spec.ts` — including the lane
shape the report used to claim the mutation was caught. The one deterministic detector issues a
`DELETE`, so it exercises `remove` and not `updateRole`.

**The demotion race is the case the plan names in its own words** ("two concurrent demotions of
the two remaining owners must not both succeed"), and it is the one path whose lock nothing
reliably guards. Add a deterministic lock detector for `updateRole` on the shape that already
works for `remove`: a blocker transaction holding `FOR NO KEY UPDATE` on the `Organization` row,
so the handler's `FOR UPDATE` must wait. Prove it by mutation — remove the lock from `updateRole`
alone and show this new test red, run it five times.

Note the mechanism the implementer already found for the `remove` detector and do not lose it: a
plain `FOR UPDATE` blocker is **not** a valid detector, because `withScopedData` forces
`organizationId` into the payload, Postgres re-checks the foreign key and takes `FOR KEY SHARE`
on the parent row, and that conflicts with the blocker whether or not the handler takes its own
lock. `FOR NO KEY UPDATE` is the mode that conflicts with `FOR UPDATE` and not with
`FOR KEY SHARE`.

## MEDIUM-3 — "nothing can mint a session pointed here afterwards" is false. FIX the code, then the sentences.

`membership.service.ts`'s `remove` closes with a comment asserting that no path can issue a
session pointed at the organisation after the removal commits. The reviewer measured it false:
with a 2 s delay instrumented into `OrganizationSwitchService.switch` between the membership read
and `rotate`, the switch returns 200 and leaves a live `ACTIVE`, un-revoked session whose
`activeOrganizationId` is the organisation the member was just removed from. `GET /auth/session`
answers **200** with the organisation's `id`, `slug` and `name`.

**The reasoning in that comment is the one carry-forward ruling 82 struck down**, restated. It
argues that `switch-org` "decides membership with the guard's own resolver" — but that decision
happens *before* the write, which is precisely the window. Ruling 82's own words: writing first and
revoking after is necessary and **not sufficient**; what makes the promise true is a re-read *after*
the credential is issued.

The blast radius is bounded — every guarded route still answers 404, because the tenant resolver
reads membership fresh on every request with no cache — so no tenant data escapes. **It is still a
defect**, because `product/permissions.md` invariant 5 and `membership.service.ts` now both assert
a property that does not hold, and `session.service.ts:711` still names this exact residual as
Task 14's to close.

**Fix it with ruling 82's shape**, which is `login.service.ts`'s `credentialStillCurrent` applied
to membership: in `OrganizationSwitchService.switch`, after `rotate` returns, re-read the
membership; if it is no longer live and `ACTIVE`, revoke the session just issued and answer 404.
Either the rotate precedes the removal's revocation and is swept by it, or it follows and the
re-read observes the removal. There is no third ordering.

Then correct all three sentences in the same change — the comment in `membership.service.ts`,
`session.service.ts:711`'s "its equivalent does not exist yet", and whatever
`.claude/product/permissions.md` now claims about invariant 5.

## MEDIUM-4 — a miscount invented inside ruling 108's own comment. CORRECT.

`audit.actions.ts` now says the previous sentence "said 'all three' of a constant holding two".
Verified at `01dfe99` by the orchestrator: `AUDIT_ACTIONS` held **three** names,
`AUDIT_RESOURCE_TYPES` held **one**, and the sentence read *"All three actions above are events
about an `Organization`"* — which was **correct**. It described the actions, not the resource
types. `.claude/security/audit.md`, written in the same commit, gets it right and contradicts the
code.

Rewrite it to say what is true: the count that was wrong before Task 13's review was "all four"
of a constant holding three. Do not invent a second historical error to make the first one
rhyme.

## MEDIUM-5 — report §3.1's "34/34 passing" is 36. CORRECT.

Measured twice by the reviewer, unmutated and under M6: 2 files / **36** tests. The report's own
delta arithmetic (+36 integration tests) implies 36. Correct the figure in `report.md`.

## LOW-1 — two stale line citations in report §5.2. CORRECT.

`permissions.md:104` is now blank and `security/authorization.md:262` is unrelated. Both were
correct at `01dfe99` and were moved by this task's own documentation commit. Re-cite by heading or
by quoted phrase rather than by line number, so the citation survives the next edit.

## LOW-2 — `authorization.integration.spec.ts` cited without its directory. CORRECT.

## LOW-3 — the lock is taken before the membership is resolved, so a 404 probe still holds `FOR UPDATE`. ACCEPT, and say so.

The lock is released when the transaction ends, which for a 404 is immediately, and the
alternative — resolve first, lock second — reintroduces the window the lock exists to close, because
the owner count would then be read outside it. Ordering the lock first is correct. **Record the
reasoning in the docblock**; an unexplained lock-before-read invites a later reader to "optimise"
it into the defect.

## LOW-4 — `updateRole`'s `update` carries neither `deletedAt: null` nor `organizationId`, and the docblock claims every read does. FIX the sentence; the `where` is your call.

The row is resolved by `liveMembership` inside the same transaction and under the organisation
lock, and the tenant-scoping extension injects `organizationId` on a tenant-owned update, so this
is not a live defect. **The docblock's claim is still false as written.** Either narrow the
sentence to what is true or add the predicates to the `where` — but do not leave a comment
asserting a discipline the code beneath it does not follow.

## LOW-5 — no removal-racing-demotion arm. FIX.

Every concurrency arm pairs like with like. The plan's invariant is "an organisation always has at
least one `OWNER`", not "two demotions do not both succeed" — a removal racing a demotion reduces
the owner count by the same two, through two different code paths, and both take the lock in
different methods. Add the arm.

---

## The two open questions, ruled

### An ADMIN can remove an OWNER — this is a defect. FIX.

I agree with the reviewer's reasoning and it is the asymmetry that decides it: D5 enforces
"you cannot mint authority you do not hold" on `PATCH`, and the mirror is unenforced on `DELETE`.
An `ADMIN` cannot *make* an `OWNER` — and can *unmake* one. That is not a coherent authority
model, and the damage is not self-repairing: the removed owner cannot restore themselves, and no
`ADMIN` can promote a replacement.

**Apply the same permission-set comparison to removal**: an actor may not remove a member whose
role holds permissions the actor does not hold. Reuse D5's helper rather than writing a second
one, and reuse its shape — a set comparison, never a role ranking, because a ranking is a second
model of authority that drifts from `ROLE_PERMISSIONS`.

Check the cases before you write the test list, because the rule must not brick the ordinary ones:
`OWNER` removing `OWNER` is equal sets and passes; `ADMIN` removing `ADMIN` passes; `ADMIN`
removing `OWNER` is refused **403**; and self-removal by an `ADMIN` is equal sets and passes, so
the rule does not collide with the ruling below.

This extends the plan, which says only that removal requires `organization.manage_members`.
Recorded here as an orchestrator decision with its cost if wrong: if it turns out customers need
an ADMIN who can evict a compromised owner, widening this is a one-line change and a test edit,
whereas shipping the asymmetry and discovering it in Phase 11 is a security-model change against
live tenants.

### Self-removal is permitted — not a defect. CORRECT the documentation only.

Leaving an organisation is legitimate, it is bounded by the last-owner invariant, and the
reviewer confirmed the sessions are revoked correctly. Nothing documents it. Say so in the
`DELETE` handler's OpenAPI description, so a client is not left guessing whether it is supported.

---

## Rules for this round

- **You do not write status prose.** No `roadmap.md` edits, no "this now works". Report commands
  and exit codes; the orchestrator writes every sentence that asserts anything.
- **Re-run the check after each fix. Do not describe a fix from memory.** Four of this branch's
  false claims were introduced while correcting an earlier one — including one in the brief you
  are working from, which the implementer caught and which is left standing in `brief.md` §7 with
  its refutation.
- **`pnpm test:integration` must be run at least three times end to end** before you report it
  green. HIGH-1 is a flake that a single green run would have hidden, and it is the reason this
  round exists.
- Every fix that closes a security claim gets a mutation: apply it, watch the test go red, restore,
  and report the counts. **List survivors.**
- Full verification at the end: `pnpm format:check`, `lint`, `typecheck`, `test`, `check:specs`,
  `test:integration`, `build`, `check:openapi`, `check:registry`, `check:secrets`,
  `docker compose ps`. Capture exit codes outside a pipe.
- If a disposition above is wrong, say so with the measurement and stop, rather than routing
  around it.
