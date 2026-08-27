# Phase 2 · Task 7 — rulings

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-27. Written by the orchestrator. Six rulings were taken **before** dispatch and are in
[`brief.md`](brief.md) — A through F. **One of them, ruling B, contained a false sentence**, which is
the first item below. This file records how the review's ten findings were dispositioned and what
was decided during the fix round. Each carries the cost if it is wrong.

## Disposition of the review's findings

| #  | Finding | Disposition |
| -- | ------- | ----------- |
| C1 | `unresolvedWarned` is not the runtime signal four places claim it is | **Fixed** — `7b60be9`, ruling 71 |
| C2 | The `Cookie` header is never an array in Node; `Authorization` drops its second value | **Fixed** — `7b60be9`, ruling 73 |
| D1 | The `PENDING_MFA` class-metadata hole is closed and nothing tests it | **Fixed** — `7b60be9`, rulings 74, 77 |
| D2 | `CsrfGuard` reads no access metadata: a `@Public()` unsafe route is 403-able | **Fixed** — `7b60be9`, ruling 72 |
| C3 | The preflight-cache comment is inverted | **Fixed** — `7b60be9` |
| C4 | "`@RequirePermission` is read by nobody" is literally false | **Fixed** — `7b60be9` |
| D3 | Nothing asserts the guard does *not* set `request.principalId` | **Fixed** — `7b60be9` |
| D4 | Preflights reach neither the limiter nor the logging interceptor | **Recorded**, ruling 75 |
| D5 | `Vary` clobbers an array-valued predecessor | **Fixed** as hardening — `7b60be9` |
| D6 | Two defences are unreachable on current input | **Kept**, comments corrected |

**The review produced no High finding, and the reason is worth stating rather than celebrating.**
Both of Task 6's Highs were mutations that survived the suite. Here the reviewer wrote twelve
mutations of its own beyond the implementer's five, and the one that survived — D1 — was a
*missing test over correct code*, not a defect. That is a better result than Task 6's and it is
also a narrower one: it says the code does what it claims, not that the claims are complete.

**The most valuable thing in this task was a measurement that did not exist before.** No browser had
ever made a credentialed cross-origin request against this API, and the implementer said so plainly
rather than letting the CORS specs imply otherwise. Ruling 76.

## Ruling 71 — there is no runtime signal for an unresolvable rate-limit scope, and the sentence that said otherwise was the orchestrator's

The brief's ruling B told the implementer to "leave the existing `unresolvedWarned` path to make it
visible at runtime, which is what it was built for". That is false.
`rate-limit.guard.ts:324` gates the warn on
`unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed'`. `generalSession` is
`failMode: 'open'` and declares `perPrincipal` as its **only** scope — so when it fails to resolve,
`decisions.length` is 0 **and** the fail-mode conjunct is false. Neither holds. The only line that
does fire is at `debug`, and `LOG_LEVEL` defaults to `info`.

Corrected in `app.module.ts`, `security/abuse-prevention.md` and `architecture/backend.md` to say
what is true: `generalSession`'s per-principal limit is applied to no request, and **nothing reports
that**. No new warn was invented to make the old sentence true, because inventing one would have
been fixing the documentation by changing the code.

**Cost if wrong:** a limit that governs nothing looks governed. `abuse-prevention.md` §1 promises
1000 requests per minute per principal for the general API; that promise is currently kept by
nothing, and the first person to check would have found a comment saying a warning covers it.

**This is the orchestrator's sentence reaching a code comment and two documents, which is exactly
the propagation path that produced five of Phase 1's twelve false claims** — five of which were
introduced *while correcting an earlier one*. The rule that implementers do not write status prose
exists because prose is where this project's defects live; it does not exempt the person who wrote
the brief. **Binds every future brief: a ruling that asserts a mechanism exists is a claim, and it
is checked before dispatch, not after.**

## Ruling 72 — CSRF skips `@Public()` routes, and login CSRF is Task 9's with its own mechanism

`CsrfGuard` read no access metadata, so any unsafe `@Public()` route refused with 403
`CSRF_TOKEN_INVALID` whenever the browser happened to carry a session cookie — and the page could
not satisfy it, because the expected token derives from the `HttpOnly` session cookie the script
cannot read. It now reads `ACCESS_METADATA_KEY`, the same key the authentication guard reads and in
the same way, so the two cannot drift apart.

**Cost if wrong:** Task 9's login endpoint is `@Public()` by necessity and unsafe by method. It
would have inherited a refusal with no client-side remedy, failing for exactly the users who already
had a stale session — the ones logging in again. The symptom is "login is broken for some people",
which is a long way from its cause.

**What this consciously does not cover: login CSRF.** A cross-site `POST` to login carries no
session cookie, so double-submit has nothing to bind to. Named in `security/authentication.md` §4
and **owed by Task 9**, which must bring its own mechanism rather than assuming this guard covers
it.

## Ruling 73 — Node's repeated-header semantics, measured, and they differ per header

Measured over a raw socket on Node v26.7.0:

| Header | Two values arrive as |
|---|---|
| `Cookie` | one string joined with `'; '` |
| `Authorization` | **the first only — the second is silently dropped** |
| an ordinary custom header | one string joined with `', '` |
| `Set-Cookie` | an array |

The implementer's own Task 7 report had generalised from `X-CSRF-Token` to all headers and was
wrong for two of the four. The docblock now carries the whole measured table rather than the two
rows the finding named.

**Cost if wrong, and it lands on a later task:** the API-key half of authentication reads
`Authorization`. A header the parser never sees is a worse failure than one it mis-parses — a
request carrying two `Authorization` headers presents the first to the parser and discards the
second with no error anywhere. **Binds whichever task builds API-key authentication.**

## Ruling 74 — a spec whose fixtures all sit on one side of the branch under test cannot fail for the right reason

The implementer's generalisation, made while fixing D2, and it is the sharpest sentence produced in
this task. Every route in the CSRF spec was `@Public()`. That is *why* the suite could not see the
hole — and it is also why simply exempting public routes would have turned nineteen existing tests
**vacuous** rather than red. The spec was restructured so the routes under test are
`@AuthenticatedOnly()` with a separate public controller, which is what lets both sides of the
branch fail.

**Cost if wrong:** a green suite that is structurally incapable of going red. This is the same
family as Task 6's ruling 49 (a test comparing two clock readings taken in the same millisecond) and
as Phase 1's `.test.ts` files that executed nothing while `pnpm test` printed green. **Three
instances now, in three different disguises.** When a fix requires exempting a case, check whether
the existing tests all live in the exempted case before congratulating the fix.

## Ruling 75 — preflight `OPTIONS` reach neither the rate limiter nor the logging interceptor

The CORS middleware answers preflights in `configureApp`, before Nest's guard and interceptor
pipeline. So every unsafe browser request produces one unmetered, unlogged request. Recorded in the
middleware docblock and in `architecture/backend.md` §3.

**Deliberately not added to ADR-0017.** `CLAUDE.md` makes an accepted ADR immutable; this is a
consequence discovered after acceptance, not a change of decision, and the place for it is the
document that describes the pipeline.

**Cost if wrong:** an attacker can generate unlimited `OPTIONS` requests that no limit governs and
no log records. The work per request is small — a header comparison and a 204 — so this is a
capacity question rather than an authentication one, but it is a genuine hole in what
`abuse-prevention.md` claims to cover. **Owed by whichever task splits the limiter into an early
per-IP stage** (see ruling 71's neighbourhood).

## Ruling 76 — `Cross-Origin-Resource-Policy: same-origin` does not block a CORS-mode credentialed fetch, and this is now measured

Chromium 151.0.7922.34, a page served from the configured `WEB_BASE_URL` on `:3000`, the real
`dist/main.js` on `:3001`. The credentialed `fetch` succeeded (`type: "cors"`, status 200), the
session cookie round-tripped, `credentials: 'omit'` correctly sent none, an `@AuthenticatedOnly()`
route returned a **readable** 401 envelope cross-origin, and a request from `http://127.0.0.1:3002`
was blocked with no `Access-Control-Allow-Origin` header at all. The same URL fetched in `no-cors`
mode was blocked by `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, which proves CORP is simultaneously
live rather than absent.

**This began as the implementer's own disclosure** that its reading of the Fetch standard was not a
measurement — the same shape as Task 6's `__Host-` question, and it found in favour of the code both
times. **Task 16 can stop carrying the assumption.** That the 401 envelope is readable
cross-origin is what makes the `UNAUTHENTICATED`/`SESSION_EXPIRED` distinction usable by a browser
at all, and nothing had established it before.

**Cost if wrong:** Task 16's first browser caller fails in a way that looks like an application bug,
ten tasks after the decision that caused it.

## Ruling 77 — a metadata exemption must be tested at the class level, not merely implemented there

`@AllowPendingMfa()` is typed `MethodDecorator` and the guard reads `context.getHandler()` only.
Correct — and until this round, nothing held it there: widening the read to
`getAllAndOverride([handler, class])` left 1000 unit and 205 integration tests green. Three
attacking controllers now cover it, including one inheriting the metadata from a base class, because
`getAllAndOverride` walks the prototype chain and a two-controller test would have missed that arm.

**Cost if wrong:** it is the MFA bypass. A pending session — password proved, factor not — reaching
any route that carries a class-level exemption is admitted as fully authenticated.

**This codebase has now shipped this exact bug once and nearly re-shipped it once.**
`rate-limit.decorator.ts` records the first: `@RateLimitExempt()` was narrowed to `MethodDecorator`
while the guard still honoured class metadata, so one line at the top of a controller silently
disabled every rate limit beneath it. **Binds every future exemption decorator**: narrowing the type
is half the control, and the test at the class level is the other half.
