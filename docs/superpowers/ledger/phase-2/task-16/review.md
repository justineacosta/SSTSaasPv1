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

### H1 (High) — `safeRedirectPath` returns a protocol-relative URL: open redirect on `/login`

**The exact defect the function's own docblock says it exists to prevent.**
`apps/web/src/api/redirect.ts:54-74`.

The guards are: starts with `/`, does not start with `//`, contains no backslash, contains no
whitespace or control character, and `new URL(raw, probe).origin === probe`. An input of the form
`/..//evil.example` passes **all five** — and the function then returns `resolved.pathname`
verbatim, which URL path normalisation has collapsed to `//evil.example`.

Measured by running the module's own source (only the two `import` lines and the
`ApiError`-dependent `isSessionExpiry` removed; `safeRedirectPath` and `loginHrefForDestination`
byte-for-byte as committed):

```
$ node --experimental-strip-types redirect-probe.mts
"/..//evil.example"      -> "//evil.example"
"/a/..//evil.example"    -> "//evil.example"
"/.//evil.example"       -> "//evil.example"
"/%2e%2e//evil.example"  -> "//evil.example"
loginHrefForDestination: "/login?next=%2F%2Fevil.example"
```

Further returns from the same probe, all accepted by the validator:
`/..//evil.example/x` -> `//evil.example/x`; `/..//evil.example?a=b` -> `//evil.example?a=b`;
`/../..//evil.example` -> `//evil.example`; `/..///evil.example` -> `///evil.example`;
`/..//user:pass@evil.example` -> `//user:pass@evil.example`.

A returned `//evil.example` is a different origin in every browser:

```
$ node -e "console.log(new URL('//evil.example','https://sentinel.example/login').href)"
https://evil.example/
$ node -e "console.log(new URL('///evil.example','https://sentinel.example/login').href)"
https://evil.example/
```

**The value reaches a real navigation.** `apps/web/src/auth/LoginScreen.tsx:60,73`:

```ts
const destination = safeRedirectPath(redirectTo);
...
router.replace(destination);
```

and the MFA branch carries the same value forward — `LoginScreen.tsx:68`
(`startChallenge({ ..., redirectTo: destination })`) then
`apps/web/src/auth/MfaScreen.tsx:102` (`router.replace(challenge.redirectTo)`).

Next 16.3.2's App Router resolves the argument against the current location and hard-navigates
when the origin differs — it does not clamp it to the app:

```
next/dist/client/components/app-router-utils.js:25-27
  function isExternalURL(url) { return url.origin !== window.location.origin; }
next/dist/client/components/app-router-instance.js:264
  const url = new URL(addBasePath(href), location.href);
next/dist/client/components/router-reducer/reducers/navigate-reducer.js:33-36
  const { url, isExternalUrl, ... } = action;
  if (isExternalUrl) { return completeHardNavigation(state, url, navigateType); }
```

So `https://sentinel.example/login?next=/..//evil.example` signs the user in and then leaves them
on `https://evil.example/` — a credential-phishing hand-off from the product's own login page,
with the product's own session already established. `form-action 'self'` does not help; this is a
scripted navigation, not a form post.

**Why the suite did not catch it.** `apps/web/src/api/redirect.spec.ts:34-52` is a table of 19
rejected inputs and **contains no dot-segment case at all** — the only `..` in the file is
`'/assets\..\..'`, which is rejected by the backslash guard, not by anything to do with `..`.
The one test that looks like a class-wide invariant, `'never returns a value carrying a foreign
origin'` (`redirect.spec.ts:71-79`), iterates over **that same `rejected` array** and so can only
re-assert what the 19 preceding tests already assert. It is a tautology, not a property test; it
would still be green with the dot-segment class wide open, and it is.

**This also corrects the report's account of mutations 2a and 2d.** They are not "mutually
redundant"; they are two guards that between them cover the *leading*-`//` class and miss the
*normalised-to*-`//` class entirely. Redundancy was the wrong conclusion to draw from two
surviving mutants — the survivors were a signal that the input space was under-explored, and
the report read them as a signal that the code was over-protected.

Not fixed here (reviewers do not fix). For the fix round, the shape of the defect is that the
function validates `raw` and then returns a *different* string; whatever guards are chosen, the
**returned** value is what must be re-checked.

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
