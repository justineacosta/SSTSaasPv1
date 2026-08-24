# Task 15 brief — Reusable skills: `sentinel-phase` and `sentinel-verify`

Dispatched: 2026-08-22. Controller: main session. Implementer: fresh subagent.
Base commit: df61629 (tree clean). Branch: feat/phase-1-foundation.

## Source of truth

`docs/superpowers/plans/2026-08-20-phase-1-foundation.md`, lines 5277-5399 — Task 15,
Steps 1-5. Read it directly. This brief adds constraints; it does not replace the plan.

## Deliverables

- Create `.claude/skills/sentinel-verify/SKILL.md`
- Create `.claude/skills/sentinel-phase/SKILL.md`
- Modify `.claude/README.md` — add the `skills/` row to the Map / documentation table
- Modify `CLAUDE.md` — add the two-sentence paragraph under "Resuming work in a new session"

## Frontmatter — exact, do not paraphrase

Both `name` and `description` values are transcribed verbatim from the plan (lines 5292-5293
and 5326-5327). The `description` is the trigger text a future session matches against; a
reworded description is a behaviour change to a control, not a style edit.

## Carry-forward ruling — the one thing this task inherits

The Phase 1 branch has produced **ten instances of the false-claim class**: a report, docblock,
or document asserting something that was not true — four of them introduced *while correcting
an earlier one*. It is the only defect class on this branch that no command catches, and every
instance was caught by a human or an adversarial reviewer, never by a gate.

`sentinel-verify` is where a control for it belongs. Beyond the plan's four numbered steps, the
skill must include a **citation check**: before writing a claim about the state of the repository
into a report, a document, or a commit message, cite the command or file that establishes it, and
where the claim concerns work assigned to someone else, verify it rather than assuming it landed.
The concrete failure to encode: the Task 14 fix-round report stated an item was "recorded in the
roadmap as owed" when `roadmap.md` had not been touched anywhere in that commit range.

Add a row to the red-flags table for it. Keep the plan's six rows intact.

## Constraints

1. **Honesty rule applies to the skills themselves.** Every command a skill instructs a session
   to run must exist in the root `package.json` today. `pnpm check:specs`, `check:openapi`,
   `check:registry`, `test:integration`, `test:e2e`, `format:check` exist. `dev:worker` and
   `test:security` **do not** — do not reference them. Verify with `cat package.json` rather than
   trusting this list.
2. **Do not touch `.claude/product/roadmap.md`.** The controller owns the roadmap update, in the
   same change that moves the status. Do not edit it, and do not report on its contents.
3. **Do not commit.** Leave the tree dirty; the controller commits after review.
4. `.claude/README.md` currently says "Phase 0 is complete and no application code exists" under
   Current status. That is stale but **out of scope** — note it in your report, do not fix it.
5. Markdown is prettier-ignored (`**/*.md` in `.prettierignore`), so `format:check` will not
   reformat these files. Do not rely on it to fix your formatting.

## Definition of done for this task

- Both `SKILL.md` files exist with exact frontmatter and bodies covering every numbered item and
  every table row the plan specifies.
- `.claude/README.md` and `CLAUDE.md` updated.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check` exit 0 (a docs-only change should not move
  them; run them anyway — that is the point of `sentinel-verify`'s own red-flags table).
- A report at `.superpowers/sdd/2026-08-20-phase-1-foundation/task-15-report.md` stating what was
  written, what was verified with which command and exit code, and what was NOT verified.
  Discoverability (plan Step 4) is a controller step — you cannot test it from inside this
  session. Say so; do not claim it.
