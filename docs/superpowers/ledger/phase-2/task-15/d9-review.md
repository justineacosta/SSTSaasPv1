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
