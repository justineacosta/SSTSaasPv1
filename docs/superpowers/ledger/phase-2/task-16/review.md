# Task 16 — adversarial reviewer's findings

> **A dated record of what was found at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-04. Branch `feat/phase-2-task-16-auth-screens`,
range `e6a9c68..HEAD` (`9741c3b` at review start). The reviewer did not write this code.

This document is written incrementally as the review proceeds (ruling 131). Sections
appear before they are complete; the final commit is the complete document.

## Status

- [~] Pass 1 — citation: every factual claim in `report.md` re-verified
- [ ] Pass 2 — `0488c16`, the unauthorised CSP change
- [ ] Pass 3 — the two surviving redirect mutations
- [ ] Pass 4 — CSRF, `pendingToken`, response parsing, secrets in logs
- [ ] Pass 5 — the four claimed defect fixes
- [ ] Pass 6 — documentation the change makes false

## Findings

### C1 (Citation) — the `pnpm test` baseline in `report.md` is wrong, and so is the delta it implies

`report.md` Step 9: "`pnpm test` | **0** | **109 files, 1843 tests passed** (was 98 files / 1672
before this task)".

The current number is right. The parenthesis is wrong. Measured by checking the base commit out
and running the command, not by subtraction:

```
$ git checkout --detach e6a9c68 && pnpm test
EXIT=0
 Test Files  100 passed (100)
      Tests  1716 passed (1716)
```

and on the branch:

```
$ git checkout feat/phase-2-task-16-auth-screens && pnpm test
EXIT=0
 Test Files  109 passed (109)
      Tests  1843 passed (1843)
```

**True baseline: 100 files / 1716 tests. True delta: +9 files / +127 tests.** The report's
"98 / 1672" implies +11 / +171, which over-counts the task's contribution by two files and
44 tests. `roadmap.md:2314` independently records 100 / 1716 for Task 15, so the report
contradicts the repository's own status document.

**How the error was made**, which matters because it is reproducible: the implementer did not
measure the baseline. It subtracted its own `apps/web`-scoped run from the whole-repo total —
`1843 - 171 = 1672`, `109 - 11 = 98`. That is wrong twice over:

1. `apps/web` was not empty before this task. `apps/web/src/csp-report.spec.ts` (34 tests) and
   `apps/web/src/security-headers.spec.ts` (11 tests at `e6a9c68`) already existed — 2 files /
   45 tests that the subtraction attributed to Task 16. The report *itself* records this in
   Step 1 ("Correction to the brief, item 8") and then contradicts it in Step 9.
2. The `171` it subtracted was already stale — see C2.

### C2 (Citation) — the `apps/web` suite is 172 tests, not 171; the `auth` specs are 51, not 50

`report.md` Step 6 claims `pnpm vitest run --project ui apps/web/src/auth` → "6 passed (6) /
50 passed (50)", and "After the fixes" claims `--project ui --project unit apps/web` →
"11 files, 171 tests". Measured at HEAD:

```
$ pnpm build:packages && npx vitest run --project unit --project ui apps/web
EXIT=0
 ✓  unit  apps/web/src/security-headers.spec.ts  (15 tests)
 ✓  unit  apps/web/src/csp-report.spec.ts        (34 tests)
 ✓  unit  apps/web/src/api/field-errors.spec.ts  (15 tests)
 ✓  unit  apps/web/src/api/redirect.spec.ts      (33 tests)
 ✓  unit  apps/web/src/api/client.spec.ts        (24 tests)
 ✓  ui    apps/web/src/auth/VerifyEmailScreen.spec.tsx    (7 tests)
 ✓  ui    apps/web/src/auth/MfaScreen.spec.tsx           (11 tests)
 ✓  ui    apps/web/src/auth/ResetPasswordScreen.spec.tsx  (7 tests)
 ✓  ui    apps/web/src/auth/ForgotPasswordScreen.spec.tsx (5 tests)
 ✓  ui    apps/web/src/auth/RegisterScreen.spec.tsx       (7 tests)
 ✓  ui    apps/web/src/auth/LoginScreen.spec.tsx         (14 tests)
 Test Files  11 passed (11)
      Tests  172 passed (172)
```

`7+11+7+5+7+14 = 51` in `src/auth`, not 50; 172 in `apps/web`, not 171. The cause is benign —
commit `469a903` ("reproduce StrictMode's double-mount in the verify-email spec") added the
51st test *after* those two lines were written and neither was re-measured. But the brief's
own rule is "a correction is a claim too: re-run the check after a fix rather than describing
it from memory", and this is exactly that rule being broken. It is also the input that made C1
wrong, so a stale number did not stay local.

The arithmetic all reconciles once the true numbers are used: `1843 - 172 = 1671` non-`apps/web`
tests, and `1716 - 45 = 1671`. Consistent.

## Checked and found fine

_(in progress)_
