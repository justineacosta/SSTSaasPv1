# Phase 2 · Task 6 — rulings

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator. Five rulings were taken **before** dispatch and are
in [`brief.md`](brief.md) — carry-forward 6, 30, 31, 33 and the decision that ruling 32 does not
land here. This file records how the review's findings were dispositioned and what was decided
during the fix round. Each carries the cost if it is wrong.

## Disposition of the review's findings

| #  | Finding | Disposition |
| -- | ------- | ----------- |
| H1 | A clock-restarting mutation survives the whole suite | **Fixed** — `660f835`, ruling 65 |
| H2 | `rotate` promotes `PENDING_MFA` → `ACTIVE` on default arguments | **Fixed** — `660f835`, ruling 66 |
| M1 | A session created inside `revokeMany`'s window is revoked but never tombstoned | **Fixed** — `660f835`, ruling 67 |
| C1 | The "is not revoked" sentence in the docblock and the report is false | **Fixed** in code — `660f835`, ruling 67 |
| C2 | `env.ts`'s new comment misattributes its rationale and states a false claim | **Fixed** — `660f835`, ruling 68 |
| C3 | `cookies.ts` says `Max-Age` is digits-only; `NaN` and `Infinity` reach the header | **Fixed** — `660f835`, ruling 69 |
| C4 | §3's banner claims every bullet has a test; `Session.createdAt` had none | **Fixed** — `660f835` |
| —  | ADR-0005 still describes revocation as deleting the cache entry | **Recorded, not edited**, ruling 70 |

**The citation pass did its job for the fourth task running, and this time it was aimed at two
measurements rather than at sentences.** The brief named them in advance — the `__Host-` probe and
the rotation-concurrency conclusion — and required the reviewer to re-run both rather than accept
them. Both reproduced: the cookie probe verbatim against Chromium 151.0.7922.34 with both negative
controls rejected, and the rotation race at 60 rounds where the implementer had run 10, giving
60/60 single successors against the shipped code and 60/60 double successors against a
read-then-write substitute. A conclusion that survives being re-measured at six times the sample
by someone trying to break it is worth more than one that was merely reported.

**The implementer proved the reviewer's characterisation of H1 wrong, and that correction is the
most valuable sentence in this task's ledger.** The review called the old assertion vacuous. It was
not: it compared two `new Date()` readings at millisecond precision, so it caught the mutant when
the two readings straddled a millisecond boundary and missed it when they did not — the reviewer
measured the miss, the implementer measured the catch, and both runs were real. The finding stands
unchanged and so does the fix, because a test that fails on a coin flip is worse than one that
always fails: it teaches a reader to re-run CI rather than to believe it. But "the assertion is
vacuous" is the wrong sentence to carry forward, and it was heading into this file. **This is the
second task running in which an agent corrected an upstream claim by measurement rather than
deferring to it** (Task 5's was ruling 56), which is the behaviour the two-agent split exists to
produce.

## Ruling 65 — a test that compares two clock readings taken in the same millisecond is a coin flip, not an assertion

`session.service.spec.ts`'s rotation test built its predecessor from a helper whose
`absoluteExpiresAt` was `now + 7 days`, then asserted the successor's equalled it. A mutant that
restarts the absolute clock produces `now' + 7 days`, which is the same ISO string whenever `now`
and `now'` land in the same millisecond. The predecessor's cap is now two hours out, which no
restart can coincidentally reproduce, and a second test covers the path where the reviewer's mutant
silently extended a remember-me cap by 23 days.

**Cost if wrong:** the 7-day and 30-day absolute caps are the only thing bounding how long a stolen
session token is worth stealing. Undefended, a later edit removes the cap with a green CI — and the
symptom, sessions that outlive their limit, is invisible until someone audits a row by hand.

**The general rule this carries forward:** an equality assertion between two values derived from
`Date.now()` in the same test is not an assertion about behaviour, it is an assertion about
scheduling. Pin one side to a fixed instant. **Binds every later task that tests an expiry** — 9,
10, 11 and 13 all rotate sessions.

## Ruling 66 — `rotate` requires the caller to state the successor's status, and a promotion must carry its evidence

`rotateSessionInputSchema` defaulted `status` to `'ACTIVE'`. `rotate({ sessionId })` on a ten-minute
`PENDING_MFA` session therefore returned a thirty-day `ACTIVE` credential with
`mfaCompletedAt: null`, from a call that named no status and proved nothing. The default is now
gone, and a `PENDING_MFA` → `ACTIVE` rotation that carries no `mfaCompletedAt` throws
`MFA_EVIDENCE_REQUIRED` before any row is written or any cache key poisoned.

The finding's force came from an internal contradiction, not from an external rule: twelve lines
above the default, the same file argues that `issue` has no default *because* carry-forward
ruling 6 makes forgetting the status a compile error rather than a silently privileged session. A
default on `rotate` put the omission straight back — and `rotate` is the one call in this service
that can *raise* privilege, which `issue` cannot.

**Cost if wrong:** it is the whole MFA bypass. Any of Tasks 10, 11, 13 and 17 that rotates for a
reason unrelated to MFA — a password change, an organisation switch — would have silently promoted
a session that had never proved a factor, and the call site would look completely ordinary.

**Binds Task 11 especially:** MFA completion is the one caller that legitimately promotes, and it
must pass the instant the factor was proved rather than a convenient `new Date()`.

**A refusal throws rather than returning `null`.** `null` already means "there was nothing to
rotate" — no such session, already revoked, lost the race — and a caller reading a programming
error as a lost race would retry it forever. Not every refusal is the same refusal.

## Ruling 67 — `revokeMany` poisons twice, and the second pass is what makes bulk revocation immediate

The first pass enumerates the live sessions and poisons them before the write, which is the
ordering `revoke` and `rotate` already use. It cannot see a session created between the enumeration
and the `updateMany`, and `updateMany` evaluates its predicate at execution time — so that session
*is* revoked in Postgres while its hash was never in the poison list, and the review measured it
resolving as valid from a warm cache entry **with Redis healthy**. `revokeLiveForUser` now reports
the hashes it actually revoked and a second pass poisons those.

**Cost if wrong:** a password change or a member removal that leaves a session live for up to
`SESSION_CACHE_TTL_SECONDS` is the failure mode ADR-0005 chose sessions over JWTs to avoid. It
would have been invisible in every sequential test and would have appeared in production as
"revocation mostly works".

**Two residuals remain and are disclosed rather than closed.** If Redis is unreachable at the moment
of revocation, neither pass can write a tombstone: the row is revoked and an entry cached before the
outage serves until it expires. And a session created *after* the write is genuinely not revoked —
that one is the caller's ordering problem, not this method's. **Binds Tasks 10 and 14:** a password
change writes the new hash *before* revoking, and member removal writes the membership change
first; otherwise a racing login mints a session with the old credential once the revocation has
finished.

## Ruling 68 — a comment that attributes its own rationale to the wrong function is the Phase 1 defect in miniature

`env.ts`'s new cross-field rule carried a docblock crediting `checkArgon2Cost`, which has no
docblock — the one it meant was `checkMailCredentialPair` — and the rationale itself was false:
`load-env.ts` already reads `issue.params.rule` and names it, in a branch that predates this
branch. Both are now corrected, and the rewrite states the real reason.

**Cost if wrong:** this is exactly the class that produced twelve false claims in Phase 1 and six
so far in Phase 2, five of Phase 1's introduced while correcting an earlier one. A reader who
trusts the attribution goes to the wrong function to understand the pattern; a reader who trusts
the rationale adds a `custom` issue believing it will print nothing useful, and works around a
problem that was solved two tasks ago.

## Ruling 69 — a guard that the comment describes and the code does not perform is worse than no comment

`cookies.ts` stated that `Max-Age` is rendered as RFC 6265 `delta-seconds`, digits only.
`Math.max(0, Math.floor(x))` returns `NaN` for `NaN` and `Infinity` for `Infinity`, and both
reached the header verbatim. Non-finite input now renders `'0'`, and a test holds it.

**Cost if wrong:** a browser that cannot parse `Max-Age` ignores the attribute, turning a
persistent cookie into a browser-session one — the user's "remember me" quietly stops working, with
nothing in any log to say why. Small, and it is here because the sentence claimed a guard that was
not being performed; the honesty rule does not have a severity threshold.

## Ruling 70 — ADR-0005's mechanism sentence is recorded as superseded in `§3`, and the ADR is not edited

ADR-0005 says revocation "delete[s] the cache entry and the row together". Task 6 measured that a
delete does not achieve the promise that sentence is making: in either order relative to the row, a
resolve that has already read a live row can land its cache write after the delete, leaving a live
entry for a revoked session until the TTL expires. The mechanism that keeps the promise is a
tombstone plus a Lua compare-and-set.

`CLAUDE.md` is explicit that an accepted ADR is immutable — you supersede it, you do not edit it —
and a superseding ADR is not warranted here, because the decision ADR-0005 records (opaque
server-side sessions, a cached lookup, genuinely immediate revocation) is unchanged and correct.
Only an implementation sentence inside it is now known to be insufficient. So
`security/authentication.md` §3 carries the correction and names the ADR as predating the
measurement, and ADR-0005 stands as written (`git diff` over the fix commit shows
`.claude/decisions/` untouched).

**Cost if wrong:** a reader who finds ADR-0005 before §3 implements a `DEL` and reintroduces the
race. That is a real risk and it is the reason the pointer exists in §3 rather than the correction
being left implicit. **If a second sentence in ADR-0005 is ever found wrong, that is the point to
supersede it rather than accumulate a third pointer.**
