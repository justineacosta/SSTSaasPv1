# Phase 2 · Task 8 — adversarial review brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-28. Written by the orchestrator after the implementer finished and before the
reviewer starts. Range under review: **`a39f4b3..HEAD`** on `feat/phase-2-task-08`, twelve commits,
44 files, +5035/−93.

You are a **fresh** reviewer. You did not write this code and you must not defend it. Your job is
to find what is wrong, and the standard this project holds you to is that **you prove a finding by
measurement, not by argument** — you run the command, you apply the mutation, you paste the failing
output.

## Pass 1 — citation, before you open a single diff

This project's dominant defect class is not bad code. It is **false factual claims in written
prose**: twelve on the Phase 1 branch, five of them introduced while correcting an earlier one, and
at least one in every Phase 2 task since. Task 7's worst finding was a sentence in the
orchestrator's own brief that propagated into a code comment and two documents.

So: before reviewing any code, re-verify every factual claim in
[`report.md`](report.md) against the actual repository. Run the command. Open the file at the line
cited. `git show` the range. Check the section numbers of every `.claude/` citation in the new code
comments and the changed documents — a comment attributing a quotation to
`security/authentication.md §6` is a claim about a document, and `grep` settles it.

**The two claims below are the orchestrator's, not the implementer's, and they are in scope for
this pass.** If either is false, that is the most valuable finding you can produce:

1. **ADR-0019 and the `platform_audit_event` migration both state a measurement**: that on a scratch
   table carrying `AuditEvent`'s exact RLS policy, as `sentinel_app`, a tenant-scoped insert
   succeeded and a `NULL`-organisation insert was refused with
   `new row violates row-level security policy`. Reproduce it or contradict it. The whole ADR rests
   on it.
2. **The brief's ruling D** claims that a route carrying no rate-limit class falls to
   `generalSession` at `rate-limit.guard.ts:249`, that `generalSession` is `failMode: 'open'` with
   `perPrincipal: 'authenticated'` as its only scope, and that **nothing warns** when that scope
   fails to resolve at the default log level. That chain is carry-forward ruling 55, and it was
   wrong once already in the opposite direction.

## Pass 2 — the code

Read the brief's rulings A–G first. They are the decisions the implementer was told to implement;
a deviation from one is either a finding or a correction, and you say which.

### Where I would look hardest

These are my suspicions as orchestrator, not a checklist, and finding something I did not list is
worth more than confirming something I did.

- **The `CREATE OR REPLACE FUNCTION audit_event_is_append_only()` in the new migration changes an
  object `AuditEvent`'s existing triggers depend on.** The message goes from a hard-coded
  `AuditEvent` to `TG_TABLE_NAME`. The implementer says no spec asserts the old literal. Verify
  that against `packages/db/src/rls.integration.spec.ts` and everything else, and then ask the
  harder question: is replacing a function that a *shipped* table's tamper-resistance depends on
  the right move at all, versus a second function? What happens to `AuditEvent`'s guarantee if this
  migration half-applies?
- **`TokenService` was modified.** It is a shared file that Tasks 10 and 15 also depend on, and it
  gained `issueInTransaction` / `consumeInTransaction` with `issue` / `consume` now wrapping them.
  The advisory-lock property in `issue` (carry-forward ruling 31) and the single-conditional-UPDATE
  property in `consume` are both load-bearing security controls. **Mutate both and confirm the
  existing specs still kill the mutants** — a refactor that quietly moves a lock outside a
  transaction passes every sequential test.
- **The partial unique index** (`VerificationToken_userId_purpose_live_key`). The implementer
  claims it never fires for `TokenService.issue` across 10 rounds of 4 concurrent callers, and
  that it does refuse a writer bypassing the service. Both halves matter; the second is the reason
  the index exists.
- **The enumeration byte comparison.** Carry-forward ruling 58: check whether the fixtures all sit
  on one side of the branch under test before believing the test. The implementer reports breaking
  it deliberately and seeing 3 of 8 go red — and that one of those three failed for an incidental
  `requestId` reason, which is a small honesty worth checking rather than taking.
- **The resend timing oracle the implementer disclosed.** 25 samples: no account 4.0 ms, already
  verified 4.2 ms, awaiting confirmation 8.6 ms, with non-overlapping ranges. Re-measure it. If it
  reproduces, the questions are whether it is stated in the right places and whether anything in
  this task could have closed it cheaply — not whether it should have been hidden.
- **Registration's own timing.** The implementer measured 47.8 vs 44.5 ms median with near-total
  overlap and therefore committed **no** statistical timing assertion, asserting instead that the
  hash happens on both paths. Decide whether that assertion can actually fail — a spec that
  observes "a hash happened" can be satisfied by a hash of the wrong thing.
- **The `emailVerifiedAt` gate** governs zero real routes by design (brief ruling F). Carry-forward
  ruling 61: a handler-level exemption must be tested at the **class** level too, with an
  inheritance case, because `getAllAndOverride` walks the prototype chain. This codebase has
  shipped that exact bug once. The implementer reports six kills in that family — verify the tests
  are not vacuous.
- **The eighth email template.** It must carry no link and no token, sit in `NOTICE_TEMPLATE_IDS`,
  escape an attacker-chosen display name, and not echo the recipient's address.
- **`auth.module.spec.ts`'s "registers no controller" assertion had been red on this branch and was
  only noticed during the mutation run.** Ask what else was red and unnoticed, and for how long.
- **The three routes are `@Public()`** and therefore not CSRF-covered (carry-forward ruling 56).
  Confirm that is true of what shipped, and that a stale session cookie cannot 403 them.

### The standing traps in this codebase

Every one of these has produced a real defect here before:

- A spec that passes with its own module deleted (Task 2).
- A `.test.*` file that executes nothing while `pnpm test` prints green (Phase 1).
- An equality assertion between two values both derived from `Date.now()` in the same test
  (ruling 49).
- A mutation reverted in `schema.prisma` without `prisma generate`, leaving a clean `git status`
  and a stale generated client (ruling 39).
- `pnpm test` and `pnpm lint` green while `pnpm typecheck` is red (ruling 40) — and this task hit
  that again mid-implementation.
- Restating a Prisma enum or an ID prefix without a parity spec (rulings 5, 13, 27).

### One deviation the implementer already declared

Brief ruling A told the implementer to add the new id prefix to **both** registries. They put `pau`
into `id-prefix-parity.spec.ts`'s `DB_ONLY_PREFIXES` allowlist with a written reason instead,
matching how `aud` is handled, and said so plainly. **Test it rather than accepting my ruling or
their deviation** — the question is whether the parity spec still fails when it should, and whether
a client-facing schema for a row no API addresses would have been dead weight.

## Verification you re-run yourself

Do not take the report's table. Re-run all eleven, capturing the exit code **outside a pipe**
(`out=$(pnpm <cmd> 2>&1); code=$?`):

```
pnpm format:check · pnpm lint · pnpm typecheck · pnpm test · pnpm check:specs
pnpm test:integration · pnpm build · pnpm check:openapi · pnpm check:registry
pnpm check:secrets · docker compose ps
```

The orchestrator has already re-run all eleven at exit 0 with: 73 files / 1085 unit tests, 90 spec
files, 17 files / 229 integration tests, **7 routes**, 15 models (3 / 1 / 11), 365 tracked files,
four services healthy. If any of your numbers differ from those, that difference is itself a
finding.

## How you report

Write to `docs/superpowers/ledger/phase-2/task-08/review.md`. For each finding:

- **Severity** — High / Medium / Low, and say what the severity is *for* (a security control that
  does not hold, versus a comment that is untidy).
- **The proof.** The mutation you applied, or the command you ran, with its real output pasted.
  "This looks wrong" is not a finding here; "I deleted this line and 1085 tests stayed green" is.
- **Findings against prose count**, and are ranked the same way as findings against code. A
  document, comment, or report sentence that is not true is a defect of the class this project
  keeps producing.

If you find nothing High, say so plainly and say what you attacked — Task 7's review found no High
and the honest framing of that ("the reviewer wrote twelve mutations of its own and the only
survivor was a missing test over correct code") was worth more than the headline.

Do not fix anything. Findings only; the orchestrator dispositions them and a fix round follows.
