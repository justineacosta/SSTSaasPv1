# Task 16 — adversarial reviewer's findings

> **A dated record of what was found at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-04. Branch `feat/phase-2-task-16-auth-screens`,
range `e6a9c68..HEAD` (`9741c3b` at review start). The reviewer did not write this code.

This document is written incrementally as the review proceeds (ruling 131). Sections
appear before they are complete; the final commit is the complete document.

## Status

- [x] Pass 1 — citation: every factual claim in `report.md` re-verified — C1, C2, C3
- [x] Pass 2 — `0488c16`, the unauthorised CSP change — **keep**, with L1
- [x] Pass 3 — the two surviving redirect mutations — see H1
- [x] Pass 4 — CSRF, `pendingToken`, response parsing, secrets in logs — clean; L2 only
- [x] Pass 5 — the four claimed defect fixes — all four real, blast radius as stated
- [x] Pass 6 — documentation the change makes false — four documents, listed below

## Findings

Severity order. `Citation` findings are false or unreproducible sentences in
`report.md`, which this phase treats as defects in their own right.

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

### M1 (Medium) — two tests that look like the guard against H1 and are not

Separated from H1 because the fix round must fix *both*: patching `safeRedirectPath` without
touching these leaves the next regression equally invisible.

**1. `apps/web/src/api/redirect.spec.ts:71-79`, "never returns a value carrying a foreign
origin".** It reads as a class-wide invariant. It iterates `rejected` - the same 19-entry array
whose every member is already individually asserted to equal `DEFAULT_POST_LOGIN_PATH` at
`redirect.spec.ts:56-60`. It therefore cannot fail unless one of those 19 tests has already
failed. It asserts nothing about any input outside the table, and the entire dot-segment class is
outside the table.

**2. `apps/web/e2e/auth-screens.spec.ts:122-152`, "an attacker-supplied next parameter is never a
navigable target".** It navigates to `/login?next=https%3A%2F%2Fevil.example%2Flogin` and asserts
that no `href`/`src`/`action`/`meta[http-equiv]` in the DOM contains `evil.example`. It never
submits the form and never observes a navigation, so it cannot see the defect: the open redirect
happens through `router.replace`, which writes no attribute at all. Its own comment says as much
("The navigation path itself is covered by `src/api/redirect.spec.ts` ... and by
`LoginScreen.spec.tsx`") - and that delegation is where the coverage falls through, because
`LoginScreen.spec.tsx`'s three redirect tests use `https://evil.example/login` and
`//evil.example`, both of which the validator does refuse.

Measured coverage of the failing class across all three suites - nothing anywhere in this task
tests a dot-segment redirect target:

```
$ grep -rn '\.\.//' apps/web/src apps/web/e2e
(no output)
```

### L1 (Low) — `buildSecurityHeaders`' third parameter is unvalidated, and the spec that appears to guard it does not

`apps/web/src/security-headers.ts:120-124` takes `apiOrigin?: string` and interpolates it into the
directive with no check. It is safe **because of the call site**, not because of the function.
A later caller passing `'*'`, `'https:'`, `'self' data:` or an attacker-influenced value widens
the policy silently.

The spec that reads like a guard is not one. `apps/web/src/security-headers.spec.ts` (added by
`0488c16`):

- `'never emits a wildcard or a scheme-only source in connect-src'` supplies
  `'https://api.sentinel.example'` and then asserts the result contains no `*`. It is asserting a
  property of the **input it chose**, not of the function; passing `'*'` would still produce
  `connect-src 'self' *` and no test would fail.
- `'widens connect-src and nothing else'` compares `buildSecurityHeaders(...)` against
  `buildSecurityHeaders(...)` — two outputs of the **same, current** implementation. It pins that
  the parameter is confined to one directive; it does **not** pin the policy against the
  pre-change one, so an edit that changed, say, `script-src` in both branches would leave it
  green. The report's phrase "a whole-list diff proving the widened policy differs from the narrow
  one in `connect-src` and nowhere else" is accurate about what the test does, but the sentence
  it is offered in support of — "byte-identical to before" — is a claim about the *base commit*
  that this test cannot make. (That claim is nonetheless true; see the measurement above. It was
  true by luck of the reviewer measuring it, not because the suite pins it.)

Neither is a defect in the shipped policy today. Both are a control that reads stronger than it is.

### L2 (Low) — one `as` survives in the module the brief told to use no casts

`apps/web/src/api/client.ts:171`: `return parsed.data as z.output<TSchema>;`

The brief's rule was "parse **every** response body with the contract's response schema ... A
response the schema rejects is an error, not a value - do not cast", and by that reading this
complies: the value has been through `safeParse` on line 162 and the assertion only reconciles
Zod's generic output type with the declared return type. It is not a cast *instead of* a parse.
Noted only because the report's Step 3 says the client "parses responses rather than casting
them" without qualification, and a reader grepping for `as ` in that file will find one.

No other `as` in the API client narrows an unvalidated value:

```
$ grep -rn " as " apps/web/src/api/*.ts | grep -v spec
apps/web/src/api/client.ts:171:      return parsed.data as z.output<TSchema>;
apps/web/src/api/field-errors.ts:70:    matched.push({ field: candidate as TField, message: fieldError.message });
```

The second narrows a string already proved to be a member of `knownFields` by the `Set` lookup
two lines above it.

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

### C3 (Citation) — two more numbers in `report.md` that do not reproduce

**`check:specs` "was 126".** Report Step 9: "**137 spec files** ... (was 126)". 137 is correct;
the baseline is 128, measured the same way as C1:

```
$ git checkout --detach e6a9c68 && node scripts/check-vitest-projects.ts
check:specs OK - 128 spec files, each claimed by exactly one of: unit, integration, ui.
$ git checkout feat/phase-2-task-16-auth-screens && node scripts/check-vitest-projects.ts
check:specs OK - 137 spec files, each claimed by exactly one of: unit, integration, ui.
```

128 + 9 = 137, which reconciles: ten spec files were added but `apps/web/e2e/auth-screens.spec.ts`
is deliberately outside the script's scan (`scripts/check-vitest-projects.ts:70,86` - the `e2e`
segment is Playwright's, not Vitest's).

**"60 TS2339 errors".** Report Step 6, defect 3. Reproduced by moving
`apps/web/src/vitest-matchers.d.ts` aside and typechecking:

```
$ mv apps/web/src/vitest-matchers.d.ts <scratch>/ && pnpm --filter @sentinel/web typecheck
EXIT=2
$ ... | grep -c TS2339
73
```

73, not 60. Same mechanism as C2: the figure was measured before `469a903` added assertions and
never re-measured. Harmless in itself; listed because the brief asked how far the habit reaches,
and the answer is "every count that was written once and not re-run".

## Verdict on `0488c16` (the unauthorised CSP change): **keep it**

Judged on the four questions the review brief poses.

**1. Is the stated problem real? Yes.** `apps/web/src/security-headers.ts` at `e6a9c68` emitted
`connect-src 'self'` unconditionally, and `enforceCsp` is `env.APP_ENV !== 'development'`
(`apps/web/src/env.ts:34`), while `apps/web/package.json:11` pins `start:e2e` to
`-v APP_ENV=test`. So the Playwright suite runs under an **enforcing** policy, and ADR-0017's
cross-origin `fetch` to `API_BASE_URL` would have been blocked in every environment except a
developer's laptop. Confirmed by the built directive list below: the base policy has exactly
`connect-src 'self'` and nothing else.

**2. Is the fix minimal? Yes — and byte-identity is now proved against the base commit, which
is more than the spec proves.** `git show e6a9c68:apps/web/src/security-headers.ts` was extracted
to a file and both implementations were called side by side:

```
$ node --experimental-strip-types cmp.mts
enforce=true  identical-headers=true
  policy identical (apiOrigin omitted): true
  widened-vs-base differing directives: ["connect-src 'self' https://api.example"]
  same directive count: true 12
  unsafe-inline present: false | unsafe-eval present: false
enforce=false identical-headers=true
  policy identical (apiOrigin omitted): true
  widened-vs-base differing directives: ["connect-src 'self' https://api.example"]
  same directive count: true 11
  unsafe-inline present: false | unsafe-eval present: false
```

The whole `Record<string, string>` of headers is identical when `apiOrigin` is omitted, in both
enforcing and report-only mode; with it supplied, exactly one of 12 (resp. 11) directives differs;
`'unsafe-inline'` and `'unsafe-eval'` are absent in every combination. **No other directive
changed.**

**3. Can the new parameter widen the policy unintendedly? Not at today's only call site.**
`apps/web/proxy.ts:44` passes `apiOrigin` from `apps/web/src/env.ts:48`,
`new URL(env.API_BASE_URL).origin`. `API_BASE_URL` is the `httpUrl` schema
(`packages/config/src/env.ts:29-55`): `z.string().url()` plus a `superRefine` that rejects any
scheme other than `http:`/`https:`. For an http(s) URL, `.origin` is exactly
`scheme://host[:port]` — userinfo, path, query and fragment are all dropped by the parser, and
host is percent/punycode-normalised — so it can never be `*`, a scheme-only source, an empty
string, a value with a trailing `/`, or a value carrying a path. See L1 for the residual gap.

**4. If reverted, what breaks?** Every cross-origin call from the six new screens, in `test`,
`staging` and `production` — i.e. the whole task outside `pnpm dev`. Reverting is not an option
that leaves the task working.

## Documentation the change has made false

Reported, not fixed - the orchestrator owns every `.claude/` sentence.

1. **`.claude/security/transport-and-headers.md:139`** - "The web origin's `connect-src` is also
   `'self'` today. `API_BASE_URL` is a different origin (`:3001`) in local development, so the
   first browser fetch to the API will need it added - Phase 2's problem, noted here so it is not
   a surprise." Both sentences are now false: `0488c16` added it, and the directive is
   `connect-src 'self' <apiOrigin>` on every response the proxy writes (`apps/web/proxy.ts:44`,
   `apps/web/src/security-headers.ts:85-102`). This is the document the review brief specifically
   asked about.

2. **`.claude/architecture/frontend.md`, status banner (lines 3-11)** - "SS4 (forms), SS5
   (permissions), SS6 (the six required states), SS7 (performance budgets) and SS8 (the component
   tree) are **Not Implemented**" and "The only pages are a marketing landing page and an `(app)`
   placeholder". Six `(auth)` routes now exist (build output: `/forgot-password`, `/login`,
   `/login/mfa`, `/register`, `/reset-password`, `/verify-email`), and SS4 and SS6 are implemented
   for them. SS5 correctly remains Not Implemented - an unauthenticated form has no permission
   state. SS7 also genuinely remains Not Implemented: the report says so at its item 7, and
   nothing here measured the bundle cost of `react-hook-form` / `@hookform/resolvers`.

3. **`.claude/ui-ux/page-map.md:12-13`** - "`(auth)` has a layout and no routes at all." False.

4. **`.claude/ui-ux/page-map.md:46,48`** - the table lists `/mfa` and a separate `/recovery`.
   Built: `/login/mfa`, one screen with a recovery-code mode. The brief already told the
   implementer the orchestrator would correct this; it has not been corrected yet, and the route
   *path* (`/login/mfa`, not `/mfa`) is a second divergence beyond the one-screen-or-two question.

5. **`.claude/development/setup.md`** - checked; nothing about running the app changed. No new
   command, no new environment variable, no new service. Nothing to correct.

## Checked, and found fine

Listed so coverage is legible, not only failures.

### Citation pass - claims in `report.md` that reproduce exactly

| Claim | How measured | Result |
|---|---|---|
| `pnpm test` 109 files / 1843 tests, EXIT 0 | re-run at HEAD | exact |
| `pnpm test:integration` 28 files / 521 tests, EXIT 0 | re-run | exact |
| `pnpm test:e2e` 22 passed, EXIT 0 | re-run | exact (22 passed, 18.9s) |
| `pnpm check:openapi` 27 paths | `Object.keys(o.paths).length` | 27 |
| `pnpm check:secrets` 496 tracked files, EXIT 0 | re-run | exact |
| `pnpm check:specs` 137 spec files, EXIT 0 | re-run | exact (the *baseline* is wrong - C3) |
| `pnpm check:registry` 15 models / 3 tenant-owned / 1 root / 11 global | re-run | exact |
| `format:check`, `lint`, `typecheck` all EXIT 0 | re-run | exact, 14/14 turbo tasks each |
| `pnpm build` 8/8, 11 routes all dynamic | re-run | exact - 11 routes, every one marked dynamic |
| `git diff --stat main...HEAD` 50 files / 4688 insertions / 19 deletions | run as `main...469a903` | exact at the implementer's last commit |
| no commit touches `.claude/`, `roadmap.md`, `apps/api/`, `packages/db/` | `git diff --name-status e6a9c68..HEAD` | confirmed |

### The four defect fixes - the defect existed, and the fix is as narrow as claimed

- **`packages/ui/src/components/Field.tsx`.** Reverted the two `| undefined`s and rebuilt:
  `pnpm --filter @sentinel/web typecheck` -> EXIT 2, **exactly 8** `TS2375` errors, matching the
  report's count. The change is type-only - `git diff e6a9c68..HEAD -- Field.tsx` touches the
  `FieldProps` interface and nothing else, so the rendered output and the `aria-describedby` /
  `aria-invalid` wiring are untouched. It **widens** the accepted type, so no existing consumer
  can break. Blast radius is as stated.
- **`vitest.workspace.ts`.** `git diff e6a9c68..HEAD -- vitest.workspace.ts` adds one setting,
  `esbuild: { jsx: 'automatic' }`, on the `ui` project, plus its comment. **No `include`,
  `exclude`, `environment`, `setupFiles` or project name changed**, so no spec silently stopped
  running. Independently confirmed by `check:specs` reporting 137 files each claimed by exactly
  one project, and by the whole-repo count reconciling (1843 - 172 = 1671 = 1716 - 45).
- **`apps/web/src/vitest-matchers.d.ts`.** Moving it aside reproduces the defect (73 `TS2339`,
  C3). It is a `.d.ts` with a single side-effect import, matched by no Vitest project glob and
  imported by no runtime module.
- **`MfaScreen`'s `defaultValues` defect.** The fix (`MfaChallengeForm` mounted only once a
  challenge exists, `MfaScreen.tsx:60-69`) is present and the reasoning holds: React Hook Form
  reads `defaultValues` on the render that creates the form.

### The mutation table

Spot-checked row 1a rather than taking it on trust:

```
$ # if (!isSafeMethod(options.method)) {   ->   if (true) {
$ npx vitest run --project unit apps/web/src/api/client.spec.ts
EXIT=1
   x createApiClient - the wire > does NOT attach the CSRF header on a safe method
 Tests  1 failed | 23 passed (24)
```

Exactly the failure the report records, including the test name. The mutation *runs* are
credible; what was wrong was the **conclusion drawn from the two survivors** - see H1.

### CSRF

`apps/web/src/api/client.ts:115-123` attaches `X-CSRF-Token` only when
`isSafeMethod(options.method)` is false, and `SAFE_METHODS` (`client.ts:28`) is the same
`GET/HEAD/OPTIONS/TRACE` set as `apps/api/src/common/guards/csrf.guard.ts:23`, so a method added
later is guarded by default rather than exempt by omission. The cookie name is the exact string
`__Host-csrf` (`client.ts:18`) and `readCookie` compares the **whole** name (`client.ts:47`), so a
same-named unprefixed `csrf` cookie is not read. `readCookie` splits on the first `=` only
(`client.ts:45,48`), so a base64 value with padding survives intact; a segment with no `=` is
skipped rather than throwing (`client.ts:46`); an absent cookie returns `null` (`client.ts:50`)
and the header is simply omitted rather than an exception raised. A repeated cookie name returns
the first match - acceptable, because the `__Host-` prefix rules mean no other party can set a
second one for this host. The header can only ever reach the API: every request goes to
`${baseUrl}${path}` and every `path` is a literal in `auth-endpoints.ts:41`.

**The CSRF header does not break the CORS preflight** - which nothing in this task could have
tested, since no form has talked to a live API. `apps/api/src/common/middleware/cors.middleware.ts:27`
declares `ALLOWED_HEADERS = 'Content-Type, X-CSRF-Token, X-Request-Id'` and line 140 sets
`Access-Control-Allow-Credentials: true`. `Accept: application/json` (`client.ts:111`) is a
CORS-safelisted request header. The client's header set is exactly what the API's allowlist
admits.

`credentials: 'include'` is unconditional at `client.ts:131`, not behind a branch.

### The `pendingToken`

- **Never in a URL.** The only navigation on the hand-off is `router.push('/login/mfa')`
  (`LoginScreen.tsx:67`), a literal.
- **Never in storage.** `grep -rn "localStorage|sessionStorage|pushState|replaceState" apps/web/src
  apps/web/app` returns exactly one hit, and it is a **comment** at
  `MfaChallengeProvider.tsx:39` explaining why storage is not used.
- **Never logged.** `grep -rn "console\.|logger\." apps/web/src apps/web/app` (excluding specs)
  returns two hits: a docblock at `auth-endpoints.ts:38` and `app/api/csp-report/route.ts:41`,
  which logs a CSP report and nothing else. `CLAUDE.md` rule 6 is not violated by any code this
  task added.
- **Never in an RSC payload.** `MfaScreen` / `MfaChallengeForm` are `'use client'` and take the
  token from React context, not from a server prop. Contrast `LoginScreen`'s `redirectTo`, which
  *is* a server prop and does appear in the flight payload - correctly, since it is
  attacker-supplied input rather than a credential.
- It is present in the DOM as a hidden input's value (`MfaScreen.tsx:132`). That is the form field
  itself, not a leak: not in server HTML, not an attribute, and reachable by nothing a same-origin
  script could not already reach. The surrounding `<form>` has no `action`, so a native submit
  would put it in the URL - but that path is unreachable, because the form only renders after a
  client-side navigation (so React is running) and React Hook Form's `handleSubmit` calls
  `preventDefault` unconditionally.
- **The reload path is a dead end, as claimed.** `MfaScreen.tsx:46-58` returns an `Alert` and a
  "Back to sign in" link with **no form at all** when `challenge === null`. There is no way to
  submit an empty token.

### Redirect handling, the parts that are correct

`apps/web/src/auth/search-params.ts:14-18` collapses a repeated `?next=` to the **first** value,
so an appended parameter cannot override an existing one. `loginHrefForDestination`
(`redirect.ts:84-88`) validates on the way in as well as out, and `encodeURIComponent`s the
result. `LoginScreen.tsx:60` validates once, so both branches of the `mfaRequired` union navigate
to the same checked value and a later edit cannot hand the raw parameter to one of them.

### Nothing claims to be a security control except the one thing that is

`AuthCard.tsx:13-16` states the rule; `redirect.ts:26-37` states the single documented exception,
and is right to - that value never reaches the server. No other comment or code on these screens
implies a client-side control.

### Response parsing

All eight endpoints bind a contract response schema (`auth-endpoints.ts:43-132`);
`client.ts:162-170` `safeParse`s every 2xx body and raises `ApiError{kind:'malformed'}` on
rejection; `toApiError` (`errors.ts:85-103`) parses non-2xx bodies with `errorEnvelopeSchema` and
fabricates no `code` when they do not match; `readFieldErrors` (`errors.ts:71-75`) parses
`details.fields` with the shared `fieldErrorSchema`. Nothing in `apps/web` re-declares a contract
field shape - every screen imports its schema from `@sentinel/contracts`. See L2 for the one `as`.

### Unmatched field errors are not dropped

`field-errors.ts:58-71` routes anything whose path (or root segment) is not a rendered control
into `unmatched`, and `formLevelMessage` (`field-errors.ts:85-89`) appends every one of them to
the form-level message. A second error for an already-claimed field lands there too rather than
being discarded (`field-errors.ts:65`). Server messages render as React text nodes, so there is no
injection path.

### Non-enumeration is preserved

`ForgotPasswordScreen`'s success copy is conditional on nothing (docblock at lines 16-30; the
success branch has no found-vs-not-found fork), and `VerifyEmailScreen`'s resend success message
is likewise constant (`VerifyEmailScreen.tsx:149-158`).

### ADR-0024 is honoured

`apps/web/app/layout.tsx:63` passes `apiBaseUrl={env.API_BASE_URL}` from a server component into
`Providers`, which builds the client and mounts `ApiClientProvider` (`app/providers.tsx:1-6,53-60`).
`grep -rn "process.env|NEXT_PUBLIC" apps/web/src/api` finds only two docblock mentions and no
code. `pnpm lint`, which enforces the `no-restricted-properties` rule, is EXIT 0.

### Headers other than `connect-src` are unchanged

`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff` and the
`Permissions-Policy` row at `security-headers.ts:132-135` are byte-identical to `e6a9c68` - proved
by the whole-header-table comparison in the `0488c16` verdict above, which compares the entire
`Record<string, string>` in both enforcing and report-only mode.

## What this review did NOT get to

Stated plainly, so absence is not read as clearance.

1. **The human-in-a-browser pass is still outstanding.** Unchanged from the implementer's own
   item 1. Nothing here looked at a rendered screen; contrast, spacing, focus-ring visibility and
   dark mode on the five `packages/ui` primitives that have still never been painted are as
   uncovered by this review as by the task.
2. **H1 was not demonstrated in a live browser end to end.** It is proved at three levels - the
   validator returns `//evil.example` (the module's own source, run); a browser resolves that to
   `https://evil.example/` (URL parser, run); Next 16.3.2 hard-navigates a differing origin
   (`app-router-utils.js:25-27`, `app-router-instance.js:264`, `navigate-reducer.js:33-36`, read).
   It was **not** driven through a real sign-in, because no API is running behind these screens.
   A live reproduction is a Task-18-shaped job.
3. **Only one row of the 16-row mutation table was re-run** (1a). The other fifteen are taken on
   the credibility that row establishes, plus the redirect analysis that supersedes rows 2a/2d.
4. **The six screen `.spec.tsx` files were not audited assertion by assertion.** I read the
   redirect- and credential-related tests closely, and the two that H1 exposed (M1). The other
   ~40 tests were treated as claims about coverage, not verified individually.
5. **No accessibility tooling was run.** `axe-core` is absent, as the report says. Labelling,
   `aria-describedby` and focus-on-first-error were checked by reading, not by measuring.
6. **No bundle-size measurement.** `frontend.md` SS7's budget does not exist and this review did
   not create one; the cost of `react-hook-form` and `@hookform/resolvers` is still unknown.
7. **`packages/ui`'s other seven primitives were not reviewed** - only `Field.tsx`, the one this
   task changed.
8. **`RegisterScreen`, `AuthCard` and the `(auth)` layout were not reviewed for visual or layout
   defects**, only for the security and contract properties the brief named.
