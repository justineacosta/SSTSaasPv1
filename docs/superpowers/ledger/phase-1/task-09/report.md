# Task 9 — `apps/api` bootstrap: reports

Commits: `6298ca0..58921e2` (implementation `888bc3c`, fix round `73b04f3`, Minors `58921e2`).
Outcome: **APPROVED** on the scoped re-review of the fix diff.

Recorded after the fact from the dispatch transcripts. Agent reports are reproduced as given;
where the controller is the author it is marked.

---

## Round 1 — implementer report (`888bc3c`)

**Gates:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build` → exit 0,
tree clean. 181 unit (73 in `apps/api`), 86 integration (24 in `apps/api`).

### ESM vs CommonJS
**ESM, unchanged.** Nest 11.2 + Express 5.2 did not fight it. The real ESM-adjacent hazard was
different and is worth recording: `emitDecoratorMetadata` is **deliberately off**, because esbuild
— which Vitest uses to transform TypeScript — does not implement it, so any DI relying on
`design:paramtypes` would resolve under `tsc` and silently fail under test. Every injected
constructor parameter therefore carries an explicit `@Inject(TOKEN)`. Documented in
`apps/api/tsconfig.json`.

### Deviations from the brief, with reasons
1. **`common/decorators/access.decorator.ts` created here** per ruling F5. Exports
   `ACCESS_METADATA_KEY`, `AccessDeclaration`, `Public()`, `RequirePermission(permission)`. One
   metadata key with a discriminated shape, not two keys, so "public AND permission-guarded" and
   "no declaration at all" stay distinguishable for Task 11's boot assertion.
2. **The 5xx-message rule was rewritten.** The brief's `HttpException` branch passes
   `exception.message` through at *any* status. `new InternalServerErrorException(err.message)` is
   an ordinary Nest idiom, so that branch leaked. Now **status decides, not exception class**: any
   `HttpException` ≥ 500 gets the generic message. The one deliberate exception is `DomainError`,
   which is authored here — that is what lets `/health/ready` return 503 naming the dead
   dependency, and `DEPENDENCY_UNAVAILABLE` exists in `errors.md` §3 precisely for that.
   *(The implementer initially made all 5xx generic; the readiness integration test caught that it
   destroyed the endpoint's only job, and it reverted with a test locking the contract.)*
3. **`redactSecretsInText` applied to client-bound 4xx text and `redact()` to `details`** — reusing
   the Task 3 exports. A backstop, not the primary control; the residual duty ("never build a
   `DomainError` out of driver output") is written into the docblock and into `errors.md` §5.
4. **`configureApp` lives in `app-setup.ts`, not `main.ts`.** Importing `main.ts` ran `bootstrap()`
   as an import side effect and bound a port. Also, ESM import hoisting meant `dotenv` loaded
   *after* the module body — a real bug the first integration run surfaced.
5. **`RequestIdMiddleware` validates the inbound header** (`^[A-Za-z0-9_-]{1,64}$`) instead of
   trusting it. Untrusted input with two sinks: a structured log line (newline → forged log record)
   and a response header.
6. **`PrismaLifecycle.onApplicationBootstrap` connects eagerly.** Measured: Prisma's *first* query
   costs **2109 ms** cold (query-engine spawn) — longer than the probe timeout. Left lazy, the
   first `/health/ready` after every deploy reports Postgres down. Failure is swallowed so the
   service still starts during a DB outage.
7. **`NestLoggerBridge`** routes Nest's own bootstrap/`ExceptionsHandler` output through pino.
   Without it the process emits two log formats (violating `monitoring.md` §2) and
   `ExceptionsHandler` writes an unredacted stack to stdout.
8. **`app.set('etag', false)`** — an ETag alongside `Cache-Control: no-store` is a contradiction,
   and Express computes it by hashing every response body, i.e. hashing tenant data per request.
9. **`SecurityHeadersMiddleware` takes `enforceCsp` via an injected `CSP_ENFORCE` token** rather
   than a bare `boolean` constructor arg — Nest's `consumer.apply()` takes classes, not instances.
10. **`eslint.config.js` gains one exemption**: `apps/api/src/infrastructure/prisma/**` may import
    `@sentinel/db/unscoped`. That directory is the API's composition root for the base client that
    `createTenantClient` wraps. Directory-scoped, next to the existing exemptions.

### Ruling F6 — the global-prefix exclusion, measured
A probe stood up the real app four ways and hit both URLs. **The brief's `health/(.*)` works fine on
this stack** — the implementer's initial code comment claiming it throws on Express 5 was wrong and
it corrected that before committing. Nest evaluates prefix exclusions with its own matcher, not
through Express's router, so path-to-regexp v8's stricter syntax never reaches it:

```
NO exclude         => /health/live 404 | /api/health/live 200   <-- negative control
health/(.*)        => /health/live 200 | /api/health/live 404
health/{*splat}    => /health/live 200 | /api/health/live 404
health             => /health/live 404 | /api/health/live 200   <-- does NOT work
```

Shipped `health/{*splat}` so both wildcard sites read the same way. The negative control is what
makes the integration test non-decorative.

### Security properties — what was actually run
1. **The 500 path leaks nothing.** Three realistic throwers behind real routes: a Prisma-shaped
   error carrying `code: 'P2002'`, `meta.target: ['Finding_organizationId_fingerprint_key']`,
   `clientVersion: '6.19.3'` and a message naming `db-primary.internal:5432` and role
   `sentinel_app`; an `ECONNREFUSED 10.42.0.7:5432`; and a
   `redis://sentinel:hunter2@10.42.0.9:6379`. Each returns exactly `{"error":{code,message,requestId}}`
   — asserted by `Object.keys(...)`, not just substring absence — and the body is swept for 14
   forbidden strings.
2. **`HttpException.message` — what Nest actually puts there.** Measured, not assumed:

```
new BadRequestException()                      | "Bad Request"                                  | 400
new BadRequestException("boom")                | "boom"                                         | 400
new BadRequestException({message:["a"],x:1})   | "Bad Request Exception"                        | 400
new NotFoundException()                        | "Not Found"                                    | 404
new InternalServerErrorException("db oops")    | "db oops"                                      | 500
new HttpException({a:1},418)                   | "Http Exception"                               | 418
ParseIntPipe on "abc"                          | "Validation failed (numeric string is expected)" | 400
```

   Router 404 in the live app: `"Cannot GET /api/v1/does-not-exist"` — the caller's own request
   line, nothing internal. **The `InternalServerErrorException("db oops")` row is the leak the
   brief's filter had**, and is why the middle branch is now status-gated.
3. **Fresh CSP nonce per request.** 25 draws all distinct; two live requests produce different
   policies. No `unsafe-inline`, no `unsafe-eval`, asserted at both layers.
4. **Liveness touches no dependency — proved by breaking one.** `docker stop sentinel-redis-1`:

```
LIVE:     {"status":"ok"}                                                    <-- HTTP 200
READY:    {"error":{"code":"DEPENDENCY_UNAVAILABLE", ...
           "details":{"dependencies":{"postgres":"ok","redis":"error","storage":"ok"}}}}   <-- 503
DETAILED: {"status":"degraded", ... "redis":{"status":"error","latencyMs":951.9} ...}      <-- 200
```

   Redis restarted and readiness recovered. The property is also locked by four integration tests
   building a second real application against a dead Redis port.
5. **Health endpoints leak no infrastructure detail.** **`monitoring.md` §5 is not silent — it says
   authenticated**, and `backend.md` §8 agrees. Authentication does not exist until Phase 2, so
   `/health/detailed` ships as readiness **plus per-probe latency and nothing else**, with an
   integration test sweeping for `localhost`, `127.0.0.1`, `5432`, `6379`, `9000`, `postgresql`,
   `redis://`, `minio`, `evidence`, `prisma`, `version`.

### Drills: 5 run, 5 caught
1. Remove `X-Frame-Options` → 1 unit + 1 integration red.
2. Freeze the CSP nonce at module scope → 1 unit + 1 integration red.
3. Generic branch passes `exception.message` → 1 unit + 3 integration red.
4. *(extra)* Remove the 5xx `HttpException` guard → 2 unit red.
5. *(extra)* Remove request-ID validation → 6 unit + 1 integration red.

### Gaps the implementer reported rather than papering over
- The brief's `HttpException` branch leaks; the plan text is wrong as written.
- **Storage probe blind spot (not fixed, by choice).** S3 answers HEAD on a missing *bucket* with
  the same 404 as a missing key, so a deleted bucket would report `storage: 'ok'`. `list()` would
  close it but needs `s3:ListBucket`, which the production evidence credential is not guaranteed to
  hold.
- **`errors.md` §7 is not satisfied** — "every documented code has at least one test that produces
  it" cannot be met while most codes have no endpoint that can raise them.
- **The access decorators are metadata nothing reads** until Task 11's boot assertion.
- **`report-uri /api/v1/csp-report` points at a route that does not exist** — arrives with `apps/web`.
- **The Redis `error`-event handler logs on every reconnect attempt** (~1 line/2 s during an outage)
  with no rate limiting. Deliberate; needs throttling before production.
- **Object-shaped `HttpException` collapses** to `"Bad Request Exception"` because the filter reads
  `.message` and never `getResponse()`. Safe, but latent.

---

## Round 1 — review report

**Verdict: findings remain.** No Criticals; four Importants.

Gates re-run cold (`turbo run lint typecheck build --force`, 18/18, 0 cached). Every claim above was
attacked and survived: the 5xx gating, the `DomainError` exemption (only two construction sites
exist in the whole tree, neither built from driver output), request-ID validation (percent-encoded
CRLF, literal tab, U+2028, U+2029, 65-char overflow, JSON-breaking payload, duplicated header — all
refused), CSP, liveness/readiness under both **refused and hung** dependencies (TCP blackhole:
readiness bounded at 2.009 s, liveness 200 in 1.9 ms), shutdown ordering (`httpServer.close` →
`redis.quit` → `prisma.$disconnect`), the tenant-scoping lint exemption (`prisma.module.ts:12` is
the sole `@sentinel/db/unscoped` import in `apps/`), and the log path (123 live lines across four
app instances: 100% JSON, zero credentials, including a `redis://` URL with a password).
25 mutations run, 21 red; the 4 green were correct defence-in-depth.

**I1 — security headers and the request ID are absent on a whole class of responses.**
`app.module.ts:27`. `forRoutes({ path: '*splat' })` registers module middleware *under the global
prefix*, so the chain runs only on `/api/<≥1 seg>/**` and `/health/<≥1 seg>/**`:

```
/                nosniff=0   x-request-id=0
/a  /a/b  /a/b/c nosniff=0   x-request-id=0
/api  /health    nosniff=0   x-request-id=0
/healthz         nosniff=0   x-request-id=0
```

Separately, Nest's body parser runs *before* module middleware, so a body-parse failure bypasses the
chain even on a covered path, returning `req_unknown` in both envelope and log.
`transport-and-headers.md` §2 says "Applied to every application response"; the test that claimed to
guard it picked `/api/v1/does-not-exist`, which sits *inside* the covered tree.

**I2 — a 413 is served to the client as a 500.** `all-exceptions.filter.ts:135`.
`PayloadTooLargeError` carries `status: 413` but is not a Nest `HttpException`, and Nest's
`mapExternalException` converts only `SyntaxError`/`URIError`. Anyone can drive the 5xx error rate
that `monitoring.md` §6 alerts on.

**I3 — unmapped 4xx statuses carry a Server-class code.** `all-exceptions.filter.ts:127`.
413/415/405/406 return HTTP 4xx with `code: "INTERNAL_ERROR"`, which `errors.md` §3 files under
**Server**.

**I4 — the health probe's error branch has no shape assertion.** The reviewer added
`host: 'db-primary.internal:5432', driver: 'prisma-6.19.3'` to the error return: **green at both
unit and integration level.** The `Object.keys` assertion only ever ran against an all-healthy
report; the outage tests checked a hand-picked string list.

**Minors:** `packages/config/tsconfig/nest.json` still sets `emitDecoratorMetadata: true`; the body
parser echoes the caller's raw body in its 400 message; `/health/detailed` returns 200 while
`status: "degraded"`; the object-shaped `HttpException` collapse; `nest-cli.json` is inert;
`transport-and-headers.md`'s Status block overstates coverage.

---

## Round 2 — fix report (`73b04f3`)

All four Importants fixed. Mutation proofs:

**I1.** *Order reversal* against the new `app-setup.spec.ts` → 1 red naming the headers that lost
their correlation ID. *Registration reverted to `MiddlewareConsumer`* → **9 new tests red while all
24 pre-existing tests stayed green** — precisely the reviewer's point about the old test's URL
sitting inside the covered tree.

**I2.** Deleting the `asHttpError` branch → 3 unit + 1 integration red. Dropping the `expose`
requirement so any `status` is trusted → 1 red (a Prisma-shaped error with `status: 404` and no
`expose`).

**I3.** Restoring `STATUS_TO_CODE[status] ?? INTERNAL_ERROR` → 5 red.

**I4 — the proof that matters.** The reviewer's exact leak applied to `probe()`'s catch branch, run
first against the **HEAD** specs:

| suite | result with the leak present |
|---|---|
| HEAD `health.service.spec.ts` | `Tests 10 passed (10)` — **green** |
| HEAD `app.integration.spec.ts -t detailed` | `2 passed \| 22 skipped` — **green** |

Against the new specs: both **red**. `health.service.ts` is byte-identical to HEAD and does not
appear in the commit — the defect was entirely in the tests.

**Middleware construction.** `new SecurityHeadersMiddleware(app.get<boolean>(CSP_ENFORCE))`.
Rejected: a constructor default (a second `APP_ENV`→policy decision outside `infrastructure/config`)
and reading `process.env` in `app-setup.ts` (breaks the one-permitted-place rule). Registered as thin
arrow wrappers rather than `.bind()` so arity stays 3 — Express treats a 4-arg function as an error
handler.

**Flagged rather than decided:** an `http-errors` 4xx with `expose: false` returned the *server*
generic message. Controller ruled: fix it in the same round. Two constants,
`SERVER_GENERIC_MESSAGE` (byte-identical) and `CLIENT_GENERIC_MESSAGE`; collapsing **either**
direction now reddens a test.

**Pre-existing, not caused by this change:** `pnpm format:check` fails at HEAD on 13 files and is not
one of the five gates. Carried to Task 14.

---

## Round 2 — scoped re-review: **APPROVED**

No Critical, no Important. The reviewer introspected the **live Express stack** on the built `dist`
app rather than trusting the citation:

```
BEFORE configureApp: ["0:<anonymous>/3"]
AFTER configureApp:  ["0:…/3","1:…/3","2:…/3"]
AFTER app.init():    [...,"3:jsonParser/3","4:urlencodedParser/3","5-8:handle/3","9:…/4"]
```

Parsers land at 3–4, behind the two cross-cutting handlers at 1–2. Exactly two registrations, both
arity 3. ALS still spans the whole request (the `LoggingInterceptor` binds no `requestId` itself yet
its live line carries one). **The potential Critical was settled by measurement:**
`app.get(CSP_ENFORCE)` pre-`init()` resolves in every environment, and a *missing* token throws
`UnknownElementException` and kills the process at boot — the silent report-only-in-production
failure mode is not reachable. Nothing was silently dropped when `app.module.spec.ts` was deleted:
all its guarantees are live in `app-setup.spec.ts` and each reddens under mutation. Live production
run across 15 request shapes (incl. HEAD/OPTIONS/TRACE/PATCH, malformed JSON, 200 KB body, bad
`Content-Encoding`/charset): every one carried the full 11-header set plus `x-request-id`, none
carried `x-powered-by` or `ETag`.

Five Minors, all documentation tidy-ups or unreachable edge cases.

*Informational:* Node's own HTTP parser answers oversized headers with a bare `431` and a malformed
request line with a bare `400` — no headers, no request ID, no JS executed. Only a
`server.on('clientError')` handler could reach it. Not claimed by the corrected doc, so not a finding.

---

## Round 3 — Minors, fixed directly by the controller (`58921e2`)

*Controller-authored; no dispatch.* Three small, fully-specified edits. The two code Minors were the
same defect class: **a rule and the comment describing it had drifted apart.**

- `codeForStatus` claimed to map "any unmapped **client-class** status" but tested only
  `status < 500`, so a 204 or 302 reaching the exception filter would have been reported to the
  caller as their own bad request. Range now checked at both ends.
- `asHttpError` read `expose`/`status`/`statusCode` straight off a throwable this filter did not
  construct. A getter that throws propagated **out of `catch()` itself**, replacing the shared
  envelope with the framework's default handler output — a filter that throws while reporting a
  failure hides the failure it was reporting. Every read is now guarded the way `redact()` guards its
  own; unreadable is treated as absent.

Both proven by mutation: dropping the lower bound reddens the sub-400 test; removing the guards
reddens the throwing-getter test with `expected [Function] to not throw`.

`errors.md` gained what the code comment already said but the contract document did not:
`VALIDATION_ERROR` is also the fallback for an unmapped client-class status, so `details.fields` is
absent on a 413 and a client must treat it as optional. **Task 11 generates OpenAPI from this
document**, which is why the trade belongs there and not only in a source comment. Rule count in §5
corrected 2 → 3.

**Carried out of Task 9:** `packages/config/tsconfig/*` presets are dead config — every workspace
tsconfig extends `../../tsconfig.base.json`, so the `emitDecoratorMetadata: false` fix in `nest.json`
is inert (the load-bearing copy is `apps/api/tsconfig.json`). Pre-existing; Task 16 decides whether
to wire them up or delete them.

**Final state:** gates cold-verified — `turbo --force` 18/18 uncached, 196 unit, 95 integration, tree
clean.
