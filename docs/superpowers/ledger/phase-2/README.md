# Phase 2 execution ledger

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Layout and the rules that govern every ledger are in [`../README.md`](../README.md). Phase 1's
ledger was recovered out of gitignored `.superpowers/` and now sits beside this one at
[`../phase-1/`](../phase-1/) — read its README for why, and for what it turned out to be missing.

## What lives here

One directory per task, `task-NN/`, containing:

| File | Contents |
|---|---|
| `brief.md` | What the implementer was asked to do, and what it was told not to do |
| `report.md` | The implementer's output: **commands and exit codes**, not prose (Execution protocol §3) |
| `review.md` | The adversarial reviewer's findings, severity-ranked, citation pass first |
| `rulings.md` | Every decision taken during the task, with **its cost if wrong** |

[`progress.md`](progress.md) is the index and the file to read first. It ends with the current
pause state.

## The rule that makes a committed ledger safe

This is a large volume of agent-written prose in a repository whose recurring defect — twelve
instances during Phase 1, five of them introduced while correcting an earlier one — was agent-written
prose asserting things that were not true.

So: **a ledger entry never moves a status and is never cited as evidence that something works.**
Only `sentinel-verify`'s captured command output does that, and only in `roadmap.md`. A ledger
entry records what was believed on a date. Read it for *why* a decision was taken, never for
*whether* something currently works.

Every file in this tree opens with the banner at the top of this page.
