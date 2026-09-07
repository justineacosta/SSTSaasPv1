# Task 17 — fix round

> **A dated record of what was changed and measured at the time. Not a description of current
> state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fix-round implementer, 2026-09-07, branch `feat/phase-2-task-17-app-shell`.
Written from the first minutes and committed incrementally (ruling 131).

## Scope taken from `fix-brief.md`

| # | Severity | What the brief requires |
|---|---|---|
| C-4 | High | Make the organisation switch repaint. Test mounts the REAL `AppShell` + `OrganizationSwitcher`. |
| C-1 | Citation + Medium | Correct the docblock AND make `sessionSummarySchema` a runtime enforcer on the API side. |
| C-2 | Medium | Revoking the CURRENT session must sign the user out in the browser. |
| C-5 | Low | A 403 on `/settings/members` renders a Permission state, not an error state. |
| rule 10 | prose | Correct the "not expressible without reopening Task 6" sentence. |
| C-3 | prose | Correct the overstated "no oracle" timing sentence. |

Not touched, per the brief: `.claude/`, `roadmap.md`, `report.md`, `review.md`,
`apps/web/src/api/redirect.ts`, `security-headers.ts`. No migration, no global response
interceptor, no change to audit transactionality.

## Progress

- [ ] C-4
- [ ] C-1
- [ ] C-2
- [ ] C-5
- [ ] rule-10 sentence
- [ ] C-3 sentence
- [ ] verification table
