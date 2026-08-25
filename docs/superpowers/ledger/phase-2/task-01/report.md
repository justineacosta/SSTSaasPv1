# Phase 2 · Task 1 — implementer's report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-24 to 2026-08-25. One implementer subagent across five stages, with an operator
migration-SQL gate between stages. Commands and exit codes only; every sentence asserting anything
was written by the orchestrator, per the plan's Execution protocol §3.

## Stages

| Stage | Scope | Gate |
|---|---|---|
| A | Failing re-invite test captured; `@@unique` removed; migration A generated `--create-only` and hand-written | Operator reviewed migration A SQL |
| B | Migration A applied; `id.ts` docstring fixed; identity expansion; migration B generated and hand-written | Operator reviewed migration B SQL |
| C | Migration A's false drift paragraph rewritten; full verification | Blocked on `db:reset` — see below |
| D | Adversarial review's findings: CHECK constraint, `secretKeyVersion`, four prose corrections | Stopped at a red suite, as instructed |
| E | Two Phase 1 test writes made legal; CHECK moved into migration A; account-deletion claim corrected | — |

## Final verification, re-run by the orchestrator rather than taken on report

| Command | Exit | Result |
|---|---|---|
| `pnpm test:integration` | 0 | 11 files / 148 tests |
| `pnpm test` | 0 | 32 files / 416 tests |
| `pnpm build` | 0 | 8 tasks |
| `pnpm check:registry` | 0 | 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm format:check` | 0 | all files |
| `pnpm check:specs` | 0 | 43 spec files |

Migration B applies to fresh empty Testcontainers databases on every `packages/db` integration spec,
which is separately one of Task 1's stated verification criteria.

## Test-first evidence, both migrations

**The re-invite test failed before migration A and passed after.** Before: `P2002 Unique constraint
failed on the fields: (organizationId, userId)` on the second insert. After: 3/3 green. The third
case — a second *live* membership is still refused — passed in both runs, which is correct: it
guards the half of the invariant the full index already got right.

**The four CHECK-divergence tests failed before the constraint and passed after**, re-run after the
constraint moved into migration A: four `promise resolved instead of rejecting`, then 8/8 green.

## What the constraint caught immediately

Adding the CHECK turned two **pre-existing Phase 1 integration tests** red —
`tenant-client.integration.spec.ts:174` and `tenant-transaction.integration.spec.ts:277` — both
writing `status: 'REMOVED'` without `deletedAt`. Those writes were always semantically wrong and
nothing could notice until the invariant was written down. A third site (`:298`, which restores
`status: 'ACTIVE'` and had to clear `deletedAt`) surfaced only after the first two were fixed.

The implementer's own note on that third site is worth keeping: *"'find every write of X' is not the
same question as 'find every write that must now change', and I answered the first while reporting
the second."*

## Blocked, and why it is not a Task 1 defect

`pnpm db:reset` cannot be run by an agent here. Prisma 6.19.3 ships a guard that refuses
`migrate reset` on detecting an AI agent and requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
set to the literal text of the user's consenting message, explicitly excluding any earlier message.
The implementer refused to fabricate a consent string, which was correct.

The reset is needed only because migration A's comment was corrected after it had been applied,
changing its checksum. Nothing in the plan or `.claude/development/setup.md` anticipated the guard,
and it will recur on every future reset.
