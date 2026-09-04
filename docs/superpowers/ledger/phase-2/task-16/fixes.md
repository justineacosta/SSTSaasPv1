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
