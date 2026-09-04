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

Run at `606030b`, before any source change, against the committed
`safeRedirectPath` (guards and body byte-for-byte as on the branch), with the
five guards and the return expression transcribed into a standalone script:

```
$ node <scratchpad>/probe.mjs
EXIT=0
"/..//evil.example"          -> "//evil.example"
"/a/..//evil.example"        -> "//evil.example"
"/.//evil.example"           -> "//evil.example"
"/%2e%2e//evil.example"      -> "//evil.example"
"/..//evil.example?x=1"      -> "//evil.example?x=1"
"/..///evil.example"         -> "///evil.example"
//evil.example resolves to: https://evil.example/
```

Six inputs, six foreign origins returned. Matches the orchestrator's five
measurements in `fix-brief.md` and adds `/..///evil.example`.

## Step 1 — M1's tests, written before the fix, and seen red

`apps/web/src/api/redirect.spec.ts`:

- `accepted` (4 entries) hoisted from the four inline `it`s to a module-scope
  table of `[label, input, expected]`.
- `rejected` (19 entries, unchanged) hoisted from inside its `describe` to
  module scope.
- `normalisedToForeignOrigin` added: 10 entries, the H1 class — `/..//evil.example`,
  `/a/..//evil.example`, `/.//evil.example`, `/%2e%2e//evil.example`,
  `/..//evil.example?x=1`, `/..//evil.example#top`, `/..///evil.example`,
  `/../..//evil.example`, `/..//user:pass@evil.example`, `/a/./..//evil.example`.
- `everyInput` = the 33 inputs of all three tables.
- The tautological `never returns a value carrying a foreign origin`
  (`redirect.spec.ts:71-79` at `9741c3b`, iterating `rejected` alone) is **deleted**
  and replaced by three tests iterating `everyInput`: the default-fallback form,
  the caller-fallback form, and the `loginHrefForDestination` composition.
- Plus a `loginHrefForDestination` case naming three dot-segment inputs directly.

```
$ npx vitest run --project unit apps/web/src/api/redirect.spec.ts
EXIT=1
 Test Files  1 failed (1)
      Tests  15 failed | 33 passed (48)
```

The 15 red, before any change to `redirect.ts`:

```
× safeRedirectPath — refuses what normalisation would turn into a foreign origin > refuses a dot segment climbing into a protocol-relative URL
× ... > refuses a dot segment climbing back out of a real path
× ... > refuses a single-dot segment before a double slash
× ... > refuses a percent-encoded dot segment
× ... > refuses a dot segment carrying a query string
× ... > refuses a dot segment carrying a fragment
× ... > refuses a dot segment before a triple slash
× ... > refuses two dot segments
× ... > refuses a dot segment smuggling credentials
× ... > refuses a dot segment reached through a trailing slash
× ... > refuses them with the caller-supplied fallback too
× safeRedirectPath — the class-wide invariant > returns a same-origin path for every input, whatever its class
× safeRedirectPath — the class-wide invariant > holds for the caller-supplied fallback form as well
× safeRedirectPath — the class-wide invariant > cannot be composed into a foreign origin through loginHrefForDestination
× loginHrefForDestination > drops a destination that only becomes foreign under normalisation
```

Two of the failure messages, quoted because they are the defect:

```
AssertionError: input "/..//evil.example" returned "//evil.example": expected true to be false
AssertionError: input "/..//evil.example" produced "/login?next=%2F%2Fevil.example":
  expected '/login?next=%2F%2Fevil.example' not to contain 'evil.example'
```

## Step 2 — H1's fix, and the mutations that prove the tests bite

`apps/web/src/api/redirect.ts`, inside the `try`, after the origin check
(`75a4c90`):

```ts
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (!path.startsWith('/')) return fallback;
    if (path.startsWith('//')) return fallback;
    return path;
```

Two lines added, one `return` split into a named value. No guard above it
changed, no blacklist added. The docblock gains the paragraph saying the shape
rule is applied a second time to the returned value and why the input guards
cannot cover the class.

```
$ npx vitest run --project unit apps/web/src/api/redirect.spec.ts
EXIT=0
 Test Files  1 passed (1)
      Tests  48 passed (48)
```

Mutations, each applied to the tree at `75a4c90` with `perl -0pi -e`, run, then
`git checkout --` to restore:

| # | Mutation | Result | Exit |
|---|---|---|---|
| M-a | delete `if (path.startsWith('//')) return fallback;` | **15 failed \| 33 passed (48)** — killed | 1 |
| M-b | delete `if (!path.startsWith('/')) return fallback;` | 48 passed (48) — **survives** | 0 |
| M-c | delete both output checks (the fix, fully reverted) | **15 failed \| 33 passed (48)** — killed | 1 |
| M-d | pre-fix-round spec against pre-fix-round `redirect.ts` | 33 passed (33) — the defect, green | 0 |
| M-e | pre-fix-round spec against fixed `redirect.ts` | 33 passed (33) | 0 |

M-a and M-c are the proof the new tests bite: with the fix reverted the 15
tests added in `f7c34d3` go red, and they name the input in the failure
message.

**M-b survives, and it is reported rather than hidden.** No input can kill it.
`URL.pathname` for a special-scheme URL is specified always to begin with `/`,
so `path.startsWith('/')` cannot be false after the origin check has passed,
and no test can distinguish the line's presence. It is kept because the brief's
rule is a shape — starts with `/`, does not start with `//` — and half a shape
rule invites the next reader to ask which half mattered. It is a second line
against a future parser, not a tested behaviour, and is recorded here as an
untested line rather than claimed as a covered one.

**M-d and M-e together are M1.** The pre-fix-round spec is green on the
vulnerable implementation *and* green on the fixed one: 33 passed both times,
identical. It could not distinguish them. That is what "the test that looks
like the guard and is not" means, measured rather than argued.

## Step 3 — L1, the third parameter reduced to an origin inside the function

Measured first, because two of the three rejections exist only because of what
this measurement says. `new URL(x).origin` for the values a second call site
could plausibly pass:

```
$ node <scratchpad>/origin.mjs
EXIT=0
"http://localhost:3001/"                      -> "http://localhost:3001"
"https://api.sentinel.example/v1/auth"        -> "https://api.sentinel.example"
"https://api.sentinel.example:443"            -> "https://api.sentinel.example"
"https://api.sentinel.example:8443"           -> "https://api.sentinel.example:8443"
"https://user:pass@api.sentinel.example"      -> "https://api.sentinel.example"
"*"                                           -> THROWS (TypeError)
"https:"                                      -> THROWS (TypeError)
"'self' data:"                                -> THROWS (TypeError)
"api.sentinel.example"                        -> THROWS (TypeError)
"//evil.example"                              -> THROWS (TypeError)
"https://api.example https://evil.example"    -> THROWS (TypeError)
"https://api.sentinel.example; script-src *"  -> THROWS (TypeError)
"https://*"                                   -> "https://*"
"javascript:alert(1)"                         -> "null"
"data:text/html,x"                            -> "null"
```

The last three are the reason "parse it and take `.origin`" is not by itself
the check it looks like: a wildcard host parses and its origin *is* the
wildcard, and a `javascript:`/`data:` URL parses to the opaque origin `null`.
So the function is parse + http(s) scheme + no `*`, and omits the source when
any of the three fails.

`apps/web/src/security-headers.ts` (`d8e244d`): new module-private
`apiOriginSource()`; `buildSecurityHeaders` now calls
`buildContentSecurityPolicy(nonce, enforceCsp, apiOriginSource(apiOrigin))`.
No directive other than `connect-src` is touched, and `proxy.ts` is unchanged.

`apps/web/src/security-headers.spec.ts`: 24 tests added in one new `describe`
— 7 well-formed inputs with the origin each must reduce to, 15 refused values
each asserted to leave `connect-src 'self'` exactly as narrow as with no API
origin at all, and 2 class-wide assertions (no `*`, no second source, exactly
two tokens; and a whole-list diff proving every other directive is byte-equal
to the narrow policy for all 22 inputs).

```
$ npx vitest run --project unit apps/web/src/security-headers.spec.ts   # before the fix
EXIT=1
 Test Files  1 failed (1)
      Tests  22 failed | 17 passed (39)

$ npx vitest run --project unit apps/web/src/security-headers.spec.ts   # after
EXIT=0
 Test Files  1 passed (1)
      Tests  39 passed (39)
```

Mutations, each applied to the tree at `d8e244d`, run, then `git checkout --`:

| # | Mutation | Result | Exit |
|---|---|---|---|
| L-a | drop `if (parsed.protocol !== 'https:' && !== 'http:')` | 3 failed \| 36 passed — killed | 1 |
| L-b | drop `if (parsed.origin.includes('*'))` | 3 failed \| 36 passed — killed | 1 |
| L-c | drop the `try`/`catch` around `new URL` | 13 failed \| 26 passed — killed | 1 |
| L-d | pass `apiOrigin` through raw (the fix, fully reverted) | 22 failed \| 17 passed — killed | 1 |

Every line of `apiOriginSource` is killed by at least one test. Baseline for
the arithmetic: the file held 15 tests before this round, 39 after.

**Procedural note, recorded because it invalidated a measurement.** The first
attempt at these four mutations ran with the L1 implementation still
uncommitted, so the `git checkout --` that restored mutation L-a also deleted
the fix; L-b and L-d then ran against the unfixed file and their numbers were
meaningless. The implementation was committed first and all four re-run. The
table above is the re-run.

## Step 4 — verification

`pnpm format:check` failed first (exit 1, both new spec files). `npx prettier
--write` on the two files, then the list below was run in order on the
resulting tree, which is what `ba2f429` commits. Exit codes captured outside a
pipe: `out=$(pnpm <cmd> 2>&1); code=$?`.

| Command | Exit | Numbers |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` (was exit 1 on 2 files before `prettier --write`) |
| `pnpm lint` | 0 | 14 tasks successful, 14 total |
| `pnpm typecheck` | 0 | 14 tasks successful, 14 total |
| `pnpm test` | 0 | **109 files, 1882 tests passed** |
| `pnpm check:specs` | 0 | 137 spec files, each claimed by exactly one of unit/integration/ui |
| `pnpm build` | 0 | 8 tasks successful, 8 total; `/login`, `/login/mfa`, `/register`, `/reset-password`, `/verify-email` all built |
| `pnpm test:e2e` | 0 | 22 passed (12.3s), 6 workers |

Test-count arithmetic, stated so it can be checked rather than believed:

| Suite | Before this round | After | Delta |
|---|---|---|---|
| `apps/web/src/api/redirect.spec.ts` | 33 | 48 | +15 |
| `apps/web/src/security-headers.spec.ts` | 15 | 39 | +24 |
| whole repo (`pnpm test`) | 109 files / 1843 tests | 109 files / **1882** | +0 files / **+39** |

1843 is the reviewer's re-measured branch figure, not the report's. 33 + 15 +
39 tests reconcile exactly; no new spec file was added, which is why the file
count is unchanged.

## Diff

```
$ git diff --stat 606030b..HEAD -- apps/
 apps/web/src/api/redirect.spec.ts     | 160 ++++++++++++++++++++++---------
 apps/web/src/api/redirect.ts          |  24 ++++-
 apps/web/src/security-headers.spec.ts | 103 ++++++++++++++++++++
 apps/web/src/security-headers.ts      |  54 ++++++++++-
 4 files changed, 315 insertions(+), 26 deletions(-)
```

Four files, all under `apps/web/src`. `.claude/`, `roadmap.md`, `report.md`,
`review.md`, `apps/api`, `packages/db` and `vitest.workspace.ts` are untouched
by every commit in `606030b..HEAD` authored by this round; `report.md` is
changed in the range only by the orchestrator's own `00e7526`, which landed on
the branch alongside this work.

## Not done, and why

- **`apps/web/e2e/auth-screens.spec.ts:122-152`**, the second half of M1's
  finding — the e2e test that asserts no DOM attribute carries `evil.example`
  and so cannot observe a `router.replace` navigation. The brief scopes M1 to
  `redirect.spec.ts` and the `loginHrefForDestination` composition, and scopes
  the round to three files. Left as the reviewer found it: it remains a test
  that reads stronger than it is, and the class it was delegating to
  `redirect.spec.ts` is now actually covered there.
- **`proxy.ts:44`** still passes `new URL(env.API_BASE_URL).origin`. Now
  redundant — `apiOriginSource` would reduce `env.API_BASE_URL` itself — but
  the brief says keep L1 small and the call site is not in scope.
- Mutation **M-b** (`if (!path.startsWith('/'))` in `safeRedirectPath`)
  survives and is untestable. See Step 2.
