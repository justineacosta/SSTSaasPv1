# Phase 1 execution ledger — production foundation

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Phase 1 was built 2026-08-20 to 2026-08-22 as 16 subagent-driven tasks from
[`../../plans/2026-08-20-phase-1-foundation.md`](../../plans/2026-08-20-phase-1-foundation.md),
against [`../../specs/2026-08-20-phase-1-foundation-design.md`](../../specs/2026-08-20-phase-1-foundation-design.md).

## Provenance

These 71 files were written to `.superpowers/sdd/2026-08-20-phase-1-foundation/`, which was ignored
twice over — `.gitignore:81` excludes `.superpowers/`, and `.superpowers/sdd/.gitignore` contains
`*`. The whole record of a 16-task phase therefore existed only on the machine that built it, and
`roadmap.md` said so plainly.

Moved here on **2026-08-24**, unmodified. Verified as a byte-for-byte copy at the time of the move:
71 files in, 71 files out, 2,817,988 bytes both sides. The flat `task-N-brief.md` naming became
zero-padded `task-NN/brief.md` folders so the tasks sort correctly and match Phase 2's layout;
nothing else changed. The 34 review diffs, named by commit range rather than by task, are collected
in `review-diffs/`.

## What this ledger does **not** contain

Read this before trusting the tree to be complete. `roadmap.md` previously described it as holding
"every ruling with its cost if wrong, every review finding, per-task briefs and reports, and the
review diffs". Audited on 2026-08-24, that overstates it:

| Expected | Actually present |
|---|---|
| A review document per task | **Only tasks 13, 14 and 15.** Tasks 1–12 have a brief and a report and no preserved review findings |
| An entry per task, 1–16 | **Tasks 1–15 only. Task 16 left no brief, no report and no review** |
| A `rulings.md` per task | None as a separate file; rulings are embedded in `progress.md` and in the reports |
| A current pause state | `progress.md` ends at `HEAD 97cedb0`, twelve commits behind `main` — it stopped being written at Task 15 |

Task 16's work is real and verified; the roadmap records it with commands and a CI run ID. What is
missing is only its *ledger* entry. The discipline decayed after Task 12 and nothing caught it,
because nothing in CI or in review could see an ignored directory. That is the concrete reason
Phase 2's ledger is tracked.

## Reading it

`progress.md` first — it is the index and carries the carry-forward rulings. Then the task folder
you care about.

And the rule from [`../README.md`](../README.md), which applies here with particular force given
that Phase 1's recurring defect was false claims in exactly this kind of prose: **a ledger entry
never moves a status and is never cited as evidence that something works.**
