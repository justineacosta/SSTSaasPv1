# Task 15 — D9 fix round: fixer's ledger

**Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Round:** D9 security fix round, following `d9-review.md` and `d9-fix-brief.md`.
**Rule in force:** carry-forward ruling 131 — this document is created and committed
*first*, and appended to and committed *after each fix*. Two agents have already died
mid-task in this task's history; one of them lost a complete adversarial review by
writing its document last. Nothing here is written in advance of the work it describes.

## Status

- [ ] Read the brief, the review, ADR-0026, and the implementer's report
- [ ] Item 1 — organisation lock in `InvitationService.create` (the reproduced escalation)
- [ ] Remaining items, in the brief's order
- [ ] Six commands green, exit codes captured outside a pipe

## Honesty rule

Nothing below is claimed as fixed, closed, or passing unless the run that establishes
it is recorded here with its actual output. The two tests the brief demands red-then-green
runs for get both runs recorded, with the exact command and the exact result.

## Log

_(appended as the work happens)_

### Entry 0 — ledger created

Created before reading anything but `CLAUDE.md`'s auto-loaded contents and listing this
directory. Committed immediately, per ruling 131.
