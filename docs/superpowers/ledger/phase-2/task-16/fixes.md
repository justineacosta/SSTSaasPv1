# Task 16 — fix round

> **A dated record of what was done at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fix-round implementer, 2026-09-04. Branch `feat/phase-2-task-16-auth-screens`.
Brief: [`fix-brief.md`](./fix-brief.md). Dispositions in scope: H1, M1, L1.

Written incrementally as the work proceeds. Commands are recorded with the exit code
captured outside a pipe (`out=$(cmd 2>&1); code=$?`).

## Starting state

```
$ git rev-parse --short HEAD
cfb5939
$ git status --porcelain
(clean)
```

Files in scope:

- `apps/web/src/api/redirect.ts`
- `apps/web/src/api/redirect.spec.ts`
- `apps/web/src/security-headers.ts`
- `apps/web/src/security-headers.spec.ts`

## Step 0 — reproduce H1 before changing anything
