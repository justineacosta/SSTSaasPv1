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
