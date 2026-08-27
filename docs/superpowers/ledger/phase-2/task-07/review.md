# Phase 2 · Task 7 — adversarial review

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-27. Written by a fresh reviewer who did not write this code, on
`feat/phase-2-task-07` at `2149f2b`, working tree clean, compose stack up (four containers,
`docker compose ps` exit **0**, all `(healthy)`).

**No source file was changed by this review.** Every mutation, the boot probe and the temporary
attack spec below were reverted with `git checkout -- apps/api/src` / `rm`, and
`git status --short` is empty as this file is written. The boot probe was also purged from
`apps/api/dist/` by hand and the tree rebuilt — `grep -rn "boot-probe\|BootProbe\|zz-reviewer"
apps/api/src apps/api/dist` returns nothing. `packages/db/prisma/schema.prisma` was never touched,
by the task (`git diff --stat ccc8cde..HEAD -- packages/db/` is empty) or by me, so carry-forward
ruling 39's `prisma generate` obligation never arose.

Redis hygiene (ruling 33): I issued no `DEL`, `FLUSHDB` or `FLUSHALL` against the compose
instance. `redis-cli --scan --pattern 'session:v1:*'` returns **0** keys after every run. `dbsize`
moved from 10 to 1 across my three `pnpm test:integration` runs — that is the integration suite's
own by-key cleanup, not mine.

---

## 1. Citation pass

### 1.1 The verification table (`report.md` §1) — all eleven re-run, all match

Re-run at `2149f2b` (which adds only ledger `.md` files over the `be74ec6` the report used), each
code captured outside a pipe as `out=$(cmd 2>&1); code=$?`.

| Command | Report | Mine | Match |
|---|---|---|---|
| `pnpm format:check` | 0, `All matched files use Prettier code style!` | 0, same | yes |
| `pnpm lint` | 0, `Tasks: 14 successful, 14 total` | 0, same | yes |
| `pnpm typecheck` | 0, `Tasks: 14 successful, 14 total` | 0, same | yes |
| `pnpm test` | 0, 69 files / 1014 tests | 0, `Test Files 69 passed (69)` · `Tests 1014 passed (1014)` | yes |
| `pnpm check:specs` | 0, 84 spec files | 0, `84 spec files, each claimed by exactly one of: unit, integration, ui` | yes |
| `pnpm test:integration` | 0, 15 files / 205 tests | 0, `Test Files 15 passed (15)` · `Tests 205 passed (205)` | yes |
| `pnpm build` | 0, `Tasks: 8 successful, 8 total` | 0, same | yes |
| `pnpm check:openapi` | 0, `"routes":4`, byte-identical | 0, `…"routes":4…` + `byte-identical to what the contracts generate` | yes |
| `pnpm check:registry` | 0, 14 models / 3 tenant-owned / 1 root / 10 global | 0, same | yes |
| `pnpm check:secrets` | 0, 345 tracked files | 0, `345 tracked files, no credential-shaped literals` | yes |
| `docker compose ps` | 0, four healthy | 0, four healthy | yes |

**The `check:secrets` delta is arithmetically right and I checked why.** Sixteen files were added
on this branch, but `scripts/check-secret-shaped-literals.ts:168` excludes `^docs/superpowers/`,
and three of the sixteen live there — so 332 + 13 = 345, exactly as §1's delta table says.

`pnpm test:e2e` was correctly not run: `git diff --stat ccc8cde..be74ec6 | grep -c "apps/web"`
returns **0**.

### 1.2 The boot proof, run in both directions

I added a throwaway `BootProbeController` to `AppModule` declaring **no** access, ran
`tsc -p tsconfig.build.json`, and booted the real `dist/main.js`:

```
$ pnpm exec dotenv -e ../../.env -- node dist/main.js
{"level":"fatal",…,"err":{"type":"Error","message":"Startup refused: 1 route(s) declare no access requirement.\n\n  GET    /api/v1/boot-probe   BootProbeController.probe\n\nEvery route must declare @Public(), @AuthenticatedOnly() or\n@RequirePermission(...). Missing authorization is a boot failure here\nrather than a production discovery.\nSee .claude/architecture/backend.md §3."},"msg":"API failed to start"}
BOOT EXIT=1
```

Byte for byte the message `report.md` §2 quotes, route line included. Then the same probe with
`@AuthenticatedOnly()` added and nothing else changed:

```
[04:34:55.674] INFO: Mapped {/api/boot-probe, GET} (version: 1) route
[04:34:55.674] INFO: API listening
    port: 3001
```

(The process was killed by a 25-second `timeout`, hence exit 124 — it stayed up.) **Both
directions confirmed.** Before adding my probe I confirmed the implementer's cleanup claims held at
`HEAD`: no `boot-probe`/`BootProbe` in `apps/api/src`, `ls apps/api/dist/boot-probe*` finds
nothing, `git status --short` empty.

That boot also listed the four routes the inventory claims: `GET /api/v1/openapi.json`,
`GET /health/live`, `GET /health/ready`, `GET /health/detailed`.

### 1.3 The five mutations, re-applied

Each applied to the shipped code by anchored replacement, run against
`vitest run --project unit` (1000 tests; the 14-test `ui` project is separate), then
`git checkout -- apps/api/src`.

| # | Report claims | I measured | Match |
|---|---|---|---|
| M1 pending-MFA check disabled | 2 red, named | `2 failed \| 998 passed`, exactly `is refused with 401 MFA_REQUIRED on an ordinary authenticated route` and `is refused on a permission-guarded route as well` | yes |
| M2 `unknown` folded into `SESSION_EXPIRED` | 1 red, named | `1 failed \| 999 passed`, `answers 401 UNAUTHENTICATED for a token that resolves to nothing` | yes |
| M3 CSRF compares header to the **cookie** | 5 red incl. the cookie-injection one | `5 failed \| 995 passed`, incl. `REFUSES a matching cookie-and-header pair the attacker chose` | yes |
| M4 `@Public()` no longer skips | 3 red incl. the garbage-cookie one | `3 failed \| 997 passed`, incl. `is STILL reachable when the browser attaches a garbage cookie` | yes |
| M5 CORS reflects any origin | 3 unit red + 2 integration red incl. `SENDS NO Access-Control-Allow-Origin AT ALL to an unknown origin` | unit `3 failed \| 997 passed`; integration `2 failed \| 203 passed`, those two being `SENDS NO Access-Control-Allow-Origin AT ALL to an unknown origin` and `answers a preflight without reaching a guard, and refuses one from elsewhere` | yes |

One nuance worth recording. I ran M5 in two forms. Changing only the *emitted* value to the
request's `Origin` string while keeping the `===` comparison leaves the suite **green** — which is
what `cors.middleware.ts:56-61` already says ("belt-and-braces rather than a behaviour
difference"). It is the *comparison* the tests hold. The comment is honest about this; I note it
only so a later reader does not mistake that paragraph for a tested property.

### 1.4 The CSRF design claim — proved

`csrf-token.ts` and `csrf.guard.ts:76-84` argue that comparing the header against
`deriveCsrfToken(sessionToken)` beats comparing header to cookie. **Proved, by M3.** Replacing the
comparison with plain header-to-cookie double-submit turns
`REFUSES a matching cookie-and-header pair the attacker chose` red — under the plain design the
forged self-consistent pair is accepted, under the shipped design it is refused. That is a
measurement of the difference, not an argument for it, and it is what the report claims.

One precision the code gets right and I want on the record: the shipped design is stronger *against
the threat model*, not a strict superset of refusals. It **accepts** a request carrying a correct
`X-CSRF-Token` and no `__Host-csrf` cookie at all, which plain double-submit would refuse. That is
harmless, because producing the header requires the `HttpOnly` session token — which is exactly
what `csrf.guard.ts:81-84` says. No correction needed.

`crypto.timingSafeEqual` throwing on unequal lengths, and the hash-both-sides fix, are real: the
spec `refuses input of a DIFFERENT LENGTH without throwing` covers it, and my mutation series
confirmed the digest path never throws on non-ASCII or empty input.

### 1.5 The `cors` package claim — measured, and true

`cors.middleware.ts:47-53` and `report.md` §7.4 claim the `cors` package sets
`Access-Control-Allow-Origin` on **every** response when given a string origin, and echoes the
request's own `Origin` when given a callback. I ran `cors@2.8.6` (present in `node_modules`)
directly:

```
string origin, ALLOWED   -> { 'Access-Control-Allow-Origin': 'http://localhost:3000', Vary: 'Origin', 'Access-Control-Allow-Credentials': 'true' }
string origin, DISALLOWED-> { 'Access-Control-Allow-Origin': 'http://localhost:3000', Vary: 'Origin', 'Access-Control-Allow-Credentials': 'true' }
callback true, DISALLOWED-> { 'Access-Control-Allow-Origin': 'http://evil.test',      Vary: 'Origin', 'Access-Control-Allow-Credentials': 'true' }
```

Both halves of the claim are exactly right. The decision to hand-write the middleware rests on a
measurement, not on a belief.

### 1.6 Documents and quoted sections

Every section this task cites, opened and checked: `security/authentication.md` §1 ("Authentication
establishes *who*") and §5 (line 183, "pending session that can do nothing but complete MFA");
`api/authentication.md` §6 (both the `UNAUTHENTICATED` and `SESSION_EXPIRED` rows present, as the
brief said); `security/authorization.md` §5; `architecture/backend.md` §3's table (three rows
moved, the Authorize row correctly **not** moved). `ADR-0017` is commit `7029038`, the first on the
branch, before any implementation commit — confirmed by `git show --stat`.
`.claude/decisions/README.md` gained its row. No `roadmap.md` edit. Four error codes already
existed; none added.

`abuse-prevention.md`'s banner was left alone, as ruling B predicted. The one §1 block the
implementer did change is a **citation finding** — see C1.

---

## 2. Citation findings

### C1 — Medium. `unresolvedWarned` is not the runtime signal, and four places say it is

The block added to `.claude/security/abuse-prevention.md` §1 (line 32) says the per-principal scope
is unresolvable and that "the guard's `unresolvedWarned` warning is what makes that visible at
runtime". The same sentence is in `.claude/architecture/backend.md` §3 (line 96),
`apps/api/src/app.module.ts:71`, and `report.md` §5.3 ("**`unresolvedWarned` is left as the runtime
signal**, which is what it was built for").

**It never fires for `generalSession`.** `rate-limit.guard.ts:333` guards that warning with
`unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed'`, and
`rate-limit.config.ts:109-113` gives `generalSession` `failMode: 'open'` with `perPrincipal` as its
**only** scope — so `failMode === 'closed'` is false *and* `decisions.length` is 0. Neither
conjunct holds; `unresolvedWarned` is never even read for this class.

What actually fires is the other branch, `rate-limit.guard.ts:353-368`, which for a fail-open class
logs at **`debug`**:

```ts
if (config.failMode === 'closed') this.logger.warn(bindings, message);
else this.logger.debug(bindings, message);
```

Measured on the real `dist/main.js`. Every request produced
`DEBUG: Rate limit scope could not be resolved / rateLimitClass: "generalSession" / failMode:
"open"` and **not one** `Rate limit scope declared but not resolvable; that limit is not being
applied`:

```
$ grep -c "not being applied"   api-boot.log  ->  0
$ grep -c "could not be resolved" api-boot.log ->  16   (all DEBUG)
```

`packages/config/src/env.ts:63` defaults `LOG_LEVEL` to `'info'`. My run saw those lines only
because `.env` sets `LOG_LEVEL=debug`. **At the default level the unapplied per-principal rate
limit produces no log output at all.**

Cost: the project now believes, in two `.claude/` documents and a code comment, that there is a
runtime signal for a rate limit that is not being applied. There is none. A later task splitting
the limiter will look for that signal, fail to find it, and may conclude the scope resolved.

*(Ruling B in `brief.md:112` contains the same sentence, so this was inherited — but the prose rules
make "do not state a claim you have not established" the implementer's obligation, and this task
changed the two documents that now carry it.)*

*File and line:* `.claude/security/abuse-prevention.md:32`, `.claude/architecture/backend.md:96`,
`apps/api/src/app.module.ts:71`, `report.md` §5.3.

### C2 — Medium. The `Cookie` header is never an array, and the forward ruling generalises wrongly

`apps/api/src/common/http/cookie-header.ts:25-33`:

> `string[]` is not defensive typing: Node exposes a repeated header that way, and a client may
> send `Cookie` twice. A parser typed only for `string` reads `undefined` from the array form and
> reports every such request as carrying no cookies at all.

Measured against the running API with two `Cookie` headers on one request, through a probe route
that echoes `typeof request.headers.cookie`:

```
$ curl -H "Cookie: a=1" -H "Cookie: __Host-probe=probevalue" .../boot-probe/echo
{"cookieHeaderPresent":true,"sawProbeCookie":true,"headerType":"string","isArray":false,"raw":"a=1; __Host-probe=probevalue"}
```

And directly against Node's parser over a raw socket, three repeated headers at once:

```
cookie="a=1; b=2" | xfoo="one, two" | auth="Bearer first" | setck=undefined
```

Node special-cases `cookie` and joins repeats with `'; '`. It is **never** presented as an array,
so the stated failure mode ("reads `undefined` from the array form") cannot occur. The array branch
itself is harmless; the reason written beside it is false. `cookie-header.spec.ts:120` carries the
same false claim in its title — `accepts the array form Node produces for a repeated Cookie
header`.

The same measurement falsifies **`report.md` §9.6's forward ruling**: "A repeated non-`Set-Cookie`
header arrives as one comma-separated string, measured. Any later guard reading a header must not
assume the array form." Wrong in two ways. `Cookie` joins with `'; '`, not `', '`. And
`Authorization` — the header the API-key half of this very stage will read — is on Node's discard
list: **the second one is silently dropped and the first wins**, which is neither an array nor a
join. A later task told "assume one comma-separated string" would mishandle exactly the header Task
7 says is owed.

This is the same defect class the implementer's own §6.5 corrected for `X-CSRF-Token` (where the
comma-join claim *is* right — `xfoo="one, two"` above confirms it). The correction was made for one
header and generalised to all of them without measuring a second.

*File and line:* `apps/api/src/common/http/cookie-header.ts:25-33`,
`apps/api/src/common/http/cookie-header.spec.ts:120`, `report.md` §9.6.

### C3 — Low, **unproven**. The preflight-cache comment appears inverted

`cors.middleware.ts:41`: "Ten minutes. Chromium caps preflight caching well below this; Firefox
lower still."

I did not measure browser preflight-cache caps and will not state a number I did not measure. But
the sentence reads as inverted: the documented caps are Chromium **7200 s** and Firefox **86400 s**
— both far *above* 600 — while WebKit/Safari's is 600 s. If those are right, the comment is wrong
in both halves, and its practical implication (that the `600` is decorative) is wrong too. Flagged
so someone measures it or drops it, rather than leaving a load-bearing-sounding claim standing.

*File and line:* `apps/api/src/common/middleware/cors.middleware.ts:41`.

### C4 — Low. "`@RequirePermission` is still read by nobody" is literally false

`.claude/security/authorization.md` §5's new banner. `ACCESS_METADATA_KEY` — the single key
`@RequirePermission()` writes — is read by `authentication.guard.ts:142-145` (to decide the route
is *not* public, which is why a permission-guarded route authenticates at all), by
`route-inventory.ts:147-148` for the boot assertion, and by the OpenAPI generator. What is true is
the *next* sentence — no guard evaluates the permission — and the banner would be right if it said
that. As written it contradicts the guard spec two directories away
(`reaches a @RequirePermission route too — this stage answers WHO, not WHAT`).

*File and line:* `.claude/security/authorization.md:102-108`.

---

## 3. The measurement nobody had made: a real browser, credentialed, cross-origin

Driven with Playwright's bundled **Chromium 151.0.7922.34** (`playwright@1.62.1`, already installed
for `apps/web`), against the real `dist/main.js` on `http://localhost:3001` with three temporary
probe routes, from a page served at **`http://localhost:3000`** — the configured `WEB_BASE_URL`.
Verbatim:

```
page origin = http://localhost:3000
browser = 151.0.7922.34

--- 1. credentialed fetch, allowed origin, public route
{ "ok": true, "status": 200, "type": "cors", "body": "{\"ok\":true}",
  "xRequestId": "req_01M10R9DV2FH5V025KYDSG3XF4", "corp": null, "acao": null }

--- 2. cookie round-trip via credentialed fetch
{ "status": 200, "body": "{\"cookieHeaderPresent\":true,\"sawProbeCookie\":true}" }

--- 2b. same-origin-policy control: fetch without credentials
{ "status": 200, "body": "{\"cookieHeaderPresent\":false,\"sawProbeCookie\":false}" }

--- 3. credentialed fetch, @AuthenticatedOnly route (expect 401 readable)
{ "status": 401,
  "body": "{\"error\":{\"code\":\"UNAUTHENTICATED\",\"message\":\"Authentication is required.\",\"requestId\":\"req_01M10R9DVRFA9TMN460YDEJQAR\"}}",
  "xRequestId": "req_01M10R9DVRFA9TMN460YDEJQAR" }

--- 4. credentialed POST with X-CSRF-Token (forces preflight)
{ "status": 201, "body": "{\"ok\":true}" }

--- 5. credentialed fetch from a DISALLOWED origin (http://127.0.0.1:3002)
{ "threw": "TypeError: Failed to fetch" }

--- 6. no-cors mode fetch (what CORP governs)
{ "threw": "TypeError: Failed to fetch" }

--- browser console output
[console.error] Failed to load resource: the server responded with a status of 401 (Unauthorized)
[origin3002 console.error] Access to fetch at 'http://localhost:3001/api/v1/boot-probe/public' from origin 'http://127.0.0.1:3002' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
[origin3002 console.error] Failed to load resource: net::ERR_FAILED
[console.error] Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin

--- network (boot-probe requests the browser reported)
GET  .../boot-probe/public 200 | GET .../boot-probe/echo 200 | GET .../boot-probe/echo 200
GET  .../boot-probe/auth   401 | POST .../boot-probe/public 201
GET  .../boot-probe/public failed: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin

--- cookie jar
[ { "name": "__Host-probe", "value": "probevalue", "domain": "localhost", "path": "/",
    "expires": -1, "httpOnly": false, "secure": true, "sameSite": "Lax" } ]
```

**The result is positive, so there is no High finding here.** Six things it retires:

1. **`Cross-Origin-Resource-Policy: same-origin` does not block a CORS-mode credentialed `fetch`.**
   Probe 1 succeeded, `type: "cors"`, body readable. The implementer's reading of the Fetch
   standard is now a measurement.
2. **CORP is genuinely in force** — probe 6, the same URL in `no-cors` mode, is blocked with
   `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. The positive result in (1) is not "CORP is inert";
   it is "CORP governs the mode the standard says it governs".
3. **A `Secure`, `SameSite=Lax` cookie set by the API on `localhost:3001` is stored and returned**
   on the next credentialed cross-origin fetch (probe 2, `sawProbeCookie: true`), and is **not**
   sent without `credentials: 'include'` (probe 2b, `false`) — so the flag, not the origin, carried
   it. `Lax` does not interfere: `localhost:3000` to `localhost:3001` is same-site, which is also
   the production shape (`app.` and `api.` under one registrable domain).
4. **The 401 error envelope is readable cross-origin** (probe 3). The frontend really can tell
   `UNAUTHENTICATED` from `SESSION_EXPIRED`, which is the entire reason the two codes exist.
   `X-Request-Id` is readable because it is on `Access-Control-Expose-Headers`; `corp` and `acao`
   read back `null` from the page precisely because they are not exposed — the expose list is doing
   exactly its job and no more.
5. **An unknown origin is blocked by the browser for the stated reason** — "No
   'Access-Control-Allow-Origin' header is present on the requested resource", which is ADR-0017's
   requirement observed from the client side rather than asserted through supertest.
6. **A credentialed POST carrying `X-CSRF-Token` succeeds** (probe 4, 201), which is only possible
   through a successful preflight. Playwright does not surface the preflight as a separate network
   entry; the preflight path itself I measured with `curl` — 204 with
   `Access-Control-Allow-Headers: Content-Type, X-CSRF-Token, X-Request-Id` and
   `Access-Control-Max-Age: 600` for the allowed origin, and 204 with **no** CORS headers for
   `https://evil.test`.

**What I could not measure, and why.** No credentialed request against a *real resolved session*
went through a browser. The compose Postgres in this environment has drifted: `sentinel_app` has no
`USAGE` on schema `public` (`select has_schema_privilege('sentinel_app','public','USAGE')` returns
`f`), so any request reaching `SessionService.resolveFromDatabase` answers 500 `INTERNAL_ERROR`.
That is a local provisioning drift, **not a Task 7 defect** —
`infra/docker/postgres/init/01-app-role.sql` grants it, and the integration suite is unaffected
because it uses a Testcontainers Postgres (`authentication.integration.spec.ts:33-38` records why).
I did not repair the shared database. The CORP question the review brief asked is fully answered
without it, because CORP is evaluated on the response, not on the session.

Worth knowing anyway: the guard **fails closed** on that database error — 500, not an admitted
request.

---

## 4. Code findings

### D1 — Medium. The `PENDING_MFA` class-metadata property is real, but nothing tests it

**First the good news, because it is the higher-value half.** The hole is genuinely closed, not
merely described as closed. I wrote a temporary spec with four attacking controllers and ran it
against the shipped guard:

```
[attack] /api/v1/attack-a/x -> 401 {"error":{"code":"MFA_REQUIRED",…}}   raw @SetMetadata(ALLOW_PENDING_MFA_KEY, true) on the class
[attack] /api/v1/attack-b/x -> 401 {"error":{"code":"MFA_REQUIRED",…}}   @AllowPendingMfa() cast to a ClassDecorator
[attack] /api/v1/attack-c/x -> 401 {"error":{"code":"MFA_REQUIRED",…}}   class metadata on a base controller, subclass routed
[attack] /api/v1/attack-d/x -> 401 {"error":{"code":"MFA_REQUIRED",…}}   Reflect.defineMetadata on the controller prototype
[attack] inherited handler  -> 201                                       base-class HANDLER carrying @AllowPendingMfa(), inherited unchanged
[attack] class @Public + handler @AuthenticatedOnly -> 401
Tests 8 passed (8)
```

`reflector.get(key, context.getHandler())` reads metadata off the method function; `SetMetadata` at
class level writes it on the constructor. They never meet, and `Reflect.getMetadata` on a function
does not walk to the class. The `@RateLimitExempt()` precedent does **not** repeat here. (The one
case that *is* honoured — a base-class handler carrying the exemption, inherited unchanged — is the
same function object, so it is the declared route, not a leak.)

**The finding is that nothing in the shipped suite holds that property.** I mutated
`authentication.guard.ts:192` to the widened form — the exact shape of the historical bug:

```ts
return (
  this.reflector.getAllAndOverride<true>(ALLOW_PENDING_MFA_KEY, [
    context.getHandler(),
    context.getClass(),
  ]) === true
);
```

```
=== MU1-pending-mfa-reads-class  UNIT        EXIT=0   Tests 1000 passed (1000)
=== MU1-pending-mfa-reads-class  INTEGRATION EXIT=0   Test Files 15 passed (15) · Tests 205 passed (205)
```

**Green in both lanes.** `access.decorator.ts:79-85` states the property as fact ("a class-level
annotation — however it is written — exempts nothing"), `report.md` §9.3 passes it forward as a
ruling ("A class-level annotation exempts nothing, by construction"), and no test would notice its
loss. My four controllers above are the missing test. Cost if it regresses: one
`@SetMetadata(ALLOW_PENDING_MFA_KEY, true)` on a controller — and the key is exported — grants a
pre-MFA session every route beneath it, which is the whole MFA bypass, with a green suite. That is
precisely the accident this codebase has already had once.

*File and line:* `apps/api/src/common/guards/authentication.guard.ts:191-193`;
`apps/api/src/common/decorators/access.decorator.ts:79-85`;
`apps/api/src/common/guards/authentication.guard.spec.ts` (the missing case).

### D2 — Medium. A `@Public()` unsafe route *is* refusable by a cookie the caller cannot answer for

`authentication.guard.ts:147-152` gives the reason `@Public()` skips authentication entirely:

> A browser attaches an expired or malformed session cookie to a login request without being asked,
> and a public route that could 401 because of one would be a route nobody could recover from — the
> way out of a bad cookie is the login page, and the login page is public.

`CsrfGuard` reads no access metadata at all (`csrf.guard.ts:88-98`): it fires on any unsafe method
carrying `__Host-session`, public or not. Measured against the real application on a route carrying
`@Public()`:

```
$ curl -s -X POST -H "Cookie: __Host-session=garbage" .../api/v1/boot-probe/public
{"error":{"code":"CSRF_TOKEN_INVALID","message":"A valid CSRF token is required for this request."}}
HTTP 403

$ curl -s -X POST .../api/v1/boot-probe/public          # no cookie
{"ok":true}
HTTP 201
```

The 401 door is closed and a 403 door is open for the same input on the same route. And there is no
way through it from the page: the expected header is `deriveCsrfToken(<the raw session cookie>)`,
the session cookie is `HttpOnly`, and the `__Host-csrf` cookie the page *can* read holds the value
derived from some *other* session token. Nothing in Task 7 issues a CSRF cookie, so whatever
recovery path exists has to be designed by Task 9 — and Task 7 has not recorded that it is owed.
`report.md` §8's login-CSRF paragraph covers only the *absent*-cookie case ("a cross-site `POST` to
a login endpoint carries none"); the present-but-unanswerable case is discussed nowhere.

In scope under the review brief's "report only where Task 7 has made a later task's job unsafe or
impossible": Task 9's login endpoint inherits a 403 with no client-side remedy.

I am **not** calling this High: it needs a `__Host-session` cookie whose derived CSRF value the page
does not hold, and the `__Host-` prefix makes planting one hard, so I could not demonstrate a
production-reachable path. But the fix is one line (exempt `@Public()` routes, or let a public route
re-issue `__Host-csrf` from whatever session cookie arrived) and the record is one sentence, and
neither exists.

*File and line:* `apps/api/src/common/guards/csrf.guard.ts:88-98`, against
`apps/api/src/common/guards/authentication.guard.ts:147-152`.

### D3 — Low. Nothing asserts the guard does *not* set `request.principalId`

Ruling B, `report.md` §5.1 and forward ruling §9.1 all make "`request.principal` is the
authentication stage's only output" a property later tasks rely on, and
`authentication.guard.ts:21-27` states it in a docblock. I added the line the ruling forbids:

```ts
(request as unknown as { principalId?: string }).principalId = identity.userId;
```

```
=== MU8-guard-sets-principalId  UNIT        EXIT=0  Tests 1000 passed (1000)
=== MU8-guard-sets-principalId  INTEGRATION EXIT=0  Tests 205 passed (205)
```

Green in both lanes. The nearest test,
`carries no organisation and no permissions — ruling E and ruling F`, asserts the keys of
`request.principal`, not the keys of the request. Low, because writing the field has no immediate
security consequence — its only reader has already run — but it is the exact shape of "a scope that
looks wired and resolves nothing" the ruling exists to prevent, and a forward ruling nothing
enforces is a ruling that decays.

*File and line:* `apps/api/src/common/guards/authentication.guard.ts:178`;
`apps/api/src/common/guards/authentication.guard.spec.ts:264-268`.

### D4 — Low. Preflights are neither rate-limited nor logged, and nothing says so

`cors.middleware.ts:112-123` answers a preflight with `response.end()` before `next()`. That is the
documented intent for the rate limiter and the guards. The undocumented consequence is that the
request never reaches `LoggingInterceptor` either. Measured: I sent three `OPTIONS` in one burst —
two preflights (with `Access-Control-Request-Method`) and one plain — and the API log contains
exactly one line:

```
[04:36:42.389] WARN: Request failed with RESOURCE_NOT_FOUND
    method: "OPTIONS"
```

which is the plain one, the one that reached the router and 404'd. **The two preflights produced no
log line at all.** The browser run confirms it from the other side: probe 4's POST succeeded, which
requires a preflight, and the API log for that run records only `GET`s and one `POST`.

So every unsafe browser request in the product generates one request that is unmetered by the
limiter and invisible in the logs. `abuse-prevention.md`'s banner says the limiter is global "so
there is an answer for every endpoint"; there is now a request shape with no answer. The abuse cost
is small — the handler does no I/O — but neither property is recorded in ADR-0017, in
`backend.md` §3's new CORS row, or in the middleware's own docblock, which lists the stages a
preflight must skip and does not mention the one it skips by accident.

*File and line:* `apps/api/src/common/middleware/cors.middleware.ts:112-123`.

### D5 — Low, **unproven reachable**. `Vary` clobbers an array-valued predecessor

`cors.middleware.ts:89-91` reads `response.getHeader('Vary')` and appends only when
`typeof existing === 'string'`. Express's `getHeader` can return `string[]` (from
`setHeader('Vary', ['A','B'])`), and that branch falls through to `setHeader('Vary', 'Origin')`,
discarding it — the caching bug the comment two lines above exists to avoid. I could not
demonstrate it: nothing in the application sets `Vary` before this stage
(`SecurityHeadersMiddleware` sets none), so I am labelling it unproven rather than dropping it. The
spec that covers the append (`appends rather than clobbering what another stage set`) uses the
string form only.

*File and line:* `apps/api/src/common/middleware/cors.middleware.ts:89-91`.

### D6 — Low, informational. Two defensive lines are unreachable, so their surviving mutations mean nothing

Two of my mutations left the suite green and are **not** test gaps — I checked, and both lines are
behaviour-neutral:

- `csrf-token.ts:73`, `if (presented === '') return false;`. Removed, the digest comparison already
  returns `false`: `timingSafeEqual(sha256(''), sha256(derive(token)))` evaluates to `false`,
  measured. The spec `refuses an empty presented token` passes with or without the line.
- `csrf.guard.ts:92`, `request.method.toUpperCase()`. A lowercase method never reaches Express —
  Node's own parser rejects it. Measured over a raw socket: `post / HTTP/1.1` gets
  `HTTP/1.1 400 Bad Request`.

Both are cheap and correct to keep. Recorded so the next reviewer who mutates them does not report
a coverage gap that is not one.

---

## 5. What I attacked and found sound

- **The cookie parser, against fifteen hostile headers**, run directly against the built
  `cookie-header.js`. Nothing displaces the real cookie and every ambiguity fails closed: a
  duplicate within one header returns `undefined`; a duplicate across the array form returns
  `undefined`; a name repeated with different surrounding whitespace returns `undefined` (names are
  trimmed, so ` __Host-session` collides rather than shadowing); `=` inside a value is preserved
  (`ab==`); a quoted value comes back with its quotes, so it cannot match a token issued unquoted;
  empty-name and no-`=` segments are skipped without disturbing the real cookie; a case-different
  name is a different cookie, correctly; 1000 junk cookies, a 100 000-character value, an embedded
  NUL and an embedded CRLF are all handled without throwing and all fail closed at the token
  lookup. No percent-decoding, so a stray `%` cannot 500 a request. The answer to the brief's
  question — can an attacker's injected duplicate displace the real one? — is **no**: it makes the
  request unauthenticated, which is the direction a credential decision must fail in, and which
  `report.md` §7.2 already records as an accepted trade.
- **`@Public()` cannot be 401'd by a malformed cookie.** M4 kills three tests, and I confirmed it
  live: `GET` on a public route with `__Host-session=garbage` returns 200, and with duplicate
  session cookies returns 200. The 403 side of the same question is D2.
- **The CSRF exemptions cannot be widened.** Method casing is unreachable (D6); `HEAD`, `OPTIONS`
  and `TRACE` are exempt by the standard's own safe-method set, written as the *exempt* list so a
  new method is guarded by default; no `method-override` middleware exists anywhere in the
  repository (`grep -rn "method-override\|methodOverride" apps` is empty), so no override header can
  turn a `POST` into a `GET`; widening `SAFE_METHODS` by one entry turns
  `DELETE with a session cookie and no token` red; deleting the token comparison and keeping only
  `Sec-Fetch-Site` turns six tests red.
- **CORS exact-matching**, against nine origins on the live server. Only the exact configured string
  gets a header; `http://LOCALHOST:3000`, `http://localhost:3000/`, `http://localhost:3001`,
  `http://localhost:30000` (a superstring), `http://evil.com`, the literal `null` and a missing
  `Origin` all get **no** `Access-Control-Allow-Origin`, no `Access-Control-Allow-Credentials`, and
  `Vary: Origin` regardless. A trailing space on the header value still matches, which is correct —
  Node strips OWS per RFC 9110, so the compared value is byte-identical. A preflight from a
  disallowed origin gets 204 with no CORS headers rather than a distinguishable status. A plain
  `OPTIONS` without `Access-Control-Request-Method` is left to the router (404). Mutating the
  comparison to `startsWith` turns `is refused for a near miss, which is the classic pattern bug`
  red.
- **`Vary: Origin` is on every response**, allowed or not — asserted by a unit test, by an
  integration test, and observed on all nine of my live probes. Restricting it to the allowed branch
  turns `is set on every response, allowed or not` red.
- **Guard order.** `app.module.spec.ts` asserts the array (rate limit, authenticate, CSRF) and the
  count of three, and `authentication.integration.spec.ts:222`
  (`answers 401 and not 403 when the caller is not authenticated at all`) makes the
  authenticate-before-CSRF half **observable at runtime**, not merely declared. The
  rate-limit-before-authenticate half is asserted only by the array; I saw it hold on the live
  server — every 401 and 403 in my logs is preceded by the limiter's own line for the same request —
  but no test observes it. That satisfies ruling A as written ("must be asserted by a test") and I
  am not raising it as a finding.
- **Ruling B — the guard sets no `principalId`** (true today; see D3 for the missing assertion), and
  the order was not changed to make it resolve.
- **Ruling D — the principal is constructed, never parsed.** `packages/contracts/src/principal.ts`
  still publishes no Zod schema; `grep` for `principalSchema` finds only comments; the guard builds
  `{ kind, userId, sessionId }` from what `SessionService.resolve` returned and from nothing else,
  and the spec asserts exactly those three keys. `assertUserPrincipal` still throws for an
  `ApiKeyPrincipal` (`principal.spec.ts:50`).
- **Ruling E — no tenant resolution.** The guard reads no membership, resolves no organisation,
  attaches no permissions, and reaches a `@RequirePermission` route without evaluating the
  permission (asserted). `TenantContext` untouched. `backend.md` §3's Authorize row correctly did
  not move.
- **Ruling 52's residual** is recorded in the guard's docblock as a proposal not taken, with no
  "read Postgres anyway" path added. Correct.
- **`SessionService` unchanged** — `git diff ccc8cde..be74ec6 -- …/session.service.ts` is empty. I
  also checked that `resolve` does **not** silently rotate the session token (it touches
  `lastSeenAt` and `idleExpiresAt` only, `session.service.ts:511-552`), so the derived CSRF value is
  stable for a session's life and the only window is an explicit `rotate` — which the specs cover in
  both lanes (`refuses a stale CSRF pair from before a rotation, and accepts the current one`, and
  `is refused after rotation, and the successor is accepted`).
- **The no-route property.** `check:openapi` reports 4 routes, byte-identical; the real boot mapped
  exactly those four; `auth.module.spec.ts:154`'s `registers no controller` passes.
- **Redis hygiene, ruling 33.** The integration spec deletes by key in `afterAll`, and no
  `FLUSHDB`/`FLUSHALL` exists anywhere in the repository.
- **`MUTANT ONLY` residue:** none anywhere in `apps/` or `packages/`.

## 6. On the two 401 codes as an oracle — the argument the brief asked for

`UNAUTHENTICATED` for `unknown` and `SESSION_EXPIRED` for `expired`/`revoked` **is** an oracle: a
caller holding a candidate token learns from the pair whether that token ever named a row in this
database. I judge it acceptable, and here is the argument rather than silence.

- **Reaching the informative arm requires already holding an issued token.** The token is 256 bits
  from `mintSecretToken`; guessing into the `SESSION_EXPIRED` arm is not a strategy. The oracle
  answers a question only for someone who already has the artefact — from a log, a backup, a stolen
  device — and for that person "this was a real session" is nearly always already implied by where
  they got it.
- **The distinction that *would* matter is deliberately not made.** `expired` and `revoked` share
  one code, so the oracle cannot tell an attacker holding a stolen token whether the theft has been
  noticed. That is the version of this leak with an operational cost, and it is closed
  (`authentication.guard.ts:70-73`, asserted by `answers 401 SESSION_EXPIRED for a revoked
  session`; my mutation collapsing that distinction turns it red).
- **Merging the two codes has a real cost the leak does not.** `api/authentication.md` §6 gives
  both, and the frontend chooses between "log in" and "your session ended" on the difference — a
  choice my browser measurement confirms it can actually make, since the envelope is readable
  cross-origin. A first-time visitor shown "your session ended" is a false statement to every user,
  every day, to close a channel whose only audience already knows the answer.
- **Timing adds no second channel worth noting:** both arms run the same hash and the same lookup
  before diverging.

The guard's own comment (`authentication.guard.ts:75-76`) says "Not an oracle: reaching either arm
requires already holding a token this system issued" — slightly too strong as written (it *is* an
oracle; it is a low-value one), but the reasoning underneath it is right. Not raised as a finding;
recorded so the next reader does not have to redo it.

---

## 7. Summary

| | Severity | Kind |
|---|---|---|
| C1 `unresolvedWarned` is not the runtime signal — four places say it is | **Medium** | Citation, proved |
| C2 The `Cookie` header is never an array; the forward ruling generalises wrongly | **Medium** | Citation, proved |
| D1 The `PENDING_MFA` class-metadata property holds, but no test holds it | **Medium** | Code, proved |
| D2 A `@Public()` unsafe route is 403-able with no client-side remedy | **Medium** | Code, proved |
| C3 The preflight-cache comment appears inverted | Low | Citation, **unproven** |
| C4 "`@RequirePermission` is still read by nobody" is literally false | Low | Citation, proved |
| D3 Nothing asserts the guard does not set `request.principalId` | Low | Code, proved |
| D4 Preflights are neither rate-limited nor logged, and nothing says so | Low | Code, proved |
| D5 `Vary` clobbers an array-valued predecessor | Low | Code, **unproven reachable** |
| D6 Two defensive lines are unreachable | Low | Informational, proved |

**No High.** The browser measurement the review brief called for came back positive: a credentialed
cross-origin `fetch` from `WEB_BASE_URL` succeeds against this API despite
`Cross-Origin-Resource-Policy: same-origin`, and CORP is simultaneously proved live by a `no-cors`
request to the same URL being blocked. Task 16's first browser caller will not fail for that
reason, and the project can stop carrying the assumption.

The two highest-value properties in the task — that a pending session reaches nothing but the route
carrying `@AllowPendingMfa()`, and that an unknown origin receives no `Access-Control-Allow-Origin`
at all — are both **true**, and I proved them rather than reading them. The finding against the
first is that it is true by construction and by nothing else.

After every mutation and probe: `git status --short` empty, `pnpm test` 69 files / 1014 tests exit
**0**, `pnpm typecheck` exit **0**.
