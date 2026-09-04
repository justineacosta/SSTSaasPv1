# Task 16 — dispositions, and the fix round's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-04 after reading `review.md` and re-verifying its two most
important findings independently rather than accepting them.

## Dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| H1 | High | `safeRedirectPath` returns `//evil.example` for `/..//evil.example` | **Fix.** Reproduced by the orchestrator. |
| M1 | Medium | The spec's "never returns a foreign origin" test iterates only the already-rejected array; the dot-segment class is untested anywhere | **Fix.** It is the test whose absence let H1 through. |
| L1 | Low | `buildSecurityHeaders`' third parameter is unvalidated; its two specs cannot support the "byte-identical to before" claim | **Fix, narrowly** — normalise inside the function. The byte-identity claim itself is retracted from prose rather than re-tested; see below. |
| L2 | Low | One `as` at `client.ts:171`, post-`safeParse` reconciliation | **No code change.** The cast is benign. The *sentence* is what was wrong: the report says "parses rather than casts" unqualified. Orchestrator corrects the prose. |
| — | Citation | The report's baseline and four derived numbers are wrong | **Orchestrator corrects `report.md`.** Not the fix implementer's work. |

## H1 is real, and here is the measurement rather than the argument

Reproduced independently of the reviewer, running the platform URL parser directly:

```
"/..//evil.example"          origin-ok=true -> "//evil.example"
"/a/..//evil.example"        origin-ok=true -> "//evil.example"
"/.//evil.example"           origin-ok=true -> "//evil.example"
"/%2e%2e//evil.example"      origin-ok=true -> "//evil.example"
"/..//evil.example?x=1"      origin-ok=true -> "//evil.example?x=1"
new URL('//evil.example','https://sentinel.example/login').href = https://evil.example/
```

**The shape of the defect, stated because it is the part worth carrying forward.** Every one of the
five guards in `safeRedirectPath` is applied to the **input**. The value that is returned is not the
input — it is `resolved.pathname`, which the URL parser has *normalised*. Dot-segment removal can
manufacture a leading `//` that never appeared in the string the guards inspected. `origin` is
equal to the probe origin throughout, correctly, because the resolution genuinely was same-origin;
the origin check is not what failed. **A validator that checks its input and returns something else
has not validated what it returned.**

That sentence is the ruling. It is not specific to redirects.

## What to fix, and how

### H1 — validate the value you return

In `apps/web/src/api/redirect.ts`, after building the result string and before returning it,
**re-apply the shape rule to the output**: it must start with `/` and must not start with `//`.
Return the fallback otherwise.

Do not fix this by adding `..` to a blacklist. The whole function is deliberately a whitelist of
one shape, its docblock says so, and a blacklist of dot-segment spellings is exactly the losing
game — `/%2e%2e//`, `/.//`, `/a/../..//` and whatever the next parser normalisation produces.
Check the output.

Update the docblock: it currently lists five rules and describes a function that validates its
input. It must say that the returned value is re-checked, and why.

### M1 — the property test that would have caught it

Replace the tautological test at `redirect.spec.ts:71-79`. The invariant is about **every** return
value, not about the rejected inputs:

- For every input in a corpus that includes the accepted values, the rejected values, **and** a new
  dot-segment/normalisation class, assert the returned string starts with `/` and does not start
  with `//`.
- Add the dot-segment class to the rejected table explicitly, with at least
  `/..//evil.example`, `/a/..//evil.example`, `/.//evil.example`, `/%2e%2e//evil.example`,
  and a query-carrying variant.
- Assert `loginHrefForDestination` cannot emit one either — it calls the same function, so prove
  the composition holds rather than assuming it.

**Prove it bites**: with your fix reverted, the new tests must go red. Record the mutation and its
output. A test added alongside a fix that was never seen to fail has proven nothing.

### L1 — normalise the parameter where it is used

`buildSecurityHeaders`' third parameter should be reduced to an origin inside the function rather
than trusting the caller to have done it — today's single call site does
`new URL(env.API_BASE_URL).origin`, which is correct, and that is exactly the kind of correctness
that is one careless second call site away from being wrong. Parse it and take `.origin`; if it
does not parse, omit the source rather than emitting the raw string.

Keep the change small. Do not touch any other directive.

## What you must not do

- **Do not edit anything under `.claude/`, `roadmap.md`, or `report.md`/`review.md`.** The
  orchestrator owns all of it, including the corrections listed above.
- Do not touch `apps/api`, `packages/db`, or any migration.
- Do not rewrite the screens. This is a three-file fix round.
- Do not change `vitest.workspace.ts`.

## Verify

Test-first. Then, capturing real exit codes outside a pipe:

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check:specs
pnpm build
pnpm test:e2e
```

`test:integration`, `check:openapi` and `check:registry` are unaffected by these three files;
the orchestrator re-runs the full list on the finished tree regardless.

Report commands, exit codes and numbers. No status prose. Commit small, on
`feat/phase-2-task-16-auth-screens`, never on `main`, each message ending:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
