# Task 11 fix round — dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02 at `9953d77`, after
[`review.md`](review.md)'s verdict of **changes requested** — 1 High, 6 Medium, 8 Low, with H1, M1,
M5 and M6 named as merge gates.

The fix round is run by the **orchestrator**, as Tasks 8 and 10's were. The reviewer's own
instruction governs it: whatever changes, re-run the exact mutation that exposed it and paste both
states (ruling 66). For H1 that mutation is two concurrent `POST /auth/mfa/recovery-codes` followed
by a row count and a verification of the **last** code of each returned set, not the first.

## Verdict table

| # | Sev | Disposition |
|---|---|---|
| H1 | High | **Fix.** Per-user advisory lock on the regeneration transaction, plus `orderBy` on the consumer. |
| M1 | Med | **Fix.** Same lock on enrolment; the P2002 stops being reachable rather than being caught. |
| M2 | Med | **Fix, as a correction not a probe.** Rewrite the report's D4 paragraph and rename the `describe`. |
| M3 | Med | **Fix the sentence, not the timing.** Record the residual in §5. |
| M4 | Med | **Fix, contrary to the implementer's deferral.** Ship the eighth notice template. |
| M5 | Med | **Fix.** Correct the arithmetic in both sites and name the load-bearing control. |
| M6 | Med | **Fix.** Reword both sentences; the bullet stops being labelled **Built**. |
| L1 | Low | **Fix** the two committed copies. The brief's copy is a dated record and is corrected here instead. |
| L2 | Low | **Fix** the docblock. |
| L3 | Low | **Correct** in the report, by dated note. |
| L4 | Low | **Fix.** Capture the step at confirm time. |
| L5 | Low | **Fix by deciding**: send ungated, delete the unused selects, write the reason at the site. |
| L6 | Low | **Fix** with H1. |
| L7 | Low | **Fix** ADR-0018's citation. |
| L8 | Low | **Correct** my own sentence, by dated note. |

## The dispositions that are not simply "the reviewer is right"

**M4 — the eighth template ships, against the implementer's deferral and against my own brief.**
The implementer deferred it on ruling 43 (adding a template is a Task 5 registry change) and the
reviewer called the sizing wrong. The reviewer is right, and ruling 43 is the argument *for* fixing
it rather than against: ruling 43 records that no task owns the eighth template, which is precisely
the state in which this gap is never closed. `registry.ts`'s own docblock says a template is added
by writing one line there and one line in `registry.spec.ts`'s `CASES` table, and inherits every
assertion in that file by existing — the registry was built for this. Regeneration is the only MFA
state change that destroys a credential the owner is holding on paper, and
`auth.controller.ts`'s own OpenAPI text already names the threat it ships no detection for.

**M3 — the comment is corrected and the timing is left alone.** Padding `resolve()` to match the
recovery-scan cost would hand an unauthenticated caller ~2.5 s of CPU per request in production,
which is a worse defect than the residual it closes. The residual is "is this pending token live",
not "which account" and not "how many codes remain", and reaching a live pending token already costs
a correct password.

**M2 — no 25-round probe is committed.** The reviewer proved both stages of the D4 predicate
load-bearing by mutating the shipped code in both directions, which is reproducible from the tree
and a stronger artefact than a probe asserting a survivor count. What was wrong was the *sentence*,
so the sentence is what changes.

**L5 — the notices send ungated, and the unused selects go.** Both policies are defensible and the
diff currently states neither. These four routes are reachable only behind an `ACTIVE` session for
the account whose address is being mailed, and the notice **is** the detection control for the
stolen-session case, so suppressing it on an unverified address would remove detection exactly where
it is needed. `password-change.service.ts` — the nearest precedent for an authenticated security
notice — sends ungated too. Ruling 71's gate stays where it belongs: on notices reachable by an
*unauthenticated* caller, which is why the new-device notice on the MFA arm keeps it.

**Gap 5 is closed as not-a-defect, on the reviewer's measurement.** My own review brief told the
reviewer I suspected the per-pending-session attempt counter was undersized. It measured the outer
bound — re-authenticating costs a full password submission, which is on login's own lockout ladder —
and disagreed. That is the correct outcome and the suspicion was unfounded; it is recorded here
rather than quietly dropped.

## What is NOT fixed in this round, and who owns it

- **The promoted session is always 7 days, never 30** (gap 1). Confirmed correctly sized by the
  reviewer. Needs a `Session` column or a `rotate` parameter; both are wider than a fix round.
  Carried into the roadmap as owed.
- **Disable revokes no sessions** (gap 3) — reviewer agrees with the decision as shipped.
- **The recovery path's ~2.5 s wall-clock per request** (gap 4) — reviewer's explicit verdict is
  *acceptable as shipped*, with the sequential-Argon2 latency budget belonging to Phase 4.
- **Incremental key rotation itself.** M6 is a wording fix. Building the key-map lookup is a
  decision with an ADR in it and is not this task's.
