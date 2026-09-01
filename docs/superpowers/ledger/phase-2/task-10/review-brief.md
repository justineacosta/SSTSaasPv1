# Task 10 review brief — the adversarial pass

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31, at `feat/phase-2-task-10` = `df010a1`.

You are a **fresh adversarial reviewer**. You did not write this code and you owe it nothing.

## 1. Your first pass is citation, not code

**Before you open a diff**, re-verify every factual claim in [`report.md`](report.md) against the
repository. Run the command. Open the file. `git show` the range.

Phase 1 shipped twelve false factual claims in prose, five introduced while correcting an earlier
one. Task 9's review found four more in the files that had just been rewritten to fix a fifth. The
sentences are assigned to you.

Check especially:

- Every row of the evidence table, re-run, exit code captured **outside a pipe**
  (`out=$(pnpm <cmd> 2>&1); code=$?`).
- Every ruling number a comment cites — open `progress.md` and confirm the ruling says that. Rulings
  6, 37, 44, 45, 51, 55, 56, 62, 64, 66, 68, 70–80 are in play.
- Every `.claude/` section a docblock quotes: `grep` the quoted string. Carry-forward ruling 11 is
  the precedent — a phrase attributed to a document that contains no such string reached a comment.
- **The five claims the implementer makes about my brief being wrong** (report §"Things in the brief
  I found false or incomplete"). Two are corrections of mine and get the same scrutiny as anything
  else. Ruling 22: a decision can be right while the reason written beside it is false.
- **The implementer's own two findings.** It reports a probe that was green for the wrong reason,
  and a measured hole in D2's ordering claim. Reproduce both. A self-reported finding is still a
  claim.

## 2. Then the code

Task 10 ships `forgot-password`, `reset-password` and `change-password`, closes ruling 70 across
every template, and pays Task 9's ADR-0014 rehash debt. The brief is [`brief.md`](brief.md),
decisions D1–D9 — **read it, and do not treat it as correct.** The implementer already found five
problems in it.

Review against the documents, not the brief: `.claude/security/authentication.md` §2, §3, §6, §7;
`.claude/api/authentication.md` §2, §6, §7; `.claude/security/abuse-prevention.md` §1;
`.claude/security/audit.md` §3, §4; `CLAUDE.md`'s critical rules.

Where to push hardest:

1. **The racing login (finding 2).** The implementer measured one live session surviving a reset and
   calls the fix "owed and not built". Decide whether that is acceptable to ship or is a High: after
   a completed password reset, a session minted with the **old** password is alive. Establish how
   long it lives, what it can reach, and whether idle/absolute expiry or anything else bounds it.
   This is the single most important question in this review.
2. **Compare-and-swap on both password paths (D3).** Mutation H survived once already. Try to defeat
   each CAS yourself — reset, change, and the rehash — and confirm each mutation turns a test red.
   Check the reset path in particular: its credential read happens inside the transaction, which is
   a different shape from change's.
3. **Revocation scope.** Reset must revoke every session including an attacker's; change must revoke
   every *other* one and rotate the caller's. Verify the rotation actually happens (§3 calls a
   password change a privilege change) and that the caller's old token stops working.
4. **Ruling 70 (D1).** Verify no template renders a stored display name, and that the residual test
   was **deleted rather than adjusted**. Then try to get attacker-chosen text into any message
   reaching somebody who did not choose it — this defect has been closed four times across Tasks 8
   and 9 and found again each time. Assume a fifth channel. The `passwordReset` template carries a
   **live link**, which is what makes it the worst instance if anything survives.
5. **Enumeration.** `forgot-password` must answer identically for an unknown address, an unverified
   one, an active one, and a `LOCKED`/`DISABLED` one. Check the paths the byte comparison does *not*
   cover, and check `reset-password`'s refusals — unknown, expired, consumed, superseded, non-ACTIVE
   user — are one code and one message.
6. **The decisions the brief left to the implementer** (report §"Decisions the brief left to me").
   Several are load-bearing and none was reviewed: a reset for a user with **no credential row sets
   a password**; unverified accounts receive reset links; `change-password` is deliberately outside
   the lockout ladder; the breach check sits on opposite sides of verification on the two paths.
   Each is defensible and each could be wrong.
7. **The rehash (D8).** It must never fail a login, must not undo a concurrent password change, and
   must not change the response. Make the credential write fail and confirm the login still
   succeeds.
8. **The audit trail.** Same transaction as the change (`CLAUDE.md` rule 10), `PlatformAuditEvent`
   only (ruling 62), no secret in metadata, and denials audited (ruling: Task 9's M2 was exactly
   this gap). Check `liveSessionsAtWrite` measures what its name says.
9. **The tests.** Rulings 58, 66 and 74: mutate the implementation and watch. A test that passes
   both before and after its mutation is not a test — and finding 1 shows a *concurrent* test can
   still be vacuous if the two requests differ in more than the property under test. Re-run the
   implementer's eight mutations, then invent the ones it did not.
10. **The last commits are the least-examined code on the branch.**

## 3. How to report

Write `docs/superpowers/ledger/phase-2/task-10/review.md`: findings graded **High / Medium / Low**,
each with the evidence that establishes it (a command's output, a mutation that stayed green, a
file:line) and what it costs if left. Separate **code defects** from **false sentences in prose**.
Say plainly if you find nothing at a level rather than manufacturing a finding.

**Prove by measurement, not by argument**, wherever measurement is possible. You may modify files to
run mutations, but restore the tree and confirm `git status` is clean before writing your review.

Do not fix anything. Do not commit code. Commit only your review document, with a message ending:
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
