# Phase 2 · Task 7 — implementer report

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-27. Branch `feat/phase-2-task-07`, cut from `feat/phase-2-task-06` at `ccc8cde`.
Not pushed, no PR. ADR-0017 was already committed as `7029038` before any implementation commit.

## 1. Verification commands and exit codes

Run on the finished tree at `be74ec6`, working directory clean, compose stack up. Each code
captured as the shell status immediately after the command and outside any pipe
(`out=$(cmd 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | **0** | `All matched files use Prettier code style!` |
| `pnpm lint` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm test` | **0** | `Test Files 69 passed (69)` · `Tests 1014 passed (1014)` |
| `pnpm check:specs` | **0** | `84 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | **0** | `Test Files 15 passed (15)` · `Tests 205 passed (205)` |
| `pnpm build` | **0** | `Tasks: 8 successful, 8 total` |
| `pnpm check:openapi` | **0** | `"routes":4` · `byte-identical to what the contracts generate` |
| `pnpm check:registry` | **0** | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `pnpm check:secrets` | **0** | `345 tracked files, no credential-shaped literals` |
| `docker compose ps` | **0** | four containers, all `Up 35 minutes (healthy)` |

`pnpm test:e2e` not run and not expected: `git diff --stat ccc8cde..be74ec6` lists no
`apps/web` path.

### Counts against the brief's baseline

| Suite | Baseline (`ccc8cde`) | After | Delta |
|---|---|---|---|
| `pnpm test` | 63 files / 917 tests | **69 / 1014** | +6 files, +97 |
| `pnpm test:integration` | 14 files / 192 tests | **15 / 205** | +1 file, +13 |
| `check:specs` | 77 spec files | **84** | +7 |
| `check:openapi` | 4 routes | **4** | unchanged |
| `check:secrets` | 332 tracked files | **345** | +13 |

`AuthModule`'s "registers no controller" test still passes; the four routes are unchanged.
Every route this task's guards were proved against is a fixture that exists nowhere in the
product, through `testing/routing-app.ts` and one integration fixture controller.

### Redis hygiene, ruling 33

After the full integration suite, `redis-cli --scan --pattern 'session:v1:*'` returns **0**
keys. The new integration spec deletes its keys by key in `afterAll`; no `FLUSHDB` or
`FLUSHALL` anywhere.

## 2. The boot proof — an undeclared route still crashes startup, with three arms

The plan names this explicitly. Run against the real `dist/main.js`, with a throwaway
`BootProbeController` temporarily added to `AppModule` declaring **no** access. Log lines are
JSON; the `msg` and the error message are extracted below, nothing else altered.

```
$ pnpm exec dotenv -e ../../.env -- node dist/main.js
API failed to start
Startup refused: 1 route(s) declare no access requirement.

  GET    /api/v1/boot-probe   BootProbeController.probe

Every route must declare @Public(), @AuthenticatedOnly() or
@RequirePermission(...). Missing authorization is a boot failure here
rather than a production discovery.
See .claude/architecture/backend.md §3.
BOOT EXIT=1
```

The same probe with `@AuthenticatedOnly()` added and nothing else changed:

```
$ pnpm exec dotenv -e ../../.env -- node dist/main.js
[04:18:09.886] INFO: API listening
```

**Both directions matter, and only running both proves either.** The first shows the
assertion did not start passing vacuously now that it knows a third word; the second shows
the third arm genuinely satisfies it in a real boot rather than only in a unit test. The
probe was removed from `src/` and from `dist/`; `grep -c "BOOT PROBE" apps/api/src/app.module.ts`
returns `0`, `git status --short` is clean, and `ls apps/api/dist/boot-probe*` finds nothing.

`access-assertion.spec.ts` carries the same pair as tests: `treats @AuthenticatedOnly as a
declaration too — the third arm` and `STILL reports a route with no declaration, now that
there are three arms` (ruling C).

## 3. Mutation evidence

Five mutations, each applied to the shipped code, run, and reverted. `grep -c "MUTANT ONLY"`
over the three touched files returns `0`.

| # | Mutation | Result |
|---|---|---|
| M1 | `AuthenticationGuard`: pending-MFA check disabled | **2 red** — `is refused with 401 MFA_REQUIRED on an ordinary authenticated route`, `is refused on a permission-guarded route as well` |
| M2 | `unknown` folded into `SESSION_EXPIRED` | **1 red** — `answers 401 UNAUTHENTICATED for a token that resolves to nothing` |
| M3 | `CsrfGuard`: compare header to the CSRF **cookie** (plain double-submit) | **5 red**, including `REFUSES a matching cookie-and-header pair the attacker chose` |
| M4 | `@Public()` no longer skips authentication | **3 red**, including `is STILL reachable when the browser attaches a garbage cookie` |
| M5 | `CorsMiddleware` reflects any origin | **3 unit red** + **2 integration red**, including `SENDS NO Access-Control-Allow-Origin AT ALL to an unknown origin` |

**M3 is the one that earns a design decision.** Under plain double-submit the forged
self-consistent cookie-and-header pair is *accepted*; under the shipped comparison it is
refused. That is the measured difference between the two designs, not an argument for one.

## 4. What is where

| File | What it does |
|---|---|
| `apps/api/src/common/http/cookie-header.ts` | The first cookie parser in this codebase (ruling 54). Hand-written, no percent-decoding, and a name appearing twice is **dropped** rather than resolved. |
| `apps/api/src/common/guards/authentication.guard.ts` | Cookie → `UserPrincipal` on `request.principal`. `UNAUTHENTICATED` / `SESSION_EXPIRED` / `MFA_REQUIRED`, and `@Public()` skips the stage entirely. |
| `apps/api/src/common/guards/csrf.guard.ts` | Double-submit on unsafe cookie-carrying methods; `Origin`/`Sec-Fetch-Site` as a secondary signal only. |
| `apps/api/src/modules/auth/csrf-token.ts` | `HMAC-SHA256(key = session token, message = constant)`, and a comparison that hashes both sides before `timingSafeEqual`. |
| `apps/api/src/common/middleware/cors.middleware.ts` | ADR-0017: one configured origin, exact match, never reflected, never `*`, no header at all for an origin off the list, preflight terminated before any guard. |
| `apps/api/src/app.module.spec.ts` | The guard order — rate limit, authenticate, CSRF — which is array order and otherwise invisible (ruling A). |

Changed: `access.decorator.ts` (third arm plus `@AllowPendingMfa()`), `access-assertion.ts`
(message names three arms), `cookies.ts` (`__Host-csrf` issuance and clearing), `app-setup.ts`
(CORS as the third middleware stage), `app.module.ts` (two guards), `routing-app.ts`
(`buildGuardedApp`), `app-setup.spec.ts` (three stages, and the CORS ordering test).

## 5. Ruling B, discharged by recording rather than by building

`generalSession` and `generalApiKey` key on `principalSource: 'authenticated'`, which reads
`request.principalId`. The limiter runs **before** this task's guard (ruling A,
`architecture/backend.md` §3), so that field is unset when the limiter reads it and those
scopes stay unresolvable. Three things follow, all deliberate:

1. **The guard does not set `request.principalId`.** Writing it would be writing a field
   whose only reader has already run — a scope that looks wired and resolves nothing on
   every request. The `AuthenticationGuard` docblock says so at the `declare module`
   augmentation.
2. **The guard order was not changed to fix it.** Ruling A, and the reason is in
   `app.module.ts`: an unauthenticated flood carrying a garbage cookie would otherwise buy a
   Redis read and a Postgres read each before anything refused it.
3. **`unresolvedWarned` is left as the runtime signal**, which is what it was built for.

**`abuse-prevention.md`'s banner was not changed**, and ruling B predicted that correctly: it
says the limiter governs nothing "because no route carries any of these classes: the only
routes that exist are the health probes", and `check:openapi` still reports the same four
routes. I did change **one thing** there, under ruling B's "if you find one sentence your
work makes stale": §1 opens "applied per IP **and** per principal". Before this task a reader
could take that as pending authentication; after it, authentication exists and the
per-principal half still does not resolve. A block now records that, names the guard order as
the cause, and names the split-limiter fix as owed and not built.

## 6. Where a document or the plan turned out to be wrong

1. **The plan's rate-limit item cannot be built as written** — the brief had already
   established this as ruling B, and I confirmed the half it left to me. `rate-limit.config.ts`
   keys `login`, `registration`, `passwordReset` and `emailVerificationResend` on `perIp` and
   on `principalSource: { bodyField: 'email' }`; none needs a principal, and none has a route
   to be annotated on. Nothing was wired.
2. **`security/authentication.md` §4 named the cookie `csrf`; the plan named it
   `__Host-csrf`.** Took the prefixed name and corrected §4, as the brief directs.
3. **§4 describes plain double-submit — "a non-`HttpOnly` cookie echoed in the header" — and
   what shipped is stronger.** The header is compared against the value *derived from the
   session token*, not against the cookie. Every word of §4 stays true of the shipped
   behaviour (a cookie is echoed, the comparison is constant-time, it is bound to the
   session); what changed is the failure mode, measured as M3. §4 now says so explicitly
   rather than leaving a reader to assume the weaker comparison.
4. **`api/authentication.md` §3 and `security/authentication.md` §4 did not disagree**, so the
   brief's tie-break never applied. Both were updated in step.
5. **A claim of mine was wrong and is corrected in the code.** `CsrfGuard` originally
   commented that an array is "Node's rendering of a repeated header" and that two
   `X-CSRF-Token` headers hit that branch. Measured through supertest: Node joins repeated
   non-`Set-Cookie` headers into **one comma-separated string**, so the request arrives as
   `"<valid>, other"` and is refused by the token comparison, not by the array branch. The
   comment and the test now say that; the array branch is kept for the proxy or framework that
   does present one, and is described as such.

## 7. Decisions a reviewer may want to overturn

1. **CSRF compares against the derived value, not against the cookie** (§6.3, M3). Stronger,
   and a deviation from §4's plain wording. Cost if wrong: the CSRF cookie becomes a pure
   transport with no verification role, which is what it already is under this design.
2. **A duplicated cookie name is dropped, not resolved.** First-wins and last-wins each hand
   the request to whichever party can write on that side. The cost is a denial of service for
   anyone who can plant a second `__Host-session` — which the `__Host-` prefix makes close to
   unreachable, since a browser refuses such a cookie carrying a `Domain` — set against a
   fail-closed credential decision.
3. **The CSRF token is derived rather than stored**, so it needs no column, no new secret, and
   no rotation step that could be forgotten. It also makes the CSRF cookie worthless without
   the session cookie.
4. **CORS is hand-written middleware, not `app.enableCors()`.** The `cors` package given a
   string origin sets `Access-Control-Allow-Origin` on every response including a disallowed
   origin's, and given a callback echoes the request's own `Origin` string. ADR-0017 forbids
   both.
5. **A preflight is answered in middleware and never reaches a guard.** It carries no
   credential and identifies no user.
6. **`@AllowPendingMfa()` is a separate metadata key, handler-only.** Folding it into
   `AccessDeclaration` would make "authenticated, and pending is fine" a fourth kind every
   reader has to hold in mind. Handler-only because it is an *exemption*, and
   `rate-limit.guard.ts` records what class-level metadata did to the last exemption here.
7. **The guard sets `request.principal` and nothing else** — no `principalId`, no
   `organizationId`, no permissions (rulings B, E, F).
8. **`buildGuardedApp` was added to `routing-app.ts`** rather than a new file, so one place
   still builds every purpose-built application.

## 8. Not done, could not verify, or deliberately left

- **No endpoint.** `check:openapi` reports four routes; `AuthModule` registers no controller.
  Every route the guards were proved against is a fixture.
- **No `SessionService` change.** `git diff ccc8cde..be74ec6 -- apps/api/src/modules/auth/session.service.ts`
  is empty. The guard uses `resolve` and nothing else.
- **The API-key half of the Authenticate stage is not built.** `ApiKeyPrincipal` is never
  constructed; `assertUserPrincipal` throws where one would be reached. CSRF exempts bearer
  requests today because they carry no session cookie, which is the property that stays true
  when keys exist.
- **Login CSRF is not covered**, and §4 now says so. The guard applies to requests carrying
  the session cookie, per §4's own "authenticated by cookie"; a cross-site `POST` to a login
  endpoint carries none. Task 9 owns the endpoint and the fix.
- **Ruling 52's residual is not detectable here and no attempt was made to detect it.** If
  Redis is unreachable when a session is revoked, a warm cache entry can serve it for up to
  `SESSION_CACHE_TTL_SECONDS`. A "read Postgres anyway" path would defeat the cache ADR-0005
  spends to avoid a per-request database read, on every request, to close a window a short TTL
  already bounds. Recorded in the guard's docblock as a proposal not taken.
- **`generalSession`'s per-principal limit still resolves nothing** (§5).
- **Tenant resolution, permissions and `@RequireEntitlement` are untouched** (rulings E, F).
  `architecture/backend.md` §3's Authorize row deliberately did **not** move.
- **I did not measure a real browser against this CORS configuration.** Task 6 measured the
  `__Host-` cookie in Chromium; the equivalent here — a cross-origin `fetch(…, { credentials:
  'include' })` from a real browser against the running API — was **not** run. Every CORS
  assertion in this task is supertest-level. One specific consequence I therefore cannot rule
  out: every response carries `Cross-Origin-Resource-Policy: same-origin` from the Phase 1
  security-headers middleware, and I have **not** measured whether that interacts with a
  credentialed cross-origin `fetch`. My reading of the Fetch standard is that CORP is enforced
  for `no-cors` requests and not for CORS-mode ones, so it should not — but that is a reading,
  not a measurement, and it is the shape of assumption Task 6's `__Host-` probe existed to
  refuse. **Worth measuring before Task 16 builds the first browser caller.**
- **`development/setup.md` untouched**: no environment variable was added. CORS reads the
  existing `WEB_BASE_URL`.
- **No new error code**, so carry-forward ruling 27's two-list problem did not arise. All four
  codes already existed in `packages/contracts/src/error-codes.ts` and `api/errors.md` §3.

## 9. Rulings this task passes forward

1. **`request.principal` is the authentication stage's only output.** A later stage needing a
   principal id on the request sets it itself and says why.
2. **Guard order is asserted in `app.module.spec.ts`.** Task 12 adds tenant resolution and
   authorization; both change that array and must update the assertion, including its
   "exactly three global guards" count.
3. **`@AllowPendingMfa()` is handler-only and Task 11 owns its one real use.** A class-level
   annotation exempts nothing, by construction.
4. **The CSRF token is derived from the session token.** Any code that hands a client its CSRF
   value calls `deriveCsrfToken`; nothing stores one. Task 9 issues the cookie alongside the
   session cookie on login; Task 16 reads it from the page.
5. **Login CSRF is Task 9's**, and it is the one gap §4 names.
6. **A repeated non-`Set-Cookie` header arrives as one comma-separated string**, measured. Any
   later guard reading a header must not assume the array form.
7. **The per-principal rate-limit scope is unresolvable until the limiter is split.** Owed,
   not built, recorded in `abuse-prevention.md` §1.
8. **A credentialed cross-origin `fetch` from a real browser has never been run against this
   API.** Worth measuring before Task 16, together with the `Cross-Origin-Resource-Policy`
   question in §8.
