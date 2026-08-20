# Pull request rules

> **Status: Defined. CI enforcement lands in Phase 1.**

## 1. Before opening

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```

All green locally. CI is a safety net, not a substitute for running your own tests — a red CI
run that could have been caught in thirty seconds locally costs everyone else a queue slot.

## 2. Scope

One logical change per pull request. A PR that refactors, fixes a bug, and adds a feature is
three PRs, and it will get a worse review than any of them would have separately because the
reviewer cannot tell which diff hunks belong to which intent.

Under ~400 lines of substantive change where possible. Mechanical changes (generated files,
formatting) are separated from behavioural ones so the reviewer can skip them honestly.

## 3. Description

```markdown
## What
One or two sentences.

## Why
The problem, or a link to the issue.

## How
Notable decisions and anything a reviewer would otherwise have to reverse-engineer.

## Testing
What you tested, and how. Include the commands you ran.

## Security
Does this touch authn, authz, tenant scoping, scope enforcement, secrets,
file handling, or worker execution? If yes, say what changed and how it was verified.

## Documentation
Which .claude/ documents were updated, or why none needed to be.
```

The Security and Documentation sections are not optional, and "N/A" is an acceptable answer
only when it is true.

## 4. Definition of done

A feature is not done because the code exists. It is done when all of this is true:

**Backend** — schema migrated; API implemented; **authorization declared on every route**;
input validated with Zod; errors use the shared envelope; audit events written where the action
is security-relevant; tests at unit and integration level.

**Frontend** — UI implemented and wired to the real API (**no mock data, ever**); loading,
empty, error, partial, and permission states all present; responsive to 360px; keyboard
operable; `axe` clean.

**Security** — tenant scoping used; new tenant-owned resources registered in the isolation
registry; no secret logged or committed; new external input validated.

**Documentation** — the relevant `.claude/` documents updated in **this** PR; an ADR added if
an architectural decision was made; [`../product/roadmap.md`](../product/roadmap.md) status
updated if a phase moved.

## 5. Review

At least one approval. **Two for anything touching authentication, authorization, tenant
isolation, scope enforcement, worker execution, billing, or secrets** — the areas where a
mistake is expensive and where a second reader is cheap.

Reviewers check correctness first, then security, then maintainability, then style — and style
comments are suggestions, not blockers, because a review that spends its attention on
formatting has not reviewed the code.

Authors respond to every comment: implement it, or explain why not. Silently ignoring a comment
and merging is how a codebase acquires decisions nobody agreed to.

## 6. CI gates

```
install -> lint -> typecheck -> unit -> integration -> security -> build -> e2e -> container scan
```

**No merge on red.** Not with an override, not "it's unrelated", not "it's flaky". A flaky test
is quarantined with an issue and fixed; retrying until green teaches everyone that CI results
are advisory.

Additional automated gates: no new `any` beyond the recorded count; no secret detected;
OpenAPI diff reviewed if the contract changed; bundle size within budget; no new tenant-owned
resource missing from the isolation registry.

## 7. Merge

Squash merge into `main` with a conventional-commit title. `main` is always deployable. Delete
the branch after merge.

Never merge to `main` directly. Never force-push a shared branch. Never merge your own PR
without a review, including as the sole maintainer — if you are working alone, the discipline
is to review your own diff in the GitHub UI before merging, which catches a surprising amount.
