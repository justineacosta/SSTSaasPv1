# Task 9 dispositions — what the fix round changes, and what it deliberately does not

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31, after reading
[`review.md`](review.md) at `f7007b4`. Twelve findings: 2 High, 3 Medium, 7 Low. **Eleven are
fixed; one is accepted and named.** Every disposition below is mine, not the implementer's.

The review reproduced all eleven evidence rows and turned 12 of its 13 mutations red, so the
unit suite around `LoginService` is not in question. What follows is what it found anyway.

---

## H1 — the lockout ladder does not count concurrent attempts. **Fix.**

Measured through the real application: five parallel wrong passwords leave `failedLoginCount` at
**1**, no lock, zero `ACCOUNT_LOCKED` rows, zero burst notices, and a correct password immediately
after answers 200. `recordFailure` reads the row, spends ~40 ms in Argon2, then writes
`failedLoginCount + 1` as an **absolute value**. Every existing lockout test is sequential, which
is why the whole gate is green over a control that does not engage.

**The fix is an atomic increment, not a longer transaction.** `UPDATE … SET "failedLoginCount" =
"failedLoginCount" + 1 … RETURNING`, and the lock computed from the value the database returns —
not from the value read before the hash. `IdentityUserUpdateData`'s union is what makes this
unexpressible today: add an arm for it rather than loosening the union into a `Partial`, because
ruling 6's habit (each arm is a complete statement of one operation) is right and is not what
caused this.

This also fixes the burst notice's once-per-lock semantics for free: row-level locking serialises
the increments, so exactly one transaction observes the count crossing the threshold. Do not
re-derive "did I trip it" from a re-read.

**The test that must exist**, and it must be seen to fail against the current code first:
concurrent attempts through the real application — the review's probe is the specification. A
sequential test cannot catch this and we now have proof of that.

## H2 — `newDeviceSignIn` renders 512 characters of attacker-chosen text to the victim. **Fix, and wider than the instance.**

This is the **third** channel of the same defect: H1 in Task 8 (the `User-Agent` in
`registrationAttempt`), F1 in the Task 8 fix round (the display name), and now the `User-Agent`
again, in the one notice whose entire purpose is to warn a victim that somebody else is in their
account. The rendered proof is in the review: a `Device:` line carrying
`https://sentinel-verify.evil.example/login`, under a footer promising the message contains no link.

**Remove the user agent from the notice templates' rendered output entirely** — `whereAndWhen` in
`notice.templates.ts`, so all five notices, not only the one with a caller today. Keep `When:` and
keep `IP address:`: a socket peer address is not free text, cannot carry a URL, and is bounded and
validated already.

**This supersedes ruling 63's carve-out**, and that is a deliberate act to be recorded as such.
Ruling 63 licensed a device string on four templates because "there it describes the recipient's
own session". H2 is the case that reasoning did not consider: on the takeover path the recipient
and the chooser are **different people**, which is precisely the condition ruling 63's own sentence
forbids. A rule with an exception that has now produced three findings in three tasks is not a rule
with an exception; it is a rule nobody is following. Write it as a Task 9 ruling that names 63 and
says what changed.

Two consequences to close in the same commit, or the finding recurs a fourth time:

1. **`registry.spec.ts`'s characterisation sentence is now false and its risk acceptance is void.**
   It reads "*none of the four has a caller yet (Tasks 9 and 11 add them)*". Task 9 shipped the
   caller, edited that file, and left the sentence. Correct it to state what is true after this fix.
2. **Apply ruling 70's prescribed test to every notice**: no link when *every* caller-supplied field
   is a URL. The existing test passes benign values for `ipAddress` and `userAgent` and hostile text
   only for the name, which is how it stayed green over this. That is carry-forward ruling 58's
   family again — a fixture sitting on one side of the branch under test.

## M1 — the tenant transaction the docblock calls "NOT OPTIONAL" is protected by nothing. **Fix.**

Mutation B replaced `withTenantTransaction(…)` with a direct client call — the exact code the
docblock says returns `null` in production — and **both lanes stayed green** (81/1252 and 18/275).
The application under integration test connects as the container superuser and bypasses RLS
entirely; `appPrisma` exists but the only spec using it drives the raw client, never the lookup.

Make the spec that drives `activeOrganizationLookup` run over the least-privileged role, and prove
it by re-running mutation B and watching it go red. Paste that output. A protection that no test can
observe is a comment, and this file spends sixty lines explaining ruling 58 before demonstrating it.

## M2 — a denial on a DISABLED or LOCKED account writes no audit event. **Fix.**

Measured: a **correct** password against a disabled account returns 403 and zero new
`PlatformAuditEvent` rows. `security/audit.md` §3 requires denials to be audited, and this is the
most investigation-relevant denial this endpoint can produce — somebody holding a working credential
for an account an operator deliberately switched off.

Write the row, in the same transaction as nothing else (there is no state change, so the transaction
carries the event alone). The report's argument for writing nothing on a *live brute-force lock*
does not reach this path: reaching it requires the correct password, so it is not a table an
unauthenticated caller can grow at will, and no `ACCOUNT_LOCKED` row exists for an administrative
status.

## M3 — the burst notice is sent inside the request. **Accepted, and it must be named. Do not fix.**

This is carry-forward ruling 68's shape on a new endpoint: the fifth wrong password against a real
address pays an SMTP round trip that the fifth against an unknown address does not. It is **not
closable without the Phase 4 queue** — the difference is a real send happening inside the request —
which is exactly the disposition ruling 68 recorded for the resend endpoint, and the same reasoning
binds here.

Two things make it materially weaker than ruling 68's oracle, and both belong in the record rather
than in an argument for ignoring it: reaching it costs five failed attempts against one address
(ruling 68's cost one request), and the per-account window is 5 per 15 minutes.

**What the fix round owes is sentences, not code**: name it in `security/authentication.md` §2's
residual list, in §7's burst-notice paragraph, and in the report. The reason this is a finding at
all is that it was named nowhere — the report claimed one residual and this one is larger by orders
of magnitude.

## L1–L7 — the prose findings

Fix **L1, L2, L3, L4, L6** as written: a citation to a file that does not exist, a docblock quoting
a line that was never written, a `@deprecated` export kept for "its two specs" that reference it
zero times, two report citations that name the wrong lane and the wrong ruling, and a route count
of six in a file that says ten four lines later. None is expensive; all five are the class that has
cost this project more than its code defects.

**L5 — `AccountLockedError` tells a disabled user three false things. Fix.** "Temporarily locked",
"try again later", "reset your password" are all false for an administratively disabled account.
Keep **one code and one message** for both kinds — `api/authentication.md` §6's one-refusal rule is
right and distinguishing them would answer a question the caller should not get answered — and
rewrite that message so it is **true of both** and distinguishes neither. It currently achieves
non-disclosure by lying to the legitimate user, which is a worse trade than a vaguer sentence.

**L7 — the "one attacker must not lock out a whole tenant" bound. Document, do not fix.** The
arithmetic is right: 20 attempts per 15 minutes per IP at 5 attempts per lock is four locks per
window, and roughly eight accounts held permanently at the 30-minute cap from a single address.
`abuse-prevention.md` §1 and `api/authentication.md` §7 currently present the two windows'
independence as if it satisfied §7's sentence. It bounds the damage; it does not prevent it. Write
the bound, with its arithmetic, in §7 — a control described as stronger than it is will not be
re-examined by the person who most needs to.

---

## What the fix round must not do

- Do not fix M3. Naming it is the deliverable.
- Do not touch anything outside these dispositions. A fix round that widens scope is a fix round
  nobody can review against a list.
- Do not describe any fix from memory. Re-run the measurement that produced the finding — H1's
  concurrency probe, M1's mutation B — and paste the output. Carry-forward ruling 66: a test that
  passes both before and after the mutation is not a test.
- **A red test that this round turns off needs a second pair of eyes, not a comment.** That sentence
  is ruling 70's meta-lesson, it was written after a fix round reasoned a red test into silence, and
  it is the single most likely way this round goes wrong.

Write `fixes.md` in this directory: one row per finding, what changed, the command or measurement
that establishes it, and the finding's disposition where it differs from "fixed". These fix commits
**will be reviewed by a second fresh agent** before this branch is verified — Task 8's fix round was
not, and that is how it shipped an open High.
