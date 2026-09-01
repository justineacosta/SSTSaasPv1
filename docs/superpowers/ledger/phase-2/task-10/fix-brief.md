# Task 10 dispositions — what the fix round changes

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31 after reading [`review.md`](review.md). **1 High, 3
Medium, 7 Low, 7 false sentences.** All eleven evidence rows reproduced, all eight of the
implementer's mutations reproduced, and all thirty ruling citations checked out — the first clean
citation sweep in this range. The findings below are what the review found anyway.

**Everything is fixed except L4 and the residual half of H1's window, both named below.**

---

## H1 — a completed reset leaves in-flight old-password logins holding live sessions. **Fix, on the login path.**

25 of 25 survivors across five rounds, each a fully privileged `ACTIVE` session answering
`GET /auth/session` with 200, living 7 days or 30 with "remember me", idle clock renewed on every
use. The vulnerable window is one Argon2id verification wide and **grows with the security
parameter** — ADR-0014 targets ~250 ms in production against the ~40 ms this harness runs at.

The reset endpoint exists to evict someone who knows the old password, and that is precisely the
party able to hold logins in flight. The victim then receives a `passwordChanged` notice saying
"Any other sessions were signed out", which is false.

**The fix, and it is provably complete rather than a narrowing.** Login already knows the exact hash
it verified. After `SessionService.issue` returns, re-read the credential and compare; if it no
longer matches, **revoke the session just issued and refuse with `INVALID_CREDENTIALS`**. Every
interleaving is then covered:

- If the login's `Session` insert lands **before** the reset's revoke, `revokeLiveForUser` sweeps
  the row — that is the existing mechanism, and it works.
- If the insert lands **after** the revoke, then the credential write committed before the insert,
  so the post-issue re-read observes the new hash and the login revokes itself.

There is no third ordering. Cost: one indexed read on a `@unique` column per successful login.

**The one trap.** D8's transparent rehash rewrites the hash on a successful login, so compare
against *the hash this request wrote if it rehashed*, not the hash it originally read — otherwise
every rehashing login revokes itself. Write the test for that case specifically.

Prove it with the review's own probe: five old-password logins in one `Promise.all` with a reset,
five rounds, counting live sessions and driving each returned cookie at `GET /auth/session`. It
must go from 25 survivors to 0, and the probe stays in the suite.

**What remains open after this, and say so plainly:** a login that has *already inserted* its
session and whose re-read races the reset's commit is still swept by the revoke, so nothing is left
in the reset direction — but `change-password`'s equivalent window is protected only by timing, not
by construction (the review measured 0 survivors and calls it an accident). Apply the same
post-issue check on any path that issues a session after verifying a credential, or state why not.

## M1 — the reset's compare-and-swap is asserted only by a fake. **Fix.**

Deleting the predicate leaves all 25 integration tests green, and `identity-fakes.ts`'s docblock
points at a probe that only covers `change-password`. This is ruling 58's family in the file that
explains ruling 58 — the same shape as Task 9's M1, one task later.

Add the integration probe that covers the **reset** path, then delete the predicate and paste the
red output. A unit fake cannot arbitrate two racing writers and its docblock must not claim to.

## M2 — ruling 70's fifth channel: `invitation`. **Fix, and correct the ruling.**

`renderInvitation` renders `inviterName` — a stored `User.name`, 200 characters of free text — into
the **text** part of a message carrying a live token link. The HTML part escapes; the text part does
not, and mail clients autolink a bare URL there. That is exactly how Task 8's H1 and Task 9's H2
were rendered.

- **Remove `inviterName` from the template's context type**, the structural fix rulings 63, 70 and
  71 all converged on. Task 15 sends this message and does not need the inviter's stored name to do
  it; if it later decides it does, that is a decision made against this history rather than a
  default inherited from a template nobody had run a hostile payload at.
- **`organizationName` stays**, and is not the same case: an invitation without the organisation's
  name is useless, and the value belongs to an accountable tenant rather than to any registrant who
  typed it. **But it is caller-influenced text in a link-bearing message**, so extend the ruling-70
  payload to run hostile values at the token-link templates too, asserting that the only URL present
  is the product's own link. Record that `organizationName` binds Tasks 13 and 15.
- **`ATTACKER_STRING_TEMPLATE_IDS` is an exempt list with one member**, and the docblock above it
  claims the test runs "over the whole registry, with no exempt list". Fix the test, then fix the
  sentence.
- **Carry-forward ruling 70's own text is false** where it says the invitation "already names
  nobody". The orchestrator owns that correction; report it and it will be written.

## M3 — `change-password` is a weaker guard on the password than `login`. **Fix the signal, not the ladder.**

The implementer's argument for keeping the endpoint out of the lockout ladder is sound and stands:
`ACCOUNT_LOCKED` on an authenticated route is a distinguishable outcome, and a session thief who
could lock the account gains a denial of service. What is not acceptable is the rest of the row: no
per-account bound, no lockout, and **no message to the owner at all**, on the one endpoint that
proves a password while requiring nothing but a stolen session.

**Send the owner a notice on a burst of failed current-password attempts.** `failedLoginBurst`
exists, renders nothing an attacker supplies, and says exactly the right thing. Count consecutive
failures for this purpose only — do **not** feed `failedLoginCount`, which would let a session thief
lock the owner out of `login` — and do not vary the response in any way.

The per-account 429 the review suggests is the right long-term answer and needs the limiter's
per-principal stage, which rulings 55 and 59 already owe. **Not this task.** Name it.

## L1–L7, P1–P7 — fix all except L4

- **L1**: `ownSessionRotated: true` is written before the rotation is attempted and can be false in
  an append-only row. Write what happened, not what was intended.
- **L2**: the unit lane cannot honestly evaluate "delete the predicate" — say so in the fake's
  docblock rather than letting a green unit run imply coverage.
- **L3**: `reset-password` pays the breach check and a full Argon2id hash before validating the
  token. Reorder unless the ordering is deliberate — and if it is, the reason belongs at the site.
- **L4 — NOT FIXED, and recorded.** "A reset for a user with no `Credential` row sets a password" is
  correct today (it keeps SSO-only accounts from being stranded) and is a **Phase 11 SSO bypass**:
  once `IdentityProviderLink` accounts exist, a reset link would mint password access to an account
  whose owner never had one. Only the first half was written down. Write the second half at the
  site and in `security/authentication.md` §6, and record it as binding Phase 11. Fixing it now
  would encode a Phase 11 decision this task cannot make.
- **L5**: a completed reset proves mailbox control and does not record it. It should — that is the
  same evidence `emailVerifiedAt` carries.
- **L6**: `audit.md` §4 describes `liveSessionsAtWrite` incorrectly for the change row.
- **L7**: a completed reset does not clear `lockedUntil`. It should: the person who proved mailbox
  control is the owner, and leaving them locked out after a successful reset is the failure mode
  reset exists to fix.
- **P1**: `password-reset.service.ts:342-344` asserts in code that H1's window does not exist. That
  is the worst sentence on the branch — it will be read by whoever next touches this file.
- **P2**: `security/authentication.md` §6 under-reports H1 fivefold. **P3**: `session.service.ts:695`
  still carries the original overstatement, uncorrected. **P4**: `api/authentication.md` §9 states
  the revocation without the residual. **P5**, **P6**: the two docblocks that describe coverage they
  do not have. **P7** is the orchestrator's.

Once H1's fix lands, P1–P4 describe a window that no longer exists in the reset direction — so
**write those sentences against the code as it ends up**, not against the code as it is now. That
is the trap ruling 22 keeps naming.

---

## What the fix round must not do

- Do not fix L4. Recording it is the deliverable.
- Do not widen scope beyond these dispositions.
- Do not describe a fix from memory: re-run the measurement that produced the finding — H1's
  five-round probe, M1's deleted predicate, M2's hostile render — and paste the output.
- **If a test you write goes red on something these dispositions did not predict, stop and report
  it. Do not reason it into silence.** That is ruling 70's meta-lesson and it has now been the
  proximate cause of a shipped High once and a near-miss twice.

Write `fixes.md`: one row per finding, what changed, the command or measurement that establishes it.
These fix commits **will be reviewed by a second fresh agent**.
