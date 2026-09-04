# Task 16 — adversarial reviewer's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-04, after the implementer reported. Branch
`feat/phase-2-task-16-auth-screens`, commits `5cd6e73..beefd81`, base `e6a9c68` on `main`.

## Your first pass is citation, not code

Execution protocol §3. **Before you open a diff**, re-verify every factual claim in
`task-16/report.md` against the actual repository — run the command, open the file, `git show` the
range. Phase 1's reviewers found code defects reliably; nobody was assigned the sentences, and
this phase has produced ten false written claims across two tasks, four of them introduced *while
correcting an earlier one*.

**One is already known and is your starting point, not your finding.** The report states
`pnpm test` was "98 files / 1672 tests" before this task. The orchestrator measured **100 files /
1716 tests** on `e6a9c68` — the exact base of this branch — earlier in the same session, and
`roadmap.md`'s Task 15 evidence table independently records 100/1716. Establish what the true
baseline is, what the true new number is, and therefore what this task actually added. Then check
whether the same wrong baseline propagated anywhere else in the report.

Treat that as a sample, not as the whole audit. Check the rest of the numbers the same way:
137 spec files, 22 e2e tests, 28/521 integration, 27 OpenAPI paths, 496 files in `check:secrets`,
11 routes all `ƒ (Dynamic)`.

## The change that most needs you: `0488c16`

The implementer changed a **security control** the brief did not authorise it to touch:
`apps/web/src/security-headers.ts`, adding an `apiOrigin` to `connect-src`. It disclosed this and
committed it alone, which is the right shape — but disclosure is not review.

Judge it on the merits, adversarially:

- Is the stated problem real? Does `connect-src 'self'` actually block the cross-origin fetch
  ADR-0017 requires, in the environments claimed — including the Playwright suite, where
  `start:e2e` pins `APP_ENV=test` and `enforceCsp` is therefore true (`apps/web/src/env.ts`)?
- Is the fix minimal? The claim is that with `apiOrigin` omitted the directive is
  **byte-identical** to before. Verify that, do not accept it.
- Can the new parameter widen the policy in a way the caller does not intend? A scheme-only
  source, a wildcard, a value with a trailing `/`, a value carrying a path, an empty string, an
  attacker-influenced value. Where does `apiOrigin` come from at the call site, and is it always
  the schema-validated `API_BASE_URL`?
- Did any **other** directive change? Is `'unsafe-inline'` or `'unsafe-eval'` absent everywhere it
  was absent before? The report claims a whole-list diff assertion pins this — read that spec and
  decide whether it actually pins it or merely appears to.

If the change is right, say so plainly. If it is wrong, it reverts with one commit and the task
still has to work — say what breaks.

## The two mutations that survived

The report states that deleting the `startsWith('//')` guard, and deleting the final same-origin
URL-parser check, each individually left `redirect.spec.ts` green, and that deleting both fails
four tests. It calls them mutually redundant.

**Test that claim rather than accepting it.** Redundant defences are fine; a *gap* wearing
redundancy's name is not. Specifically: is there an input that defeats the surviving guard when
the other is gone? `/\evil.com`, `//evil.com`, `/\/evil.com`, `https:/evil.com`,
`/%2f%2fevil.com`, a backslash-tab-newline mix, a scheme-relative URL with credentials. An open
redirect on a login page is a real finding and this is the exact feature that produces them.

## The rest of the security surface

- **CSRF.** Is `X-CSRF-Token` attached on exactly the unsafe methods, read from `__Host-csrf` and
  not from a same-named unprefixed cookie, and never attached to a cross-origin request that is
  not the API? Does cookie parsing handle a value containing `=`, a repeated cookie name, and an
  absent cookie without throwing?
- **The `pendingToken`.** It is a credential. Confirm by measurement that it reaches
  `/login/mfa` in memory and appears in **no** URL, no `history.pushState` argument, no
  `localStorage`/`sessionStorage`, no logged object, and no React error boundary's serialised
  props. Check what happens on reload — the report says the challenge is lost and the screen shows
  an empty state; confirm the state is a dead end that sends the user back to `/login` rather than
  a form that submits an empty token.
- **Nothing on these screens may be a security control.** Every affordance is re-authorised
  server-side. Flag any comment or code that implies otherwise.
- **No secret in a log or an error.** `CLAUDE.md` rule 6. Passwords, tokens, codes.
- **Response parsing.** The brief required every response parsed with its contract schema and no
  casting. Find the places where a cast was used instead, if any.

## The four claimed defect fixes

Each is a claim about a real defect. Verify at least that the defect existed — `git show` the
commit that fixes it, or reproduce the compile error — and that the fix does not have a wider blast
radius than stated. `packages/ui/src/components/Field.tsx` is used by more than this task's screens
in future; `vitest.workspace.ts` governs which specs run at all, and a mistake there makes green
meaningless.

## Documentation the change makes false

**Report these; do not fix them.** The orchestrator owns every `.claude/` sentence. At minimum
check `architecture/frontend.md`'s status banner and §§4, 5, 6, 8; `ui-ux/page-map.md`'s `(auth)`
table; `security/transport-and-headers.md` if `connect-src` is documented there; and
`development/setup.md` if anything about running the app changed.

## Your own rules

- **Write `task-16/review.md` from your first few minutes and commit incrementally.** Ruling 131:
  the previous reviewer finished its passes and was killed before writing anything, and the whole
  pass was lost. The document is the first artefact, not the last.
- Findings get a severity, a citation, and a measurement. "This looks wrong" is not a finding;
  "this is wrong, here is the command and its output" is.
- You may run anything. You may not fix anything — you report, the orchestrator dispositions, a
  fix round implements.
- Never commit to `main`. End commit messages with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
