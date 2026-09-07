# Task 17 — implementer's report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Branch: `feat/phase-2-task-17-app-shell`. This file is a record of commands run, exit codes, file
paths and measurements. It contains no status prose and asserts nothing the orchestrator has not
been handed the evidence for.

Started 2026-09-07.

```
$ git branch --show-current
feat/phase-2-task-17-app-shell
```

## Step 0 — reading, in the order the brief names

1. `docs/superpowers/ledger/phase-2/task-17/brief.md`
2. `.claude/decisions/ADR-0025-authenticated-calls-are-made-from-the-browser.md`
3. `CLAUDE.md`
4. `.claude/architecture/frontend.md` §§3, 4, 5, 6
5. `.claude/api/authentication.md`, `.claude/api/authorization.md`
6. `docs/superpowers/ledger/phase-2/task-16/report.md`, `.../review.md`

## Step 1 — baselines

Baselines are the brief's measured figures on `5dbab4e` and are **not** recomputed here
(ruling 135): `pnpm test` 109 files / 1882 tests; `check:specs` 137 spec files;
`test:integration` 28 files / 521 tests; `check:openapi` 27 paths; `check:registry` 15 models;
`test:e2e` 22 passed.

(Findings appended below as each step completes.)
