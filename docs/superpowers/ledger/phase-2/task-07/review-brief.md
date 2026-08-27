# Phase 2 · Task 7 — adversarial reviewer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch. You are a **fresh** reviewer: you did
not write this code, you inherit no belief about it, and your job is to break it.

## What was built

Phase 2 Task 7 — the authentication stage and the controls around it. `AuthenticationGuard`,
`CsrfGuard`, a cookie-header parser, `csrf-token.ts`, a CORS middleware, the third access
declaration `@AuthenticatedOnly()`, and `@AllowPendingMfa()`. Four implementation commits on
`feat/phase-2-task-07`, which is stacked on `feat/phase-2-task-06` at `ccc8cde` because Task 6 is
not on `main`. The brief is `brief.md` in this directory, the report is `report.md`, and
**ADR-0017 is the decision the CORS half implements** — it was committed at `7029038` before any
implementation commit.

## Your first pass is citation, not code

The plan's execution protocol §3 makes this review-blocking. Phase 1 shipped 12 false prose claims,
5 of them introduced while correcting an earlier one; Phase 2 has added seven more, four of them
found in Task 6 by this same pass.

**Before you open a diff**, re-run every command in `report.md` and compare exit codes and numbers.
Open every file and line it cites. `git show` every commit it names. Check the citations inside code
comments and inside all six `.claude/` documents this task changed — a comment that quotes a
document, an RFC, a browser behaviour or a Node behaviour is a claim, and this task's own report
already records one such claim being wrong (the implementer believed repeated `X-CSRF-Token` headers
arrive as an array; Node joins them into a comma-separated string).

Three specific things to re-verify rather than accept:

1. **The boot proof, in both directions.** The report claims an undeclared route makes the real
   `dist/main.js` exit 1 naming `GET /api/v1/boot-probe`, and that the same route carrying
   `@AuthenticatedOnly()` boots. Run both yourself. Confirm no probe survives in `src/` or `dist/`.
2. **The five mutations.** Each is claimed to have been watched failing. Re-apply them and confirm
   the count and the identity of the red tests. Any mutation that leaves the suite green is a
   finding.
3. **The CSRF design claim.** `csrf-token.ts` argues that comparing the header against a value
   *derived from the session token* is strictly stronger than comparing header-to-cookie, and the
   report says a forged self-consistent cookie-and-header pair is refused. Prove or disprove it.

## The measurement this task is missing, and it is yours

**No browser has ever made a credentialed cross-origin request against this API.** The implementer
says so plainly, and flags one specific unmeasured interaction: every response carries
`Cross-Origin-Resource-Policy: same-origin` from Phase 1, and whether that blocks a CORS-mode
credentialed `fetch` from `WEB_BASE_URL` is its *reading of the Fetch standard, not a measurement*.

That is precisely the shape of assumption Task 6's `__Host-` probe existed to refuse, and it found
in favour of the code that time. Do the equivalent here: drive a real Chromium through Playwright
(already installed for `apps/web`'s E2E suite), serve a page from the configured web origin, and
make a credentialed `fetch` against a running API. Report the verbatim console and network result.
**A negative result is a High finding** — it would mean Task 16's first browser caller fails for a
reason that looks like an application bug, exactly the cost the plan cites for the `__Host-`
question. A positive result retires an assumption this project would otherwise carry to Task 16.

If the interaction cannot be measured for a reason you can demonstrate, say what stopped you rather
than substituting an argument from the specification.

## Where to attack

- **`PENDING_MFA` enforcement — the highest-value target in this task.** A pending session must
  reach nothing but the route carrying `@AllowPendingMfa()`. The decorator is typed
  `MethodDecorator` and the guard is claimed to read `context.getHandler()` only. Attack that: a
  class-level `@SetMetadata(ALLOW_PENDING_MFA_KEY, true)`, a controller-level decorator applied
  through a cast, inheritance from a base controller, and any route where the guard consults
  `getClass()`. The precedent is in the codebase — `@RateLimitExempt()` was narrowed to
  `MethodDecorator` while the guard still honoured class metadata, so one line disabled every rate
  limit beneath it. Confirm that hole is genuinely closed here and not merely described as closed.
- **`@Public()` and the cookie parser.** A public route must not become 401-able by sending it a
  malformed cookie. Feed the parser duplicate `__Host-session` cookies, a quoted value, `=` inside
  a value, empty names, a cookie named `__Host-session` plus one named ` __Host-session`, absurd
  lengths, and non-ASCII. Which one wins when a name repeats, and can an attacker's injected
  duplicate displace the real one?
- **CSRF.** Safe methods and bearer requests are exempt — confirm the exemption cannot be widened by
  method casing, an override header, or `HEAD`. Confirm the empty-string guard, unequal-length
  input, and a token derived for a *different* session. Check what happens after rotation: Task 6's
  `rotate` mints a new session token, so the derived CSRF token changes — is there a window where a
  legitimate client's next unsafe request is refused, and is that documented?
- **The two 401 codes.** `UNAUTHENTICATED` versus `SESSION_EXPIRED` is a deliberate distinction the
  frontend depends on. Consider whether it is also an oracle: does the pair let an attacker holding
  a candidate token learn that it was once real? Judge whether that is acceptable and say so either
  way — this is a case where "it's fine" needs an argument, not silence.
- **CORS.** Exact-match against `WEB_BASE_URL` — try case differences, a trailing slash, a
  different port, a `null` origin, a missing `Origin`, an origin that is a prefix or suffix of the
  allowed one, and the preflight path. Confirm an unknown origin receives **no**
  `Access-Control-Allow-Origin` header at all, and that `Vary: Origin` is handled correctly, since
  a cached permissive response is the same vulnerability arriving through a proxy.
- **Guard order.** Ruling A fixed authentication *after* the rate limiter. Confirm a test actually
  asserts the order rather than the order merely being what `app.module.ts` happens to list, and
  confirm the guard does not set `request.principalId` (ruling B says it deliberately must not).
- **Ruling D — the principal is constructed, never parsed.** Confirm nothing anywhere parses a
  principal from request-controlled input, and that `ApiKeyPrincipal` still throws where reached.
- **Ruling E — no tenant resolution.** Confirm the guard reads no membership, resolves no
  organisation, and attaches no permissions. Task 12 owns that stage and the two must stay
  separable.
- **The no-route property.** `pnpm check:openapi` must still report 4 routes and
  `auth.module.spec.ts`'s "registers no controller" test must still pass.

## Mutation-test the tests, do not read them

A test that has not been watched failing has proven nothing. Beyond re-running the implementer's
five, write your own: break the CSRF session binding, make `@AuthenticatedOnly()` accept an
anonymous request, let a revoked session through, make the CORS allowlist compare with
`startsWith`, and make the pending-MFA check consult the class. Any mutation that leaves the suite
green is a finding and it outranks any code-reading opinion.

Carry-forward ruling 39 binds you: an agent that mutates `schema.prisma` must run `prisma generate`
after reverting, because `packages/db/generated/` is untracked and a clean `git status` is not
evidence a mutation was undone. Ruling 33 also binds: the compose Redis is shared with the
rate-limit specs — never `FLUSHDB` or `FLUSHALL`, and clean up by key.

## What is out of scope

The endpoints themselves (Tasks 8–11), tenant resolution and the authorization guard (Task 12), and
the login-CSRF question the report assigns to Task 9. Do not report their absence as a finding —
report only where Task 7 has made a later task's job unsafe or impossible.

`abuse-prevention.md`'s banner was deliberately left saying the limiter governs nothing, per the
brief's ruling B. That is correct and is not a finding. The one block the implementer did change
under §1 is in scope: check it says something true.

## How to report

Write `docs/superpowers/ledger/phase-2/task-07/review.md` with the standard ledger banner. Separate
**citation findings** from **code findings** — both are review-blocking and the ledger tracks them
separately. For each: severity (High/Medium/Low, and what a High would cost in production), the
demonstration (command, mutation, interleaving, raw output), and the file and line. **A finding you
proved outranks a finding you argued**; if you could not prove one, label it unproven rather than
dropping it. State briefly what you checked and found sound, so the next reader knows the coverage.

Your own report is subject to the honesty rule: do not state a number you did not measure, and do
not describe a run you did not do.

Do not fix anything. Commit only your `review.md`, with a conventional-commit message ending in the
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer. Then reply with the findings ranked
by severity and what you verified as sound.
