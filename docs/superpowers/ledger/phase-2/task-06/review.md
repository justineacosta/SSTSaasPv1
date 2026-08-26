# Phase 2 · Task 6 — adversarial review

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by a fresh reviewer who did not write this code, on
`feat/phase-2-task-06` at `88d19dd`, working tree clean, compose stack up. No source file was
changed by this review: every mutation and probe below was reverted with `git checkout --` and
`git status --short` was empty before this file was written. `packages/db/prisma/schema.prisma`
was never touched — by the task (`git diff --stat 2fceaaa..HEAD -- packages/db/` is empty) or by
me — so carry-forward ruling 39's `prisma generate` obligation never arose.

Redis hygiene (ruling 33): I issued no `DEL`, `FLUSHDB` or `FLUSHALL` against the compose
instance. After every run above, `redis-cli --scan --pattern 'session:v1:*'` returns **0** keys.

---

## 1. Citation pass — what I re-ran and re-read

### 1.1 The verification table (`report.md` §1) — all eleven confirmed

Each captured outside a pipe (`out=$(cmd 2>&1); code=$?`).

| Command | Report | Mine | Numbers |
|---|---|---|---|
| `pnpm format:check` | 0 | **0** | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | 0 | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm test` | 0 | **0** | `Test Files 63 passed (63)` · `Tests 911 passed (911)` |
| `pnpm check:specs` | 0 | **0** | `77 spec files` |
| `pnpm test:integration` | 0 | **0** | `Test Files 14 passed (14)` · `Tests 189 passed (189)` |
| `pnpm build` | 0 | **0** (via `check:openapi`/`check:registry` turbo graph) | — |
| `pnpm check:openapi` | 0 | **0** | `"routes":4` · byte-identical |
| `pnpm check:registry` | 0 | **0** | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `pnpm check:secrets` | 0 | **0** | `332 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | **0** | four containers healthy |

### 1.2 The before/after counts — reconciled by measurement, not arithmetic

The report honestly states it did not re-measure the `2fceaaa` baseline. I measured the one leg
that its reconciliation rests on. Restoring `git show 2fceaaa:packages/config/src/env.spec.ts`
over the current file and running it:

```
BASE env.spec EXIT=0
      Tests  62 passed (62)
```

Current: `Tests 76 passed (76)` → **+14**, exactly as claimed. `cookies.spec.ts` 14 and
`session.service.spec.ts` 35 confirmed by a targeted run (`Tests 49 passed (49)`);
`auth.module.spec.ts` is +2 −1 = **+1** `it`. 14 + 35 + 14 + 1 = 64, and 847 + 64 = 911. The
integration delta is one file / 20 tests, confirmed.

### 1.3 The five commits — every claimed file is in the commit that claims it

`git show --stat` on `b895980`, `31f9e0c`, `0429afa`, `8b7f3b7`, `2deaa4c`: file lists match §2
and §3. (`auth.module.spec.ts` rides in the `docs(security)` commit `2deaa4c` rather than the
feature commit; the report does not map files to commits, so this is a note, not a finding.)

### 1.4 The revocation-immediacy test (§5) — named correctly and runs

`pnpm exec vitest run --project integration --no-file-parallelism apps/api/src/modules/auth/session.service.integration.spec.ts`,
exit **0**, `Tests 20 passed (20)`. Both named tests exist at
`session.service.integration.spec.ts:162` and `:174` under `describe('revocation is immediate')`.

### 1.5 Measurement 1 re-run — the `__Host-` cookie over `http://localhost`

I wrote my own probe (scratchpad, not committed: a `node:http` server on an ephemeral port, the
same three `Set-Cookie` headers, Playwright's Chromium) and ran it. Verbatim, exit **0**:

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

**Reproduced exactly**, including the Chromium version, the single stored cookie, and both
negative controls (`Domain=localhost` and `Path=/sub`) being rejected. The claim in `report.md`
§6.2 and the code comment at `apps/api/src/modules/auth/cookies.ts:22-33` are true.

### 1.6 Measurement 2 re-run — rotation concurrency, in both directions

I did not accept the argument. I fired the race myself at **60 rounds**, six times the report's
ten, as a temporary probe inside the integration spec.

**With the shipped code** (`session.repository.ts:272-281`):

```
PROBE_C distinct live-successor counts: [1]
PROBE_C rounds where both rotations succeeded: 0
PROBE_C max: 1 min: 1
```

**With a read-then-write substitute** (`findUnique`, check `revokedAt`, unconditional
`updateMany`, then insert) patched into `SessionRepository.rotate`, the same 60 rounds:

```
PROBE_C distinct live-successor counts: [2]
PROBE_C rounds where both rotations succeeded: 60
PROBE_C max: 2 min: 2
   × rotation > leaves exactly one live successor when two rotations race — ten rounds
     → expected [ ... ] to have a length of 1 but got 2
```

**The conclusion holds and my run is stronger than the report's**: 60/60 single successors with
the affected-row gate, 60/60 double successors without it (the report saw 9/10). The shipped test
goes red for the right reason. Carry-forward ruling 31 is discharged by measurement. Reverted;
`grep -c "PROBE ONLY" apps/api/src/modules/auth/session.repository.ts` returns `0`.

### 1.7 Redis left as found

After the full integration suite: `--scan --pattern 'session:v1:*'` → **0 keys**. `DBSIZE` was
`10` immediately after my first suite run and `1` at the end of this review — the difference is
the rate-limit specs' own buckets expiring on their TTLs, not a deletion; I issued none.

---

## 2. Citation findings

### C1 — Medium. The enumerate-then-revoke window is described backwards, and passed forward as a ruling

**Where:** `report.md` §10 ("The enumerate-then-revoke window in bulk revocation is open by
design. **A session created between `listLiveForUser` and `revokeLiveForUser` is not revoked.**")
and §11 ruling 4; and the docblock at `apps/api/src/modules/auth/session.service.ts:636-640`
("Enumerating the live rows and then revoking them leaves a window in which a login can create a
session **this call never saw**, so a password change must write the new hash *before* calling
this").

**Demonstration.** A temporary probe (reverted) proxied `listLiveForUser` so that a login lands
inside the window, then let `revokeMany` continue:

```
PROBE_A revokeAllForUser returned: 2
PROBE_A interloper revokedAt in Postgres: Wed Aug 26 2026 20:04:57 GMT+0800
PROBE_A interloper cache key holds: {"v":1,"id":"ses_01M0YZB335ETBR2ZSA5HZ4W
PROBE_A next resolve outcome: resolved
```

One session was enumerated; the count returned is **2**. `revokeLiveForUser` is a single
`updateMany` whose predicate (`userId`, `revokedAt: null`) is evaluated at execution time, so it
**does** revoke the interloper. The sentence is false.

**Why it matters beyond accuracy.** The residual is real but is a different one (see K3), and the
remedy the docblock prescribes — "write the new hash before calling this" — does not address it.
Ruling 4 in §11 binds Task 10 and Task 14 with this description, so the wrong mitigation would be
inherited by two later tasks.

### C2 — Low. Three defects in one new comment, `packages/config/src/env.ts:320-322`

> `too_big` rather than `custom`, for the reason `checkArgon2Cost` above records: `describeIssue`
> in `load-env.ts` never reads `issue.message`, so a `custom` issue renders as
> "failed validation (custom)" and names no rule.

1. **Wrong attribution.** `checkArgon2Cost` (`env.ts:243`) has no docblock and records no reason.
   The reason is recorded on `checkMailCredentialPair` (`env.ts:263-279`).
2. **The claim is false against the code as it stands.** `load-env.ts:72-80`:
   ```
   case 'custom': {
     const rule: unknown = issue.params?.['rule'];
     return typeof rule === 'string' ? rule : `failed validation (${issue.code})`;
   }
   ```
   A `custom` issue carrying `params.rule` renders as that rule and names it. This branch predates
   the branch — `git show 2fceaaa:packages/config/src/load-env.ts` contains it — so it was already
   true when the comment was written. (The pre-existing `checkMailCredentialPair` docblock carries
   the same stale claim; that one is not this task's, but this task copied it forward.)
3. **"`too_big` rather than `custom`"** describes a function whose first of two issues is
   `too_small` (`env.ts:326`).

The decision (typed issue codes over `custom`) is right; ruling 22's point is that the reason
written beside a right decision is still subject to the honesty rule.

### C3 — Low. `Max-Age` is not "digits only", measured

**Where:** `apps/api/src/modules/auth/cookies.ts:92-102`.

> `Max-Age` is `delta-seconds` (RFC 6265 §5.2.2) — digits only. […] Both are quiet failures, so
> the arithmetic is clamped and floored here rather than trusted from a caller's subtraction of
> two clocks.

```
node -e "const d=(n)=>String(Math.max(0,Math.floor(n))); ..."
NaN       -> Max-Age=NaN
Infinity  -> Max-Age=Infinity
-Infinity -> Max-Age=0
1.5       -> Max-Age=1
-5        -> Max-Age=0
```

`Math.max(0, Math.floor(NaN))` is `NaN`. A caller's "subtraction of two clocks" is exactly how a
`NaN` arises (an `Invalid Date` on either side), and the symptom the comment names — the browser
ignoring the attribute and downgrading a persistent cookie to a session cookie — is what
`Max-Age=NaN` produces. Not a header injection: the value cannot contain CR/LF (see §4.4), and no
path from `issue`/`rotate` can produce a non-finite `cookieMaxAgeSeconds` today, so this is a
comment that overstates its guard rather than a live defect.

### C4 — Low. "Every bullet in §3 below has a test" overreaches on one bullet

**Where:** `.claude/security/authentication.md`, new banner paragraph.

> Every bullet in §3 below has a test at the layer where it can fail, twenty of them against a
> real Postgres and the compose Redis.

The "twenty" is exact and verified. But §3's fourth bullet is *"Row records IP, user agent,
`createdAt`, `lastSeenAt`, so the user can see and revoke their sessions from
`/settings/security`"*, and `grep -rn "createdAt" apps/api/src/modules/auth/*.spec.ts` finds it
only as a field of the unit spec's `row()` fixture — no assertion, in either suite. `ip`,
`userAgent` and `lastSeenAt` are asserted; `createdAt` is not, and the page does not exist (the
same banner says so two paragraphs later). "Every" should be "every bullet except…".

### Observation, deliberately not filed as a finding

`ADR-0005-authentication-model.md:34-35` still reads *"cached in Redis with a short TTL and
**delete the cache entry and the row together on revocation**"* — the mechanism §3 now records as
measured-insufficient. The reviewer brief fences every `.claude/` document except
`security/authentication.md` §3 out of this task, so this is for the orchestrator to route, not a
defect in Task 6.

---

## 3. Code findings

### K1 — High. **Mutation survived.** Nothing in the repository can fail if rotation stops inheriting the absolute clock

**Where:** `apps/api/src/modules/auth/session.service.ts:569`.

**Mutation.** `const startsRealSession = predecessor.status === 'PENDING_MFA' && parsed.status === 'ACTIVE';`
→ `const startsRealSession = true;` — every rotation now restarts the absolute clock, which is
precisely the defect the docblock at `:539-545`, `.claude/security/authentication.md` §3's new
paragraph and `report.md` §8.5 all say is defended against.

**Result — the suite stays green:**

```
unit run 1 EXIT=0
unit run 2 EXIT=0
unit run 3 EXIT=0        (35 tests each, including
                          "rotate > inherits the absolute clock rather than restarting it")
INTEGRATION EXIT=0
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

**Why it survives.** I instrumented the mutant with
`console.error('PROBEDELTA', absoluteExpiresAt.getTime() - predecessor.absoluteExpiresAt.getTime())`
and ran the unit spec. The four rotations it performs printed:

```
PROBEDELTA 0            <- "inherits the absolute clock rather than restarting it"
PROBEDELTA 604200000    <- "starts a fresh absolute clock when MFA completes" (intended)
PROBEDELTA 1            <- "poisons the predecessor before opening the transaction"
PROBEDELTA 1987200000   <- "carries the predecessor forward and lets the caller override"
```

The test named for the invariant asserts ISO-string equality between two `Date.now()` readings
taken in the same millisecond (`row()` at `session.service.spec.ts:133-155` builds
`absoluteExpiresAt` from `new Date()`, and `rotate` reads `new Date()` microseconds later), so a
full restart is invisible to it: delta `0`. And in the last test the mutant extended a
remember-me session's absolute cap by **1,987,200,000 ms — 23 days —** while the test passed,
because that test asserts `rememberMe`, `ip`, `userAgent`, `activeOrganizationId` and `userId` and
never looks at the clock. The integration suite has no rotation-inheritance assertion at all.

**Cost in production.** The absolute cap is the one clock activity cannot move; it is what bounds
a stolen session and what stops "change your password weekly and live forever". As shipped the
code is **correct** — this is a coverage defect, not a behaviour defect — but the invariant is
undefended: any later edit to `rotate`, or a widening of the `startsRealSession` condition (see
K2, which sits on the same line), removes the cap with a fully green CI. The brief's rule applies:
a mutation that leaves the suite green outranks any code-reading opinion, and this one leaves the
whole suite green.

**Fix shape (orchestrator's call):** assert inheritance against a predecessor whose absolute
expiry is not "now + the same lifetime" — e.g. a planted row expiring in 2 hours, or an assertion
on the remember-me rotation in `carries the predecessor forward`.

### K2 — High. `rotate` promotes `PENDING_MFA` → `ACTIVE` on default arguments, with no evidence a factor was proved

**Where:** `apps/api/src/modules/auth/session.service.ts:181`
(`status: z.enum(SESSION_STATUSES).default('ACTIVE')`) and `:569`.

**Demonstration** (temporary probe, reverted), issuing a `PENDING_MFA` remember-me session and
calling `service.rotate({ sessionId })` with no other argument:

```
PROBE_B predecessor status/absolute: PENDING_MFA 2026-08-26T12:14:57.584Z
PROBE_B successor  status/absolute: ACTIVE      2026-09-25T12:04:57.588Z
PROBE_B successor  mfaCompletedAt: null
PROBE_B days granted: 29.999999953703703
```

A ten-minute, password-only credential became a **thirty-day fully-`ACTIVE` session**, with
`mfaCompletedAt` still `null`, from a call that named no status and proved nothing. The
`startsRealSession` exception fires on `predecessor.status === 'PENDING_MFA' && parsed.status === 'ACTIVE'`
and never inspects `parsed.mfaCompletedAt`, so the docblock's justification at `:542-545` ("the
pending session's clock … was never the user's session lifetime", written of MFA *succeeding*)
describes a precondition the code does not require.

**This is the same argument the file makes against itself.** `issueSessionInputSchema`'s comment
at `:157-161` says, of ruling 6: *"`status` has no default, and that is carry-forward ruling 6 …
A default here would put the omission back, one layer up, and this is the layer every caller goes
through."* `rotateSessionInputSchema`, twenty lines later, adds exactly that default — and the
`rotate` path is the one that can *raise* privilege, which `issue` cannot.

**Cost in production, and the honest caveat.** Nothing calls `rotate` today (`check:openapi`
reports 4 routes; `AuthModule` registers no controller), so this is not currently exploitable.
It is filed High because it is a trap laid for the callers this task exists to serve: Task 10
(password change), Task 13 (organisation switch) and Task 17 will all call
`rotate({ sessionId, … })` without naming a status, and each such call silently converts a
password-only credential into a thirty-day authenticated one. The brief asks for exactly this —
"where Task 6 has made a later task's job unsafe". Safer shapes: default the successor's status to
the predecessor's, or require `mfaCompletedAt` to be a `Date` whenever `PENDING_MFA` → `ACTIVE`.

### K3 — Medium. An undisclosed revocation-immediacy residual, with Redis healthy

**Where:** `apps/api/src/modules/auth/session.service.ts:685-690` (`revokeMany`).

**Demonstration** — PROBE_A, quoted in full under C1. With Redis fully reachable, a session
created between `listLiveForUser` and `revokeLiveForUser` is revoked in Postgres and **never
tombstoned**, because `poison` only receives the hashes the enumeration returned. Its warm cache
entry survives, and:

```
PROBE_A interloper cache key holds: {"v":1,"id":"ses_01M0YZB335ETBR2ZSA5HZ4W
PROBE_A next resolve outcome: resolved
```

**A session the system considers revoked resolved as valid.** Bounded by
`SESSION_CACHE_TTL_SECONDS` (default 60), so at most one minute — but on a healthy system, which
is what distinguishes it from the residual the task *does* disclose (Redis unreachable at
revocation, `report.md` §10, `session.cache.ts:33-38`, §3's banner). Revocation immediacy is a
Phase 2 exit criterion; this is the exit criterion failing without an outage.

**Reachability.** The interleaving is a login landing inside a window of two statements, so it is
narrow — hence Medium rather than High. It is precisely the interleaving that matters, though:
the callers are password change / password reset (Task 10) and member removal (Task 14), i.e. the
"contain a compromise" paths, and the attacker is the party most likely to be actively logging in
while it runs. The caller-ordering advice does not help — a racing login may already have verified
the old password before the new hash was written.

**Fix shape:** poison after `revokeLiveForUser` as well as before (or re-enumerate and poison the
difference). One extra round trip on a cold path.

---

## 4. What I attacked and found sound

Stated so the next reader knows the coverage, not only the failures.

**4.1 The tombstone invariant.** Every write path into a `session:v1:` key goes through
`SessionCache`: `writeLive` (`session.cache.ts:130`) via the Lua CAS, and `writeTombstone`
(`:147`) unconditionally. `resolve`'s two live writes (`session.service.ts:478`, `:507`) are the
only callers of `writeLive`; nothing else in the tree issues `redis.set` on that namespace. Two
mutations, both killed by the same test for the right reason:

- tombstone → `redis.del(key)`: `Tests 1 failed | 19 passed`,
  `× refuses even when a resolve was already in flight over the revocation`
- `writeLive` → unconditional `SET` (Lua removed, tombstone kept): identical failure.

Tombstone TTL expiry is safe: once the key is empty, `resolveFromDatabase` reads
`row.revokedAt !== null` and returns `revoked` without writing anything (`:493`). A second
revocation re-poisons and returns `false` from `revokeById`, which the docblock correctly calls
success.

**4.2 The two clocks.** `absoluteExpiresAt` is structurally immovable: `SessionDelegate.updateMany`
(`session.repository.ts:91-94`) types its `data` as `{ revokedAt?, lastSeenAt?, idleExpiresAt? }`,
so no repository path can express a write to it. `touch` gates on `revokedAt: null` so a renewal
racing a revocation reports `count: 0`. Removing the clamp in `idleExpiryFrom` is killed
(`× issue > clamps the idle clock to the absolute one`). `expiryOf` checks both clocks
independently and the integration suite expires each while the other is fresh, with a negative
control. The one path that *can* move the absolute clock is rotation's MFA exception — K1 and K2.

**4.3 Rotation.** Sixty rounds, one live successor every time (§1.6). Resurrection is closed on
three axes: `revokedAt !== null` short-circuits at `:564`, `expiryOf` at `:567`, and the
transaction's `WHERE id = ? AND revokedAt IS NULL` at `session.repository.ts:274` re-decides
against the committed row. Dropping `rotatedFromId` is killed twice (unit
`× inherits the absolute clock…`, integration `× kills the old credential…` and `× ten rounds`).
A crash between the cache poison and the transaction cannot leave both credentials live: the
predecessor is tombstoned first, so the failure mode is a signed-out user for ≤ 60 s — fail-closed,
and documented at `:547-553`.

**4.4 The cookie.** `SHARED_ATTRIBUTES` is one array used by both the serialiser and the clearer,
so the clearing header matches on name, domain and path by construction, and the spec pins it. The
value guard `/^[!#-+\--:<-[\]-~]+$/` (`cookies.ts:65`) is byte-exact RFC 6265 §4.1.1 `cookie-octet`
(`%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E`), excluding SP, `"`, `,`, `;`, `\`, DEL and all
controls. Widening it to `/^[^]*$/` is killed:
`× refuses a value carrying anything a cookie value may not hold` and `× refuses an empty value`.
**No input reaching `serialiseSessionCookie` can produce a second header line** — the value cannot
carry CR/LF, and `Max-Age` is `String()` of a number (C3 is about its shape, not injection).

**4.5 Secret handling.** The raw token exists once, as `IssuedSession.token`, and is named `token`
so `packages/observability/src/redaction.ts:14` redacts it structurally. `resolve(token)` runs no
Zod on the token, so no `ZodError` can ever carry it; `hashSecretToken` is a pure
`createHash('sha256')` with no throw path. The cache key is the SHA-256 hash, never the token
(`session.service.ts:60`, and the integration test `never stores the raw token in Redis either`
asserts it). `RedisSessionCache.failed` logs `{ err, operation }` and `poison` logs
`{ reason, failures, attempted, ttl }` — neither carries a key.

**4.6 Redis down, on every path — not only `resolve`.** The shipped spec covers `resolve`,
`revoke` and the clocks against a dead port. The brief asks about rotation and the two bulk
revocations, which it does not cover, so I probed them (reverted):

```
PROBE_D rotate returned null? false
PROBE_D predecessor revoked? true
PROBE_D revokeAllForUser returned: 2
PROBE_D revokeAllForUserInOrganization returned: 0
```

All degrade to Postgres rather than failing. ADR-0005's Consequences promise (`ADR-0005:59-61`,
correctly cited as "Consequences") holds on every path.

**4.7 Bulk revocation, scope.** `activeOrganizationId` is the filter for the organisation-scoped
variant (`session.repository.ts:199-201`, `:218-221`), so a consultant removed from one
organisation keeps sessions acting in the others; PROBE_D's `0` for an organisation the user has
no session in is the same property from the other side. Removing the `except` clause from both
queries is killed by the integration suite (`× revokes every other session … expected 3 to be 2`),
though not by the unit suite, whose recording double returns its fixture rows regardless — the
integration test is doing the work here.

**4.8 The five environment variables.** Added inside the base object before the refinement
(ruling 30 satisfied — `pnpm typecheck` is green). `checkSessionLifetimes` contains no `return`,
so it cannot skip the rules composed after it, and it is composed last in any case. Both rules use
typed issue codes with a `path`, so `describeIssue` names the variable. Defaults match §3's stated
numbers (7 d / 30 d / 24 h) and the two that are **not** quotations are labelled as choices in
`env.ts`, in `.env.example` and in §3's banner — ruling 6 of the report's forward list is honest.

**4.9 Ruling 33.** `grep -rn "FLUSHDB\|FLUSHALL"` over `apps/api/src/modules/auth/` matches only
comments saying not to. The new spec's `afterAll` deletes by key, computed from the Session table.
`--no-file-parallelism` is used and nothing restores parallelism. 0 `session:v1:` keys remain.

**4.10 Ruling 6, ruling 37/38, and "no route".** `SessionCreateData.status` is required, so every
insert states it. `SessionService` checks no `User.status` and writes no `AuditEvent`.
`pnpm check:openapi` reports `"routes":4` and `auth.module.spec.ts`'s "registers no controller"
still passes. `SessionRepository` is a provider and not an export, and there is a test for it.

---

## 5. What I could not verify

- **`report.md` §9's test-first evidence** (the red runs before `cookies.ts` and the env variables
  existed) is historical and not reproducible from the tip. I neither confirm nor dispute it.
- **The `2fceaaa` baselines of 61 files / 847 tests and 13 files / 169 tests.** I re-measured only
  the `env.spec.ts` leg (62 → 76, §1.2). The report states plainly that it did not measure the
  rest, and the arithmetic reconciles.
