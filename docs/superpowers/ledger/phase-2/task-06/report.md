# Phase 2 · Task 6 — implementer report

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Branch `feat/phase-2-task-06`, cut from `main` at `2fceaaa`. Not pushed, no PR.
Task 7 not started.

## 1. Verification commands and exit codes

Run in this order on the finished tree, working directory clean and identical to `2deaa4c`, with
the compose stack up. Each code is the shell status captured immediately after the command and
outside any pipe (`out=$(cmd 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | **0** | `All matched files use Prettier code style!` |
| `pnpm lint` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm test` | **0** | `Test Files 63 passed (63)` · `Tests 911 passed (911)` |
| `pnpm check:specs` | **0** | `check:specs OK — 77 spec files, each claimed by exactly one of: unit, integration, ui. No banned .test.* spellings.` |
| `pnpm test:integration` | **0** | `Test Files 14 passed (14)` · `Tests 189 passed (189)` |
| `pnpm build` | **0** | `Tasks: 8 successful, 8 total` |
| `pnpm check:openapi` | **0** | `"routes":4` · `check:openapi OK — apps/api/openapi.json is byte-identical to what the contracts generate.` |
| `pnpm check:registry` | **0** | `check:registry OK — 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global.` |
| `pnpm check:secrets` | **0** | `check:secrets OK — 332 tracked files, no credential-shaped literals.` |
| `docker compose ps` | **0** | four containers, all `Up 21 hours (healthy)`: postgres, redis, minio, mailpit |

`pnpm test:e2e` was not run and is not expected: no path under `apps/web` was touched
(`git diff --stat 2fceaaa..HEAD` lists no `apps/web` file).

### Before / after counts

| Suite | On `main` at `2fceaaa` (per the brief) | After |
|---|---|---|
| `pnpm test` | 61 files / 847 tests | **63 files / 911 tests** |
| `pnpm test:integration` | 13 files / 169 tests | **14 files / 189 tests** |

**I did not re-run either suite on `2fceaaa` myself** — the baseline is the brief's, and I report it
as such. The deltas reconcile exactly against files I can account for: +2 unit files
(`cookies.spec.ts`, `session.service.spec.ts`) and +64 unit tests (14 in `cookies.spec.ts`, 35 in
`session.service.spec.ts`, 14 added to `packages/config/src/env.spec.ts`, 1 added to
`auth.module.spec.ts`); +1 integration file and +20 integration tests, all in
`session.service.integration.spec.ts`.

### The two checks that prove what was *not* shipped

`pnpm check:openapi` printing `"routes":4` is the evidence that this task shipped no endpoint.
`auth.module.spec.ts`'s `registers no controller` still passes, unchanged.

## 2. Files created

| File | What it does |
|---|---|
| `apps/api/src/modules/auth/cookies.ts` | The `__Host-session` name and its four attributes as one authority, with a serialiser and a clearer. Pure string functions; no `Request`, no `Response`, and no cookie parsing. |
| `apps/api/src/modules/auth/cookies.spec.ts` | 14 unit tests: one per attribute, the `Max-Age` arithmetic, and the header-injection guard on the cookie value. |
| `apps/api/src/modules/auth/session.cache.ts` | The `SessionCache` port and its `RedisSessionCache` adapter — the tombstone value, the Lua compare-and-set that will not overwrite one, and the swallowing of a Redis failure into a return value. |
| `apps/api/src/modules/auth/session.repository.ts` | Postgres access for `Session` behind a narrow Prisma port, restating `SessionStatus`. Holds `rotate`'s transaction and the affected-row-count gates. No policy. |
| `apps/api/src/modules/auth/session.service.ts` | The policy: both lifetimes, rolling renewal past the halfway mark, rotation inheritance, revocation, the two bulk revocations, cache-key construction, and Zod at the input boundary. |
| `apps/api/src/modules/auth/session.service.spec.ts` | 35 unit tests against a recording Prisma double and an in-memory cache: arithmetic, thresholds, key construction, input handling, call ordering, and the `SessionStatus` parity check against `datamodelEnums()`. |
| `apps/api/src/modules/auth/session.service.integration.spec.ts` | 20 tests against a Testcontainers Postgres and the compose Redis — the four properties a fake makes true by construction. |

### `session.cache.ts` is a fourth file the brief did not name

The brief lists three deliverables: `session.service.ts`, `session.repository.ts`, `cookies.ts`.
The cache was split out for two reasons, both of which the code would be worse without.

1. **It is where the ioredis-specific types live.** `SessionService` takes a three-method port
   (`read`, `writeLive`, `writeTombstone`); the adapter is the only thing that has ever seen a
   `Redis` instance. That is what makes the Redis-down path testable by pointing one constructor
   argument at a dead port, and what keeps ADR-0005's fallback promise structural rather than a
   `try`/`catch` repeated at four call sites in the service.
2. **The tombstone invariant is a property of the cache, not of the session policy**, and it has a
   Lua script attached. Putting it in `session.service.ts` would have buried the one measured
   security control of this task (§5) inside a file about lifetimes.

`SessionRepository` is registered as an `AuthModule` provider but is **not** exported;
`SESSION_CACHE` is a token so `RedisSessionCache` stays substitutable.

## 3. Files changed

| File | What changed |
|---|---|
| `packages/config/src/env.ts` | Five `SESSION_*` variables added **inside the base object, before the refinement** (carry-forward ruling 30), plus one new cross-field rule `checkSessionLifetimes` called alongside the existing two. |
| `packages/config/src/env.spec.ts` | +14 tests for the five variables and the two ordering rules, including that no rule returns out of the shared `superRefine`. |
| `.env.example` | The five variables with §3's numbers, and a note naming which two are choices rather than quotations. |
| `apps/api/src/modules/auth/auth.tokens.ts` | `SESSION_POLICY` and `SESSION_CACHE` injection tokens. |
| `apps/api/src/modules/auth/auth.module.ts` | Imports `RedisModule`; provides the policy from `ENV`, `SESSION_CACHE` as `RedisSessionCache`, plus `SessionRepository` and `SessionService`. Exports `SessionService` and not the repository. Still registers no controller. |
| `apps/api/src/modules/auth/auth.module.spec.ts` | A `REDIS` stub override beside the existing `PRISMA` one, the five `SESSION_*` env fields, "all four services", and a new test that the repository is not exported. |
| `.claude/security/authentication.md` | §3 only, plus the status banner — see §7. |

## 4. Commits

```
b895980 feat(auth): the session cookie's name and attributes, as pure functions
31f9e0c feat(config): session lifetimes and the cache TTL, with two ordering rules
0429afa feat(auth): SessionService — issue, resolve, rotate, revoke, with a cached lookup
8b7f3b7 test(auth): the session properties only a real Postgres and Redis can prove
2deaa4c docs(security): §3 names what of the session layer is built and what is not
```

`git status --short` was empty at `2deaa4c`, before this report was written.

## 5. The revocation-immediacy test, named

**File:** `apps/api/src/modules/auth/session.service.integration.spec.ts`
**Test:** `revocation is immediate > refuses the very next resolve after a revoke`

It issues a session, resolves it once so the cache entry is genuinely warm — asserted directly with
`redis.get` on the key, so a refusal cannot come from a cache that never held the session — revokes
it, and asserts that the very next `resolve` returns `{ outcome: 'revoked' }`.

A second test in the same block is the stronger one, and is the one that fails against the ordinary
cache design (§6.3):
`revocation is immediate > refuses even when a resolve was already in flight over the revocation`.

The run that proves them —
`pnpm exec vitest run --project integration --no-file-parallelism apps/api/src/modules/auth/session.service.integration.spec.ts --reporter=verbose`,
exit **0**. Each line as printed, with the leading
`integration  apps/api/src/modules/auth/session.service.integration.spec.ts > ` elided for width and
nothing else altered:

```
 ✓ revocation is immediate > refuses the very next resolve after a revoke 16ms
 ✓ revocation is immediate > refuses even when a resolve was already in flight over the revocation 9ms
 ✓ revocation is immediate > refuses a session revoked while its cache entry was warm and Redis was reachable 9ms
 ✓ the two lifetimes, independently > refuses a session past its ABSOLUTE clock while its idle clock is fresh 4ms
 ✓ the two lifetimes, independently > refuses a session past its IDLE clock while its absolute clock is fresh 3ms
 ✓ the two lifetimes, independently > accepts a session fresh on both — the negative control 4ms
 ✓ rolling renewal > moves the idle clock once past the halfway mark 7ms
 ✓ rolling renewal > leaves the row untouched before the halfway mark — a read is not a write 5ms
 ✓ rolling renewal > never renews past the absolute clock 7ms
 ✓ rotation > kills the old credential and mints a new one — the session-fixation defence 17ms
 ✓ rotation > leaves exactly one live successor when two rotations race — ten rounds 134ms
 ✓ rotation > rotates two different sessions concurrently — the gate is per row, not global 9ms
 ✓ bulk revocation > revokes every other session of a user and keeps the one excepted 18ms
 ✓ bulk revocation > revokes only the sessions acting in the named organisation 13ms
 ✓ when Redis is unavailable > resolves from Postgres instead of failing — ADR-0005 promises this 4ms
 ✓ when Redis is unavailable > still refuses a revoked session, because Postgres is the authority 6ms
 ✓ when Redis is unavailable > revokes the row even though it cannot poison a cache entry 6ms
 ✓ when Redis is unavailable > still enforces both clocks with no cache at all 3ms
 ✓ the stored row > holds only a hash — the database cannot mint a session 3ms
 ✓ the stored row > never stores the raw token in Redis either 5ms
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

## 6. The measurements

### 6.1 Does rotation need ruling 31's advisory lock?

**Conclusion: no. The affected-row-count decision already serialises it, and that was measured in
both directions. No advisory lock was added — `pg_advisory_xact_lock` appears nowhere in this
task's diff.**

The reasoning the measurement was taken to test: rotation supersedes **one already-committed row by
primary key**, so a second transaction's `UPDATE ... WHERE id = ? AND "revokedAt" IS NULL` blocks on
that row's lock and, once the first commits, re-evaluates the predicate against the committed
version and reports `count: 0`. That is `TokenService.consume`'s shape. `TokenService.issue` needs
the advisory lock because its predicate is `(userId, purpose) WHERE consumedAt IS NULL` over a
**non-unique** index, where there is no row for the second transaction to block on at all.

**What was fired:** ten rounds, each issuing one session and then calling
`service.rotate({ sessionId })` twice in parallel via `Promise.all`.

**What was counted:** per round, `prisma.session.count({ where: { rotatedFromId: <predecessor>,
revokedAt: null } })` — live successors of that one credential — and how many of the two `rotate`
calls returned a session rather than `null`.

**With the shipped implementation** (the affected-row gate), test
`rotation > leaves exactly one live successor when two rotations race — ten rounds`, exit **0**:
`liveSuccessors` was `[1,1,1,1,1,1,1,1,1,1]`, and the per-round
`expect(results.filter((result) => result !== null)).toHaveLength(1)` held in all ten rounds.

**With a read-then-write rotation** — `findUnique`, check `revokedAt === null`, then update
unconditionally, then insert — temporarily substituted into `SessionRepository.rotate`, the same ten
rounds failed. Vitest printed one array element per line; runs of identical elements are collapsed
here for width and nothing else is changed:

```
AssertionError: expected { …(2) } to deeply equal { …(2) }

- Expected
+ Received

  {
    "liveSuccessors": [
      1,
-     1, 1, 1, 1, 1, 1, 1, 1, 1,
+     2, 2, 2, 2, 2, 2, 2, 2, 2,
    ],
    "probeAccepted": [
-     1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
+     1, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    ],
  }
```

`probeAccepted` is a temporary counter of how many of the two `rotate` calls returned a session; it
was added for this probe and removed afterwards. **Nine of ten rounds left two live successors of
one credential, with both rotations reporting success** — the session-fixation defence not
defending. Round one produced one, which is why ten rounds were run rather than one.

The probe was reverted with `git checkout -- apps/api/src/modules/auth/session.repository.ts` and
the full spec re-run green (20 passed, exit 0) before the commit;
`grep -c "PROBE ONLY" apps/api/src/modules/auth/session.repository.ts` returns `0`.

### 6.2 Is a `__Host-` cookie accepted over `http://localhost` in a real Chromium?

**Conclusion: yes. Chromium 151.0.7922.34.**

Script: `host-cookie-probe.mjs` in the session scratchpad, not committed. A throwaway `node:http`
server bound to an ephemeral port, navigated to as `http://localhost:<port>/set`, emitting three
`Set-Cookie` headers in one response — the real one and two negative controls that `__Host-`
forbids — then a second navigation to `/echo` that prints back the `Cookie` header the server saw.

The three headers sent:

```
__Host-session=probe-value-not-a-real-token; HttpOnly; Secure; SameSite=Lax; Path=/
__Host-control=probe-value-not-a-real-token; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=localhost
__Host-control2=probe-value-not-a-real-token; HttpOnly; Secure; SameSite=Lax; Path=/sub
```

Verbatim output of `node host-cookie-probe.mjs`, exit **0**:

```
chromium version: 151.0.7922.34
cookie jar after Set-Cookie: [
  {
    "name": "__Host-session",
    "value": "probe-value-not-a-real-token",
    "domain": "localhost",
    "path": "/",
    "expires": -1,
    "httpOnly": true,
    "secure": true,
    "sameSite": "Lax"
  }
]
server saw on the next request -> cookie-header: __Host-session=probe-value-not-a-real-token
```

Two things this establishes, and it needs both:

1. A `__Host-` prefixed cookie carrying `Secure` **is** stored over plain `http://localhost` and is
   sent back on the next request to that origin.
2. The browser is enforcing the prefix's rules rather than ignoring the prefix. **Both** controls
   were rejected — the jar holds one cookie, not three. Without them a positive result would be
   equally consistent with a Chromium that treats `__Host-` as an ordinary name, and would prove
   nothing about Task 18.

The cookie value is deliberately low-entropy so that pasting it into this tracked file does not trip
`pnpm check:secrets`, which exits 0 in §1 with this file tracked.

### 6.3 A third measurement, not asked for: the cache tombstone

The brief named two measurements. A third was taken because the brief's own statement of the
revocation rule turned out to be insufficient, and it is why `.claude/security/authentication.md`
§3 was corrected (§7.1).

The brief says: *"Revocation deletes the cache entry and the row together, in that order. The order
is the control: delete the row first and a concurrent request can repopulate the cache from a read
that raced the delete."*

The first sentence is the requirement and it is met. **The reason given for the ordering is not
sufficient**: deleting the cache entry *first* does not close that race either. A resolve that has
already read a live row can land its `SET` after the `DEL`, whichever half of revocation went first.
Reversing the order moves the window; it does not remove it. Shipping the brief's ordering with the
brief's reason written beside it would have been a correct-looking decision carrying a false
rationale, which is carry-forward ruling 22's defect class.

So revocation writes a **tombstone** (`SET key 'revoked' EX ttl`, unconditional) and every live
cache write goes through a Lua script that refuses to run over one. Redis executes a script
atomically, so "the tombstone was written" and "the live write's `GET`" are totally ordered, with no
third case.

Watched failing: `RedisSessionCache.writeLive` temporarily replaced with a plain `SET` and
`writeTombstone` with a `DEL` — the ordinary design — leaving the ordering exactly as the brief
specifies, cache first and then row. The racing test then failed:

```
 FAIL  revocation is immediate > refuses even when a resolve was already in flight over the revocation
AssertionError: expected { outcome: 'resolved', …(1) } to deeply equal { outcome: 'revoked' }

- Expected
+ Received

  {
-   "outcome": "revoked",
+   "outcome": "resolved",
+   "session": {
+     "absoluteExpiresAt": 2026-09-02T11:25:18.178Z,
+     "activeOrganizationId": null,
+     "id": "ses_01M0YX2F…",
+     "idleExpiresAt": 2026-08-27T11:25:18.178Z,
+     "lastSeenAt": 2026-08-26T11:25:18.178Z,
+     "mfaCompletedAt": null,
+     "rememberMe": false,
```

An earlier run of the same probe, before the two assertions in that test were reordered, showed the
mechanism directly — the key held the session's JSON rather than a tombstone:

```
AssertionError: expected '{"v":1,"id":"ses_01M0YX1R…' to be 'revoked'
Received: {"v":1,"id":"ses_01M0YX1R…","userId":"usr_01M0YX1M…",
"status":"ACTIVE","activeOrganizationId":null,"rememberMe":false,
"absoluteExpiresAt":"2026-09-02T11:24:54.493Z","idleExpiresAt":"2026-08-27T11:24:54.493Z",
"lastSeenAt":"2026-08-26T11:24:54.493Z","mfaCompletedAt":null}
```

> **The row identifiers in the two blocks above are shortened, and nothing else in them is.** They
> are UUIDv7-derived ids for rows in a throwaway Testcontainers database and carry no evidence — the
> evidence is `outcome: 'resolved'` and the payload being a live session rather than a tombstone.
> They are shortened because `scripts/check-secret-shaped-literals.ts` excludes `docs/superpowers/`
> by path, so a 26-character high-entropy run in this file is exactly the shape that has failed
> GitGuardian on four of this repository's pull requests with no credential involved (ruling 63).

**A session revoked in Postgres was served as `resolved` on the next resolve.** The probe was
reverted with `git checkout -- apps/api/src/modules/auth/session.cache.ts`;
`grep -c "PROBE ONLY" apps/api/src/modules/auth/session.cache.ts` returns `0`, and the full spec was
re-run green (20 passed, exit 0) before the commit.

## 7. Where the plan, the brief, or a `.claude/` document turned out to be wrong

1. **`security/authentication.md` §3's revocation bullet said "revocation deletes the cache entry
   and the row together".** A delete does not achieve what the bullet promises, in either order —
   measured, §6.3. The bullet now reads "reaches", and a paragraph below it records the tombstone,
   the measurement, and the residual. §3 and the file's status banner are the only parts of the only
   `.claude/` document this task touched.
2. **The brief's rationale for the ordering is insufficient**, for the same reason. The ruling was
   not ignored: revocation still poisons the cache before it writes the row, and the ordering is
   still fail-closed. What changed is the mechanism that makes the ordering sufficient, and the
   sentence written beside it.
3. **The plan's Task 6 checklist and the brief both say rotation means "mark the old row rotated".**
   There is no `ROTATED` status. `enum SessionStatus` in `packages/db/prisma/schema.prisma` has
   exactly `PENDING_MFA` and `ACTIVE` (line 56), and the model carries `revokedAt` and
   `rotatedFromId`. Rotation therefore sets `revokedAt` on the predecessor and `rotatedFromId` on
   the successor. No schema change was needed and none was made; the security document's own §3
   wording, "rotated on every privilege change", is what was implemented.
4. **Ruling 32 stays where it was.** Task 6 opened no migration:
   `git diff --stat 2fceaaa..HEAD` lists no file under `packages/db/`. `schema.prisma` was never
   edited, so ruling 39's obligation to re-run `prisma generate` after reverting a mutation never
   arose — `prisma generate` ran regardless as part of `@sentinel/db:build` on every `pnpm test` and
   `pnpm typecheck`.
5. **Ruling 40 earned its place again.** `pnpm typecheck` failed on four `exactOptionalPropertyTypes`
   errors (TS2379/TS2345) at a point when the affected specs had not yet been written, so `pnpm test`
   and `pnpm lint` had nothing to say about them. All three were run at the end.

## 8. Decisions a reviewer may want to overturn

1. **The cache uses a tombstone plus a Lua compare-and-set rather than `DEL`/`SET`** — more moving
   parts than the brief's shape, and a Lua script on the request path. Justification is §6.3. Cost
   if wrong: a subtly incorrect script fails closed — no live entry is written and every request
   reads Postgres — which is the safe direction.
2. **"Remember me" controls whether the cookie is persistent, not only how long the row lives.**
   Without it `serialiseSessionCookie` emits no `Max-Age` and the browser discards the cookie on
   close; with it, `Max-Age` is the remaining absolute lifetime. §3 does not say this. The server
   remains the sole authority on lifetime either way.
3. **A fifth environment variable, `SESSION_PENDING_MFA_LIFETIME_SECONDS`, default 600.** §5 says
   only "short-lived" and gives no number, so ten minutes is a choice — labelled as one in the code,
   in `.env.example` and in §3's banner. Without it a `PENDING_MFA` session would inherit the
   seven-day absolute lifetime, making a password-only credential last a week.
4. **Two new cross-field configuration rules** — remember-me not shorter than ordinary, pending-MFA
   not longer than a full session. Neither was asked for. Both refuse a boot rather than a request,
   so the cost if wrong is a refused deploy on a configuration nobody would write deliberately.
5. **`rotate` inherits the predecessor's `absoluteExpiresAt`**, except across
   `PENDING_MFA` -> `ACTIVE`. §3 says the absolute lifetime never moves; a rotation that restarted
   it would make the seven-day cap unbounded for anyone changing their password weekly. The
   exception exists because a pending session's ten minutes were never the user's session lifetime.
6. **An over-long `ip` is recorded as `NULL`, not truncated and not refused.** A truncated address
   is a different address in a column read during incidents; refusing would let a forwarded header
   fail a login. `userAgent` **is** truncated, at 512, because a truncated user agent is still the
   breadcrumb it exists to be, and the brief asks for a length cap there specifically.
7. **`resolve` returns a four-armed outcome rather than a nullable session.**
   `api/authentication.md` §6 keeps `UNAUTHENTICATED` and `SESSION_EXPIRED` distinct, and a `null`
   would force Task 7 to invent that distinction or drop it. Reaching `expired` or `revoked`
   requires already holding a genuinely issued token, so it is not an account oracle.
8. **`SessionRepository` is a provider but not an export.** A consumer holding it could revoke a row
   without poisoning the cache entry that would go on serving it.
9. **`SessionService` takes `@Inject(SessionRepository)` explicitly** rather than relying on Nest's
   type-based resolution. The Vitest transform does not emit `design:paramtypes`, so the implicit
   form failed in `auth.module.spec.ts` with "Nest can't resolve dependencies of the SessionService
   (?, ...)" — better found there than at boot.

## 9. Test-first evidence

- `cookies.spec.ts` was written and run before `cookies.ts` existed:
  `Error: Cannot find module './cookies.js'`, `Test Files 1 failed (1)`, exit **1**. Then 14 passed,
  exit **0**.
- The session block appended to `packages/config/src/env.spec.ts` was run before the variables
  existed: `Tests 13 failed | 63 passed (76)`, exit **1**. Then 76 passed, exit **0**.
- The two properties in §6.1 and §6.3 were each watched failing against a deliberately wrong
  implementation, with the output quoted there.

Two failures during development were **spec** defects, not implementation defects. Both are recorded
because both would have been green for the wrong reason:

1. The racing-revocation test originally had one gate, so the revocation could land before the
   racing resolve had read anything and the interleaving it exists to create would never occur.
   Fixed with a second signal (`hasRead`) that the test waits on before revoking.
2. The bulk-revocation test counted `userB`'s sessions, and `userB` already had sessions from two
   earlier tests in the same file: `expected 3 to be 2`. Fixed with a `userC` used by that test
   alone.

## 10. Not done, could not verify, or deliberately left

- **Task 7 was not started.** No guard, no `Principal` construction, no CSRF, no CORS, and **no code
  anywhere reads a cookie off a request** — `cookies.ts` has no parser, deliberately.
- **Nothing calls any of this.** `SessionService` is invoked by specs and by nothing else.
  `pnpm check:openapi` reports four routes; `AuthModule` registers no controller.
- **No cookie has reached a browser from the application.** The only browser that has seen this
  header is §6.2's Chromium, against a throwaway `node:http` server.
- **`PENDING_MFA` is recorded and its short lifetime applies; nothing enforces what it may do.**
  "A pending session authenticates nothing except the MFA verification endpoint" is Task 7's.
- **The Redis-unreachable revocation residual is open and bounded, not closed.** If Redis is down
  when a revocation runs, the row is revoked but the cache entry cannot be poisoned, so an entry
  cached before the outage can serve until it expires — at most `SESSION_CACHE_TTL_SECONDS`,
  default 60. Asserted rather than assumed:
  `when Redis is unavailable > revokes the row even though it cannot poison a cache entry`.
- **The enumerate-then-revoke window in bulk revocation is open by design.** A session created
  between `listLiveForUser` and `revokeLiveForUser` is not revoked. Closing it belongs to the
  caller's ordering — a password change must write the new hash before calling — and the docblock on
  `revokeAllForUser` says so. Task 10 owns it; Task 14 inherits the same rule.
- **No cross-tenant isolation test, deliberately.** `Session` is user-owned, not tenant-owned, and is
  registered as deliberately-global in `packages/db/src/tenant-resources.ts`. The nearest equivalent
  — revoking a user's sessions in one organisation leaves another organisation's alone — is tested
  as `bulk revocation > revokes only the sessions acting in the named organisation`.
- **No performance number is claimed.** Nothing was benchmarked. The rolling-renewal rule is
  asserted behaviourally (`leaves the row untouched before the halfway mark — a read is not a
  write`), not as a measured reduction in write rate.
- **No session sweeper.** `@@index([absoluteExpiresAt])` exists in `schema.prisma` for pruning
  expired rows across all users; nothing sweeps them, and no task in the plan claims to.
- **`pnpm test:e2e` was not run.** No `apps/web` path was touched.
- **`pnpm db:migrate` was not run**, because there is no migration.
- **The compose Redis was left as found.** The integration spec deletes its keys by key in
  `afterAll` and never issues `FLUSHDB` or `FLUSHALL` (carry-forward ruling 33). Verified after the
  full suite: `redis-cli --scan --pattern 'session:v1:*'` returned 0 keys and `DBSIZE` was 10, all
  belonging to the rate-limit specs' namespace.
- **The two baseline test counts in §1 were not re-measured by me.** They are the brief's figures,
  and §1 says so.

## 11. Rulings this task passes forward

1. **`resolve` returns four outcomes, and Task 7 must map all four.** `resolved` — carrying the
   session's `status`, so `PENDING_MFA` becomes Task 7's `MFA_REQUIRED` — plus `unknown` ->
   `UNAUTHENTICATED`, and `expired` and `revoked` -> `SESSION_EXPIRED`. Collapsing `unknown` into
   `SESSION_EXPIRED` would tell a user with no cookie that their session ended.
2. **The cache tombstone is the immediacy control, not the ordering.** Any later code that writes the
   session cache must go through `SessionCache.writeLive`. A direct `redis.set` on a `session:v1:`
   key reopens the race §6.3 measured, silently.
3. **Revocation during a Redis outage is bounded, not closed** — §10. If a later task needs a hard
   guarantee during an outage, the answer is a shorter TTL or a different cache, not a change to the
   revocation path.
4. **Bulk revocation's enumerate-then-revoke window is the caller's to close.** Binds Task 10
   (password change and reset) and Task 14 (member removal): write the state change first, then
   revoke.
5. **`SessionService` checks no `User.status` and writes no `AuditEvent`**, matching carry-forward
   rulings 37 and 38 for `TokenService`. Task 9 owns refusing a `LOCKED` user at login; the endpoint
   owns the audit event.
6. **Two of the five session numbers are choices, not citations.**
   `SESSION_PENDING_MFA_LIFETIME_SECONDS` (600) and `SESSION_CACHE_TTL_SECONDS` (60). §5 says
   "short-lived"; ADR-0005 says "a short TTL". Neither document states a figure — do not re-quote
   these as though one did.
7. **Rotation needs no advisory lock, and that is measured, not argued** — §6.1. The distinction from
   carry-forward ruling 31 is unique index versus non-unique: supersede one committed row by primary
   key and Postgres arbitrates; supersede a predicate over a non-unique index and it does not. A
   later task writing a supersede-then-insert must ask which shape it is, and measure.
8. **`SESSION_STATUSES` is a restatement with a parity spec** (`session.service.spec.ts`, against
   `datamodelEnums()`), the discipline carry-forward ruling 13 requires. Adding a value to
   `enum SessionStatus` turns it red.
