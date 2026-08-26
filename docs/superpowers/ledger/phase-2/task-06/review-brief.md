# Phase 2 · Task 6 — adversarial reviewer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch. You are a **fresh** reviewer: you
did not write this code, you inherit no belief about it, and your job is to break it.

## What was built

Phase 2 Task 6 — the session service. `SessionService`, `SessionRepository`, `RedisSessionCache`
and `cookies.ts` under `apps/api/src/modules/auth/`, five `SESSION_*` environment variables, and
one §3 update to `.claude/security/authentication.md`. Five commits on `feat/phase-2-task-06`
from `main` at `2fceaaa`. The implementer's brief is `brief.md` in this directory; its report is
`report.md`.

## Your first pass is citation, not code

This is the rule the plan's execution protocol §3 makes review-blocking, and it exists because
Phase 1's recurring defect was not bad code — it was **false factual claims in written prose, 12
instances on that branch, 5 of them introduced while correcting an earlier one.** Phase 2 has
added six more.

**Before you open a diff**, re-verify every factual claim in `report.md` against the actual
repository. Re-run each command and compare its exit code and its numbers. Open each file and
line it cites. `git show` each commit it names and confirm the file it claims appears in that
commit actually does. Check the citations in **code comments and in the `.claude/` document**, not
only in the report: a comment that quotes `security/authentication.md` §3, or ADR-0005, or an RFC,
is a claim, and Task 2 shipped exactly that defect — a comment quoting a document string that
`grep` proves does not exist.

Two claims in this task are measurements rather than arguments, and both are the kind that is
easy to write up more confidently than the run supports:

1. **The `__Host-`-over-`http://localhost` probe.** A code comment in `cookies.ts` states a
   Chromium version, a stored cookie, and two negative controls. Re-run the probe yourself.
2. **The rotation-concurrency conclusion** — that the affected-row-count decision serialises
   rotation where `TokenService.issue` needed an advisory lock (carry-forward ruling 31). Do not
   accept the argument. Fire the race yourself, many times, and see whether one credential can
   ever produce two live successors.

Only then review the code.

## Where to attack

The properties below are the ones whose failure is a security defect rather than an untidiness.
For each, the question is not "does the code look right" but "what interleaving, input or outage
makes it wrong, and can I demonstrate that".

- **Revocation immediacy** — a Phase 2 exit criterion. The design writes a *tombstone* rather than
  deleting the key, with a Lua compare-and-set that refuses to overwrite one. Attack the claim that
  no live entry can replace a tombstone: every write path into that key, every path that bypasses
  the script, TTL expiry of the tombstone while the row is still revoked, and what a second
  revocation does. The residual the implementer names (Redis unreachable *at revocation*) is
  disclosed; look for one that is not.
- **The two clocks.** `absoluteExpiresAt` must never move, `idleExpiresAt` must move only past the
  halfway mark. Find a path — rotation, renewal, remember-me, `PENDING_MFA` → `ACTIVE` — where the
  absolute cap is extended, or where a session outlives it. Rotation deliberately inherits the
  predecessor's absolute expiry; check the exception it carves out for MFA completion.
- **Rotation.** Two concurrent rotations of one session must yield exactly one live successor.
  Also: can a rotation resurrect a session that was revoked, expired, or already rotated between
  the read and the write? Is the predecessor always revoked when the successor is created — can a
  crash between the cache poison and the transaction leave both live?
- **`PENDING_MFA`.** Nothing enforces it yet (Task 7 does), but check that this task does not
  *undermine* it: can a pending session be rotated to `ACTIVE` without proving a factor, by any
  path reachable from the service's own surface?
- **The bulk revocations.** `revokeAllForUser({ except })` and `revokeAllForUserInOrganization` both
  enumerate live rows and then revoke. Is every enumerated session's cache key poisoned? What about
  a session created between the enumeration and the revoke — the implementer says the caller owns
  that ordering; check that the comment is where a caller will actually see it. For the
  organisation-scoped one, prove a consultant in four organisations removed from one keeps the
  other three.
- **The cookie.** `__Host-` requires `Path=/`, no `Domain`, and `Secure`. Check the clearing header
  matches on name, domain and path, that `Max-Age` is always `delta-seconds`, and that the value
  guard cannot be walked past. Is there any input reaching `serialiseSessionCookie` that produces a
  second header line?
- **Secret handling.** The raw token must exist in exactly one place per session and never be
  logged, never be a cache key, never enter an error message. Check the cache key derivation, the
  failure logs, the Zod error paths, and what a thrown validation error carries.
- **Redis down.** ADR-0005 promises a fallback to Postgres, not a failure. Point a client at a dead
  port and confirm every path degrades — including the two bulk revocations and rotation, not only
  `resolve`.
- **The environment variables and their cross-field rules.** Five were added inside a `ZodEffects`
  base object (ruling 30). Check that a malformed value fails at boot naming the variable, that the
  new refinement does not `return` early out of the shared `superRefine` and silently skip the two
  rules that follow it, and that the defaults match the numbers `security/authentication.md` §3
  actually states — where they do not, the document must say the number is a choice.
- **Ruling 33** — the integration suite shares one compose Redis and runs sequentially. Confirm no
  new spec calls `FLUSHDB`/`FLUSHALL`, that every key it creates is namespaced and cleaned up by
  key, and that nothing restores file parallelism.

## Mutation-test the tests, do not read them

A test that has not been watched failing has proven nothing. For the properties above, **break the
implementation deliberately and confirm the suite goes red for the right reason**: revert the
tombstone to a `DEL`, let renewal move `absoluteExpiresAt`, drop the `rotatedFromId`, remove the
`except` clause, make `writeLive` unconditional, widen the cookie value guard. Any mutation that
leaves the suite green is a finding, and it is a more valuable finding than a code-reading opinion.

Carry-forward ruling 39 binds you here: **an agent that mutates `schema.prisma` must run
`prisma generate` after reverting** — `packages/db/generated/` is untracked, so a clean
`git status` is not evidence that a mutation was undone. The Task 4 reviewer left a mutant enum
value in the generated client exactly this way.

## What is out of scope

Task 7's work: the authentication guard, reading a cookie off a request, CSRF, CORS, the
`PENDING_MFA` route restriction, and wiring the rate limiter. Do not report their absence as a
finding — report only where Task 6 has made Task 7's job unsafe or impossible.

`.claude/` documents other than `security/authentication.md` §3 belong to Task 7 and later tasks.

## How to report

Write `docs/superpowers/ledger/phase-2/task-06/review.md`, opening with the standard ledger banner
used by every other file in this directory. For each finding:

- **Severity** — High / Medium / Low, and say what the High ones would cost in production.
- **The demonstration** — the command, the mutation, the interleaving, the raw output. A finding
  you proved outranks a finding you argued; if you could not prove it, say so and label it as
  unproven rather than dropping it.
- **Where it is** — file and line.
- **What you checked and found sound**, briefly. A review that lists only failures does not tell
  the next reader what was covered.

Separate **citation findings** (a false or unsupported sentence in the report, a code comment or
the `.claude/` document) from **code findings**. Both are review-blocking; they are different
classes and the ledger tracks them separately.

Do not fix anything. Do not commit anything except your own `review.md`. Report, and the
orchestrator decides what is fixed and what is recorded as a ruling.
