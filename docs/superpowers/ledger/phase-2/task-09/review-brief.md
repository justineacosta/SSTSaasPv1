# Task 9 review brief — the adversarial pass

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31, at `feat/phase-2-task-09` = `95650a3`.

You are a **fresh adversarial reviewer**. You did not write this code and you owe it nothing. Your
job is to find what is wrong with it, and the phase's history says the most expensive defects have
been *sentences*, not statements.

## 1. Your first pass is citation, not code

**Before you open a diff**, re-verify every factual claim in
[`task-09/report.md`](report.md) against the actual repository. Run the command. Open the file.
`git show` the range. The implementer's evidence table is a claim until you reproduce it.

This is not ceremony. Phase 1 shipped **twelve** false factual claims in prose, five of them
introduced while correcting an earlier one; Task 2's two most severe findings were sentences; Task
3's worst finding was a brief's own justification, wrong by ~100×; Task 8's fix round propagated one
unverified sentence about the redacting logger into four places. Nobody was assigned the sentences
until this phase started assigning them. **You are assigned the sentences.**

Check in particular, because each is a claim someone would have to trust:

- Every row of the report's evidence table, re-run on this tree, exit code captured **outside a
  pipe** (`out=$(pnpm <cmd> 2>&1); code=$?` — `$?` after a pipe reports the wrong stage).
- Every ruling number the code cites. Open `progress.md` and confirm the ruling says what the
  comment claims it says. A comment citing "ruling 63" that describes something else is the exact
  defect class this phase keeps producing.
- Every document section a comment or docblock quotes. `grep` the quoted string in `.claude/`. If it
  is not there, that is a finding, and carry-forward ruling 11 is the precedent: a phrase attributed
  to `authentication.md` §2 that appears in no authentication document reached a code comment.
- **The four claims the implementer makes about my brief being wrong** (report's closing section:
  the `app-setup.ts` guard wiring, the `Organization` RLS gap under D8, the `requestId` in error
  envelopes under §4, and ruling 70's applicability to `newDeviceSignIn`). Two of those are
  corrections of mine and I want them checked as hard as anything the implementer wrote. If a
  correction is itself wrong, say so — carry-forward ruling 22: *a decision can be right while the
  reason written beside it is false, and the false reason is still a defect.*

## 2. Then the code

The task is login, logout, `GET /auth/session` and per-account lockout. The brief it was built to is
[`brief.md`](brief.md), decisions D1–D11. Read it, but **do not treat it as correct** — it is mine,
it has been wrong before, and the implementer already found four problems in it.

Review against the documents, not against the brief:
`.claude/security/authentication.md` §2, §3, §7; `.claude/api/authentication.md` §2, §3, §6, §7;
`.claude/security/abuse-prevention.md` §1; `.claude/security/audit.md` §3, §4; `CLAUDE.md`'s
critical security rules.

Where to push hardest, in the order I would look:

1. **Enumeration.** The response for a wrong password and for an address with no account must be
   indistinguishable — body, headers, status line. The implementer says it now substitutes
   `requestId` before comparing. Check what *else* varies that the substitution hides: header
   order, `Set-Cookie` presence, `RateLimit-*` values, `Retry-After`, content length. And check the
   paths that were never compared at all: a **locked** account, a **DISABLED** account, an account
   with **MFA**, and an address whose `Credential` row is missing.
2. **Timing.** Both paths must pay the Argon2 hash. The implementer states one structural residual
   (the absent account skips a `Credential` read) and explicitly says nothing was measured. Decide
   whether that residual is an oracle — Task 8's resend was measured at 4.0 ms vs 8.6 ms with
   non-overlapping ranges, which was a working oracle. **If you assert a timing property, measure
   it**; if you assert there is one and do not measure it, say that instead.
3. **The lock as a denial-of-service on the victim.** D2 says an attempt during a live lock changes
   no state, so an attacker cannot extend a lock forever. Verify that is what the code does, and
   that the ladder still climbs across lock cycles. Then ask the harder question: can one caller
   lock N accounts, and does the per-IP window actually bound that? §7's stated property is that one
   attacker must not lock out a whole tenant.
4. **The cross-site guard (D1).** It is a new security control on the login path. What does it
   refuse, what does it let through, and what happens when the headers are absent, duplicated, or
   arrays? Does it cover every route it should, and is it possible to reach login without it? Check
   that class-level metadata cannot widen or disable it — `rate-limit.guard.ts` records that exact
   escape happening in this codebase before.
5. **The session cookie and the CSRF cookie on the login response.** Attributes, both cookies,
   rotation on privilege change (§3), and that logout clears both. Logout is the **first
   cookie-authenticated route `CsrfGuard` has ever governed** — verify that is actually true of the
   shipped route and not merely of a fixture.
6. **`PENDING_MFA` (D9).** A pending session must be able to do nothing but complete MFA. The
   implementer says its token is unreachable by any shipped route. Try to reach one.
7. **The audit rows.** In the same transaction as the change (`CLAUDE.md` rule 10). No secret in
   metadata. `PlatformAuditEvent`, never `AuditEvent` (ruling 62). And the one the pause state
   handed this task: a **failed** login must actually leave a row — check the rollback paths.
8. **The two notices.** Rulings 63 and 70. Try to get attacker-chosen text into a message sent to
   somebody else: the display name, the user agent, the email address itself, a template's
   `attemptCount`. The Task 8 review found H1 reopened through a **second channel** after the first
   was closed; assume there is a third.
9. **The tests themselves.** Carry-forward rulings 58 and 66: a test that passes both before and
   after the mutation is not a test, and a fake's default can make it one. Do not read the tests and
   agree with them — **mutate the implementation and watch**. The implementer lists six mutations in
   report §3; run them yourself, and then run the ones they did not think of. A fake whose
   `updateMany` always reports `count: 0` already made one refusal test pass for the wrong reason in
   this phase.
10. **The last commits are the least-examined code on the branch**, which is where the previous task
    said the chain stops. Weight them accordingly.

## 3. How to report

Write `docs/superpowers/ledger/phase-2/task-09/review.md`:

- Findings as **High / Medium / Low**, each with: what is wrong, the evidence that it is wrong (a
  command's output, a mutation that stayed green, a file:line), and what it costs if left.
- **Prove by measurement, not by argument, wherever measurement is possible.** "This spec would
  still pass if X" is a claim; applying X and pasting the green output is a finding.
- Separate **defects in the code** from **false sentences in prose** (report, docblocks, `.claude/`
  documents, my brief). Both are findings; they are fixed differently.
- If you find nothing at a level, say so plainly rather than manufacturing a finding to fill it.
- Do not fix anything. Do not commit code. Commit only your review document.

You have the whole repository, the compose stack is running, and the integration lane works. Take
the time to run things.
