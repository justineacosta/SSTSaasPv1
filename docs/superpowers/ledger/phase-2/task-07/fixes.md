# Phase 2 · Task 7 — fix round

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-27. Branch `feat/phase-2-task-07`, on top of the review at `a208aaf`. Fixes
committed as `7b60be9`. Not pushed, no PR.

Ten findings routed: four Medium (C1, C2, D1, D2) and six Low (C3, C4, D3, D4, D5, D6). All ten
addressed. Nothing in the review is disputed — §11 records the one place I went further than it
asked and why.

## 1. C1 — `unresolvedWarned` is not the runtime signal, and four places said it was

**Verified before changing anything**, because the sentence originated in the brief and I
inherited it:

- `rate-limit.guard.ts:324` — `if (unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed')`
- `rate-limit.config.ts:109-113` — `generalSession: { perPrincipal: {…}, principalSource: 'authenticated', failMode: 'open' }`

`perPrincipal` is the **only** scope, so when it fails to resolve `decisions.length` is 0; and
`failMode` is `'open'`, so the third conjunct is false too. **Neither holds — the warn cannot
fire.** The branch that does fire is `rate-limit.guard.ts:353-368`, which for a fail-open class
calls `this.logger.debug(...)`, and `packages/config/src/env.ts:63` defaults `LOG_LEVEL` to
`'info'`. At the default level an unapplied rate limit produces **no log output at all**.

Corrected in the three places the coordinator named. `report.md` left alone as instructed — it
is a dated record.

- **`apps/api/src/app.module.ts`** — the comment now states the gating condition, both reasons
  neither conjunct holds, that the surviving line is at `debug`, and the reviewer's measurement
  (0 lines of "not being applied", 16 of "could not be resolved", all DEBUG, and only because
  that `.env` set `LOG_LEVEL=debug`).
- **`.claude/security/abuse-prevention.md` §1** — same correction, plus the only way to observe
  the gap today: run at `LOG_LEVEL=debug` and read for "could not be resolved".
- **`.claude/architecture/backend.md` §3** — same, condensed.

**No new warn was invented.** The instruction was explicit and it is also the right call: a warn
added here would be a second control built to make a sentence true, and the thing actually owed
is the limiter split.

## 2. D1 — the `PENDING_MFA` class-metadata property, now held by tests

Three controllers added to `authentication.guard.spec.ts`, each carrying the exemption at class
level in a different way a person could actually write it:

| Route | Shape |
|---|---|
| `/api/v1/attack-raw-metadata` | `@SetMetadata(ALLOW_PENDING_MFA_KEY, true)` on the controller — the key is exported |
| `/api/v1/attack-cast-decorator` | `@(AllowPendingMfa() as ClassDecorator)` |
| `/api/v1/attack-inherited-class` | class metadata on a base controller, subclass routed |

Plus a negative control: an `ACTIVE` session must still reach all three, so a guard that refused
them outright could not pass.

**Mutation kill.** `authentication.guard.ts` widened to the historical `@RateLimitExempt()` shape
— `getAllAndOverride(ALLOW_PENDING_MFA_KEY, [context.getHandler(), context.getClass()])`:

```
× refuses a pending session on a route exempted by raw @SetMetadata on the controller
  → expected 401 "Unauthorized", got 200 "OK"
× refuses a pending session on a route exempted by @AllowPendingMfa() cast to a ClassDecorator
  → expected 401 "Unauthorized", got 200 "OK"
× refuses a pending session on a route exempted by class metadata inherited from a base controller
  → expected 401 "Unauthorized", got 200 "OK"
      Tests  3 failed | 18 passed (21)
MU1 EXIT=1
```

Before these tests existed the same mutation left unit (1000) and integration (205) green. All
three shapes turn a pre-MFA session into an admitted one, which is the whole MFA bypass.
`grep -c "MUTANT ONLY"` on the guard returns `0`.

The inherited case going 200 under the mutation is worth noting: `getAllAndOverride` walks to the
base class, so that third controller is not redundant with the first two.

## 3. D2 — a `@Public()` unsafe route was 403-able by a cookie nobody could answer for

**Reproduced first.** `csrf.guard.spec.ts` gained a `@Public()` `POST` route, and the guard's
existing routes were changed from `@Public()` to `@AuthenticatedOnly()` so the two cases are
distinguishable at all — the original spec made every route public, which is why the hole was
invisible to it.

```
× accepts an unsafe PUBLIC request carrying a stale session cookie
  → expected 201 "Created", got 403 "Forbidden"
× accepts it with a garbage CSRF header too — the route is exempt, not lenient
  → expected 201 "Created", got 403 "Forbidden"
× accepts it from a declared cross-site request as well
  → expected 201 "Created", got 403 "Forbidden"
```

**Fix.** `CsrfGuard` now injects `Reflector` and reads `ACCESS_METADATA_KEY` the same way
`AuthenticationGuard` does, from the same key, so the two can never disagree about which routes
are public; `access?.kind === 'public'` returns `true` before anything else.

**Mutation kill.** Disabling that one line:

```
× accepts an unsafe PUBLIC request carrying a stale session cookie
  → expected 201 "Created", got 403 "Forbidden"
× accepts it with a garbage CSRF header too — the route is exempt, not lenient
  → expected 201 "Created", got 403 "Forbidden"
× accepts it from a declared cross-site request as well
  → expected 201 "Created", got 403 "Forbidden"
      Tests  3 failed | 20 passed (23)
MU-D2 EXIT=1
```

A fourth test is the negative control — the same request shape on a non-public route is still
403 — so an exemption that leaked everywhere would not pass.

**The layering is now explicit.** `security/authentication.md` §4's login-CSRF paragraph was
rewritten: **neither** case reaches this control now, the absent-cookie one and the stale-cookie
one, and the reason the exemption exists is that the second had no client-side remedy — the
expected header derives from the raw session cookie, which is `HttpOnly`. Task 9 owns login CSRF
with its own mechanism: a pre-session token issued by the login page, not one derived from a
session that does not exist yet.

## 4. C2 — the `Cookie` header is never an array, and `Authorization` is worse

**Measured on Node v26.7.0**, raw socket, every header sent twice in one request:

```
cookie        -> string("a=1; b=2")
authorization -> string("Bearer first")
x-custom      -> string("one, two")
set-cookie    -> array(["s=1","s=2"])
```

Three distinct behaviours, and the review is right on all of them:

1. **`Cookie` joins with `'; '`** and is never an array, so `cookie-header.ts`'s stated failure
   mode — "a parser typed only for `string` reads `undefined` from the array form" — cannot
   occur. The docblock now carries this table and describes the array branch as
   **unreachable-today, kept as depth**, rather than as a case that happens.
2. **`cookie-header.spec.ts`'s title was false.** `accepts the array form Node produces for a
   repeated Cookie header` became `handles the array form, which Node does not produce for this
   header`, and a new test covers the shape a repeated `Cookie` header **actually** arrives in:
   one string, `'; '`-joined, with the duplicate name dropped.
3. **`Authorization` keeps the first and silently drops the second.** Not a join and not an
   array. That is the header the API-key half of this stage will read, and a header the parser
   never sees is a worse failure than one it mis-parses. Recorded in the docblock and as a
   forward ruling in §10.

`report.md` §9.6's forward ruling ("a repeated non-`Set-Cookie` header arrives as one
comma-separated string") is wrong as generalised — right for `X-CSRF-Token`, wrong for `Cookie`
and wrong for `Authorization`. `report.md` is left alone; §10 below is the correction.

## 5. D3 — the guard's deliberate omission is now defended

`what the guard does NOT attach > sets no principalId on the request — ruling B, and nothing else
held it` builds a second application with a capture guard that reads `Object.keys(request)`, and
asserts `principal` is present while `principalId` and `organizationId` are not.

**Mutation kill** — the line ruling B forbids:

```
× sets no principalId on the request — ruling B, and nothing else held it
  → expected [ '_events', '_readableState', …(28) ] to not include 'principalId'
      Tests  1 failed | 21 passed (22)
MU-D3 EXIT=1
```

The review added the same line and both lanes stayed green.

## 6. D5 — `Vary` no longer clobbers an array-valued predecessor

`response.getHeader('Vary')` can return `string[]`, and the append handled only the string form,
so an array fell through to `setHeader('Vary', 'Origin')` — discarding it, which is the caching
bug the append exists to prevent. Now joined and appended. A test covers
`['Accept-Encoding', 'Accept']` → `Accept-Encoding, Accept, Origin`.

**Hardening, not a fixed defect, and both the comment and the test say so.** Nothing in this
application sets `Vary` before this stage — `SecurityHeadersMiddleware` sets none — so the
reviewer could not demonstrate it reachable and neither could I. One branch, silent failure if
wrong.

## 7. C3 — the preflight-cache claim removed rather than restated

The comment said Chromium caps preflight caching "well below" 600 s and Firefox lower still. I
did **not** measure browser preflight-cache caps, so I did not write a corrected number: the
claim is gone, replaced by a note that it was unmeasured and appears inverted, and by what is
actually true of the value — 600 is a **choice**, long enough to preflight once per page rather
than per request and short enough that a change to the allowed methods or headers takes effect
within minutes. No cap is asserted, because none was measured by this task.

## 8. C4 — read by somebody, enforced by nobody

`authorization.md` §5's banner said "`@RequirePermission` is still read by nobody". Literally
false: `ACCESS_METADATA_KEY` is read by `AuthenticationGuard` (to decide the route is not
public — which is why a permission-guarded route authenticates at all), by `route-inventory.ts`
for the boot assertion, and by the OpenAPI generator. It now says **read, and enforced by
nobody**, and names the three readers. It is the same distinction Task 6 had to make about
`PENDING_MFA` being recorded but unenforced, and the previous wording contradicted a guard test
two directories away.

## 9. D4 and D6 — recorded, not fixed

**D4.** A preflight is answered before `next()`, so it reaches neither `RateLimitGuard` nor
`LoggingInterceptor` — every unsafe browser request generates one unmetered, unlogged request.
Recorded in the `CorsMiddleware` docblock and in `backend.md` §3, both stating it as a
**consequence, not a decision**, with the reviewer's measurement (three `OPTIONS`, one log line,
the plain one that reached the router). It matters because `abuse-prevention.md`'s banner says
the limiter is global "so there is an answer for every endpoint", and this is a request shape
with no answer. **Deliberately not added to ADR-0017**: an accepted ADR is superseded, never
edited, and this is a consequence discovered after acceptance.

**D6.** Two defensive lines are unreachable on current input and both now say so rather than
implying they fire:

- `csrf-token.ts`'s `if (presented === '') return false;` — the digest comparison already returns
  `false`; kept because it makes the intent legible at the top of the function rather than
  resting on a property of SHA-256.
- `csrf.guard.ts`'s `request.method.toUpperCase()` — Node's parser rejects a lowercase method
  with `400 Bad Request` before Express sees it (measured by the reviewer over a raw socket).

## 10. Rulings this round adds

9. **`Cookie` is never an array; `Authorization` silently drops the second copy.** Measured on
   Node v26.7.0: `Cookie` joins with `'; '`, an ordinary custom header joins with `', '`, only
   `set-cookie` is an array, and **`Authorization` keeps the first and discards the rest**. This
   supersedes `report.md` §9.6, which generalised the `X-CSRF-Token` comma-join to every header.
   **Binds whichever task builds the API-key half of the Authenticate stage**: a client sending
   two `Authorization` headers has one of them silently ignored, so the credential the API
   validates may not be the one the caller thinks it sent. Decide deliberately whether that is
   acceptable; a parser cannot detect it, because the second header never reaches Node's
   `headers` object.
10. **`CsrfGuard` and `AuthenticationGuard` read the same access key.** Any later guard deciding
    "is this route public" reads `ACCESS_METADATA_KEY` rather than keeping its own list, so the
    two cannot drift apart on a route.
11. **Login CSRF is Task 9's, and neither case reaches Task 7's control.** Absent session cookie
    and stale session cookie are both exempt now, deliberately. The remedy is a pre-session
    token issued by the login page, not one derived from a session that does not exist yet.
12. **There is no runtime signal for the unapplied per-principal rate limit.** Not at `info`, not
    at `warn`. The task that splits the limiter must not go looking for `unresolvedWarned` and
    conclude from its silence that the scope resolved.

## 11. Where I went beyond the finding, and what I disagree with

**Nothing in the review is disputed.** Every one of the ten reproduces, and the two the
coordinator confirmed independently (C1, D2) I re-verified against the source before touching
anything — the gating condition at `rate-limit.guard.ts:324` and `generalSession`'s single
fail-open scope at `rate-limit.config.ts:109-113`.

**Two places I went further than asked, both stated so a reviewer can overrule them:**

1. **D2's fix required restructuring the CSRF spec, not just adding a test.** Every route in
   `csrf.guard.spec.ts` was `@Public()`, which is why that suite could not see the hole and why
   exempting public routes would have made nineteen tests vacuous rather than red. The routes
   under test are now `@AuthenticatedOnly()` and a separate controller carries the public one.
   Worth a reviewer's attention: a spec whose fixtures all sit on one side of the branch under
   test cannot fail for the right reason.
2. **C2's docblock carries the whole measured table**, including `set-cookie` and an ordinary
   custom header, not only the two headers the finding named. The generalisation is what went
   wrong the first time; three measured rows beside the claim is what stops the next reader
   generalising from one.

**One thing the review flagged that I did not change**, and the reasoning is the review's own:
D6's two unreachable lines stay. Removing them would be removing depth to satisfy a mutation
score, and the review explicitly says both are "cheap and correct to keep". What changed is the
comments, which previously read as though the lines fire.

## 12. Verification after the fixes

Run on the finished tree at `7b60be9`, working directory clean, compose stack up. Each code
captured outside a pipe (`out=$(cmd 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | **0** | `All matched files use Prettier code style!` |
| `pnpm lint` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm test` | **0** | `Test Files 69 passed (69)` · `Tests 1025 passed (1025)` |
| `pnpm check:specs` | **0** | `84 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | **0** | `Test Files 15 passed (15)` · `Tests 205 passed (205)` |
| `pnpm build` | **0** | `Tasks: 8 successful, 8 total` |
| `pnpm check:openapi` | **0** | `"routes":4` · byte-identical |
| `pnpm check:registry` | **0** | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `pnpm check:secrets` | **0** | `345 tracked files, no credential-shaped literals` |
| `docker compose ps` | **0** | four containers, all `Up 14 minutes (healthy)` |

### Counts across the fix round

| Suite | Before review (`102d85e`) | After fixes (`7b60be9`) | Delta |
|---|---|---|---|
| `pnpm test` | 69 files / 1014 tests | 69 / **1025** | **+11** |
| `pnpm test:integration` | 15 files / 205 tests | 15 / **205** | unchanged |
| `check:openapi` | 4 routes | **4 routes** | unchanged |

The +11: four for D1 (three attack shapes plus the negative control), four for D2, one for D3,
one for D5, one for C2's new string-form duplicate case. No new spec file, so `check:specs` is
unchanged at 84. **`check:openapi` still reports four routes** — every route added in this round
is a fixture in a spec.

### Redis hygiene, ruling 33

`redis-cli --scan --pattern 'session:v1:*'` returns **0** keys after the full integration suite.
No `FLUSHDB` or `FLUSHALL` anywhere.

### Mutants reverted

`grep -c "MUTANT ONLY"` returns `0` for `authentication.guard.ts`, `csrf.guard.ts` and
`cors.middleware.ts`. `git status --short` was clean at `7b60be9` before this file was written.
