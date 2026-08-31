# Phase 2 · Task 8 — fix round

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-31. Dispositions in [`fix-brief.md`](fix-brief.md); findings in
[`review.md`](review.md).

## Who did this round, and why it matters

**The implementer subagent hit the weekly usage limit partway through and the orchestrator
finished the round directly.** It landed H1 and left an uncommitted, unverified M1 spec; everything
from M1 onwards is the orchestrator's own work.

This is worth stating plainly rather than burying, because the phase's execution protocol separates
implementer from reviewer on purpose and this round does not have that separation. The Phase 1
record says what to do about it: when usage limits force the controller to implement directly, say
so, and treat the review as *more* necessary rather than less. **Nothing in this round has been
adversarially re-reviewed**, and the honest reading of the "all green" table below is that it is a
self-report.

Two things partly offset it, and neither is a substitute. Every fix here is proved by re-applying
the reviewer's own mutation and pasting what went red — the standard is the reviewer's, not the
author's. And the round found **two defects in its own fixes** (L4 and L3, below), both by running
mutations rather than by reading the code, which is the mechanism working even without a second
agent.

## Outcome

**Eighteen findings: 17 fixed, 1 upheld and deliberately not fixed.** Every mutation the reviewer
recorded as surviving is now killed, except R9, which turned out not to be a survivor over
unprotected code (see L3).

| Finding | Disposition | Proof |
|---|---|---|
| H1 | Fixed structurally | Before: 3 failed / 86 passed. After: 89 passed. Re-adding the device line turns the same 3 red. |
| M1 | Fixed | R12b: `expected 'generalSession' to be 'registration'` ×3. |
| M2 | Fixed | R3: `expected 422 "Unprocessable Entity", got 200 "OK"`. |
| M3 | Fixed | `grep` returns no reference to either non-existent spec. |
| M4 | **Upheld, not fixed** | Ruling 65 — see below. |
| M5 | Fixed by the orchestrator | `roadmap.md`, in the same change that moves the status. |
| M6 | Fixed | Five present-tense counts; `app.module.ts:41` left as it is. |
| M7 | Fixed | Docblock now records that no failure event is written, and why. |
| M8 | Fixed | `expected undefined to deeply equal { …(3) }` without the implementation. |
| L1 | Fixed | `expected 'AAA…' to have a length of 512 but got 5000`. |
| L2 | Fixed | `expected '198.51.100.1' to be '203.0.113.7'`. |
| L3 | Fixed, and the finding was partly wrong | `expected [ 'body', 'err', … ] to deeply equal [ 'err', … ]`. |
| L4 | Fixed, on the second attempt | `promise resolved "undefined" instead of rejecting`. |
| L5 | Recorded, not edited | The report is a dated record; the correction is here. |
| L6 | Fixed | Now cites `conventions.md` §2. |
| L7 | Fixed | `status` dropped from the lookup, with the reasoning written down. |
| L8 | Fixed | `testing.md` records the widened flake surface. |
| L9 | Fixed | R14: `expected 'Someone tried to create a Sentinel ac…' to contain 'no action is needed'`. |

## The two defects this round found in its own fixes

Both were caught by running a mutation against a fix that had just gone green, which is the only
reason they are here rather than in the next task's review.

**L4's first test was vacuous, and it is the third instance of ruling 58 in three tasks.** The test
issued a token through `resend`, deleted the user, and called `verify` — and passed. Re-applying the
mutation showed it still passed, so a diagnostic was added: the call trace ended at
`tx.verificationToken.updateMany` and never reached `tx.user.findUnique`. The fake's `updateMany`
always reports `count: 0` — deliberately, and its own docblock says so — so `verify` threw at
`consumed === null`, and the test asserted the refusal it was *already* getting for an unrelated
reason. **A test that passes before and after the mutation is not a test.**

The branch also cannot be reached from the integration suite: `VerificationToken.userId` is
`onDelete: Cascade`, so deleting a user deletes their tokens and there is no live token left to
redeem. That is why the fake gained a narrow `control.redeemableUserId`, documented as faking the
*outcome* of a redemption and never its concurrency property, which
`token.service.integration.spec.ts` owns against real Postgres.

**L3's finding was measured and turned out to be partly wrong.** The reviewer's R9 adds the rendered
body to the mailer's warn bindings and the suite stayed green, which was read as "the body reaches
a log line and only the redactor stops the token". Re-running it with the emitted line printed shows
something else:

```
{"level":"warn",…,"templateId":"emailVerification","recipient":"ada@example.test",
 "body":"[redacted]","text":"[redacted]","err":{…}}
```

The redacting serialiser blanks the field **names** `body` and `text` outright, so the body never
reaches the line at all and **no value-based assertion can fail under R9** — including the first
version of this round's own fix. The field-name denylist is a genuine second line of defence, not
the incidental one the finding assumed.

It is still not the *first* line, and the code comment claims the first: `deliver` does not pass the
body. A binding named something outside the denylist would carry it straight through. The assertion
that holds that claim is an exact key set, because a new binding changes the keys whether or not its
value survives redaction — and that one does kill R9.

## M4 — upheld as false, deliberately not fixed

The report and the migration comment both say `AuditEvent`'s trigger message changes when the
function is replaced. The reviewer measured that it does not: `TG_TABLE_NAME` on `AuditEvent` *is*
`AuditEvent`, so the rendered text is byte-identical.

`20260828051452_platform_audit_event/migration.sql` is **left byte-unchanged**. Carry-forward
ruling 2: editing an applied migration changes its checksum and breaks `prisma migrate dev` locally
until a reset. Carry-forward ruling 3: `pnpm db:reset` cannot be run by an agent. So correcting one
imprecise clause would cost the operator a manual database reset, to buy a sentence that overstates
a change that did not happen — in the direction that makes an operator look *more* carefully at
something that turned out to be safe.

Recorded as **ruling 65** instead: a migration comment is effectively immutable the moment it runs,
so every claim in one must be measured before the migration is applied.

Two corrections to the report that are recorded here rather than edited into it, because it is a
dated record of what was said at the time:

- **M4.** The old literal appears in **three** files, not two.
- **L5.** The quotation attributed to the parity spec is in `id.ts`.
- **M2.** "the specs cover `LOCKED` and `DISABLED` by name" was true of `resend` and not of
  `verify`. It is true of both now.

## Verification, on the finished tree

Exit codes captured outside a pipe (`out=$(pnpm <cmd> 2>&1); code=$?`).

| Command | Exit | Figures |
|---|---|---|
| `pnpm format:check` | 0 | — |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm test` | 0 | **76 files / 1125 tests** (from 73 / 1085) |
| `pnpm check:specs` | 0 | **93 spec files** (from 90) |
| `pnpm test:integration` | 0 | **17 files / 230 tests** (from 17 / 229) |
| `pnpm build` | 0 | 8 tasks |
| `pnpm check:openapi` | 0 | **7 routes**, byte-identical, now carrying request bodies |
| `pnpm check:registry` | 0 | 15 models — 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm check:secrets` | 0 | 368 tracked files |
| `docker compose ps` | 0 | four services `Up (healthy)` |

`pnpm test:e2e` was not run and has no row: this task touches no `apps/web` path.

## Still open after this round

- **Nothing here has been adversarially reviewed**, per the first section.
- **The resend timing oracle stands.** No account 4.0 ms, already verified 4.2 ms, awaiting
  confirmation 8.6 ms, with non-overlapping ranges — the body is byte-identical and the latency is
  not. The reviewer did not re-measure it and neither did this round. It needs the Phase 4 queue.
- **`registrationAttempt` is the only notice that refuses caller-supplied context.** The other four
  still render a user agent, which is correct — there the string describes the recipient's own
  session — and `registry.spec.ts` now *characterises* that rather than asserting it is safe.
- **No audit event is written for a failed verification**, because the refusal rolls back the
  transaction the event would live in. `audit.md` §3 wants failures audited. Task 9 meets this
  harder, with failed logins.
- **`EMAIL_NOT_VERIFIED` governs no route.** The guard is built and proved against test
  controllers; Task 13 applies it.
