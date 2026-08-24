# Execution ledgers

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../.claude/product/roadmap.md) is the only authority on that.**

Every phase built subagent-driven leaves a ledger here: the briefs given to implementers, what they
reported, what the adversarial reviewer found, and every ruling with its cost if wrong.

**Ledgers are tracked in git and are never gitignored.** One folder per phase.

```
docs/superpowers/ledger/
  phase-1/    Production foundation — 16 tasks, built 2026-08-20 to 2026-08-22
  phase-2/    Identity — 18 tasks and one checkpoint, planned 2026-08-24
```

## Layout inside a phase

```
phase-N/
  README.md          provenance, and an honest note on what the ledger does and does not contain
  progress.md        the index and the current pause state — read this first
  task-NN/
    brief.md         what the implementer was asked to do, and told not to do
    report.md        the implementer's output: commands and exit codes, not prose
    review.md        the adversarial reviewer's findings, severity-ranked
    rulings.md       decisions taken during the task, each with its cost if wrong
  review-diffs/      git diffs over the ranges that were reviewed
```

Not every task has every file — see the phase's own README for what is actually present.

## The rule that makes a committed ledger safe

A ledger is a large volume of agent-written prose, and agent-written prose asserting things that
were not true was Phase 1's single recurring defect: twelve instances on that branch, five of them
introduced while correcting an earlier one.

So, without exception:

**A ledger entry never moves a status and is never cited as evidence that something works.**

Only `sentinel-verify`'s captured command output does that, and only in `roadmap.md`. Read a ledger
for *why* a decision was taken. Never read it for *whether* something currently works.

## Where `.superpowers/` fits

`.superpowers/` is the subagent tooling's own scratch directory and stays gitignored
(`.gitignore:81`) — it is working space, not a record. Anything written there that belongs in the
record is moved into the matching `phase-N/` folder as part of the task, not left behind. Phase 1's
ledger was recovered from exactly that mistake.
