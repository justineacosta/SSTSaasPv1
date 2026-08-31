# Task 9 review — the adversarial pass

> **A dated record of what was measured and found at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a fresh reviewer on 2026-08-31, on `feat/phase-2-task-09` at `7d52b8d`, code range
`6f5aac0..95650a3`, cut from `main` at `00ac4ab`. I did not write this code.

Everything below was run on this tree. Exit codes were captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`). Every mutation was applied, run, and reverted;
`git diff HEAD` is empty and `pnpm test` (1252) and `pnpm typecheck` are green as I write this.

**Counts: 2 High, 3 Medium, 7 Low.** Four of the twelve are false sentences rather than code.

---

## 1. The citation pass

### 1.1 The evidence table reproduces exactly

Eleven commands, re-run on this tree. Every row matches the implementer's report to the digit.

| Command | Exit | Reproduced |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **81 files, 1252 tests** |
| `pnpm check:specs` | 0 | `99 spec files … No banned .test.* spellings.` |
| `pnpm test:integration` | 0 | **18 files, 275 tests** |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 10`; byte-identical |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `383 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | four services `Up (healthy)` |

Also confirmed independently: `apps/api/openapi.json` publishes the three new paths (ten paths
total); `git diff --name-status main..HEAD` contains no `apps/web` path and no file under
`packages/db/prisma/migrations/`, so the missing `test:e2e` row and "Task 9 opened no migration"
are both correct.

### 1.2 Ruling citations in the code

I opened `progress.md` for every ruling number the diff cites — 6, 7, 18, 21, 24, 25, 33, 37, 44,
45, 49, 52, 55, 56, 57, 58, 61, 62, 63, 64, 70 — and each ruling says what the citing comment
claims it says, with one exception recorded at **L4** below (ruling 37, in the report rather than
in the code).

### 1.3 The four corrections the implementer makes to the orchestrator's brief

- **§5.1 — "wire it in `app-setup.ts` where the other guards are" is false.** *Upheld.*
  `grep -n "[Gg]uard" apps/api/src/app-setup.ts` returns two comment lines and no registration;
  all four guards are `APP_GUARD` providers in `app.module.ts`, and `app.module.spec.ts`'s order
  assertion moved from three to four.
- **§5.2 — D8's lookup cannot work as written.** *The RLS half is upheld and the test half is not.*
  `Organization` does carry `FORCE ROW LEVEL SECURITY` keyed on `id`
  (`20260820121229_row_level_security`, `20260820132520_tenant_root_and_audit_restrict`), and the
  integration lane's own assertion at `auth.login.integration.spec.ts:805` reproduces both halves
  of the measurement. But the claim that this closes ruling 58 for the lookup is false — see **M1**,
  where I removed `withTenantTransaction` and the whole suite stayed green.
- **§5.3 — §4's byte comparison is incomplete for an error response.** *Upheld.*
  `errorEnvelopeSchema` carries `requestId` (visible in my own probe output below), it is minted
  per request, and it is already excluded from the header comparison as `x-request-id`.
- **§5.4 — D6's stated reason (ruling 70) does not reach `newDeviceSignIn`.** *Upheld as written.*
  Ruling 70's rule is about an address whose ownership has not been proven, and
  `login.service.ts:396` sends this notice only when `emailVerifiedAt !== null`. The correction is
  right. But the *conclusion drawn from it* — that removing `recipientName` removes "the whole
  attack surface" — is wrong, because the template still renders the `User-Agent`. See **H2**.

### 1.4 What I checked and found sound

Recorded so a later reader does not re-run it: the `PENDING_MFA` token is genuinely unreachable
(measured, §3.4); the login timing paths are indistinguishable at current parameters (measured,
§3.3); `PlatformAuditEvent` has **no** RLS policy, so the failed-login insert is not a hidden
production failure the owner-role harness is masking; the per-account rate-limit identifier really
is SHA-256'd before it becomes a Redis key (`rate-limit.guard.ts:111`), as
`abuse-prevention.md` §1 now claims; and the two measurement sentences added to
`abuse-prevention.md` §1 (`401,401,401,401,401,429`; refused at the twenty-first attempt) are
exactly what `auth.login.integration.spec.ts:434` and `:464` assert.

Twelve of the thirteen mutations I applied turned a test red. The unit suite around `LoginService`
is genuinely strong; §3.2 lists them.

---

## 2. Defects in the code

### H1 — The lockout ladder does not count concurrent attempts, so it never engages

`login.service.ts:247-258`. `recordFailure` computes `consecutiveFailures = user.failedLoginCount + 1`
from a row read at line 156 — **before** a ~40 ms Argon2id verification — and writes it as an
absolute value inside the transaction. There is no `{ increment: 1 }`, no `SELECT … FOR UPDATE`,
and no unique-key retry. `IdentityUserUpdateData`'s union (`identity.store.ts:59-73`) is what makes
an atomic increment unexpressible today; its docblock argues that a partial "would make
'increment the counter' a valid call", which is the opposite of what the column needs.

**Measured, through the real application** (temporary integration spec, since removed; five
`POST /api/v1/auth/login` in one `Promise.all`, rate-limit windows cleared first):

```
PROBE statuses 401,401,401,401,401
PROBE failedLoginCount 1  lockedUntil null  LOGIN_FAILED rows 5
PROBE correct-password status after 5 concurrent failures = 200

PROBE2 concurrent-5      count 1  lockedUntil null  ACCOUNT_LOCKED rows 0  emails sent
PROBE2 sequential-4-more count 5  lockedUntil 2026-08-31T13:18:15.326Z    emails failedLoginBurst
```

Five concurrent wrong passwords leave the counter at **1**, the account unlocked, **zero**
`ACCOUNT_LOCKED` rows and **zero** burst notices. The sequential control on the same account
immediately afterwards behaves exactly as D2 specifies, which is why the existing tests pass: every
lockout test in both lanes is sequential.

**What it costs.** The per-account lock is `security/authentication.md` §7's brute-force control and
the trigger for §7's burst notice. Firing attempts in parallel instead of in series defeats both:
an attacker keeps the limiter's full budget (5 per 15 minutes per account) indefinitely, the ladder
never climbs past rung zero, and **the account owner is never notified that anybody is guessing.**
The audit trail is degraded with it — all five `LOGIN_FAILED` rows carry
`metadata.consecutiveFailures: 1`, so an investigator reading the table sees five isolated typos
rather than a burst.

The lockout ladder is not the only bound (the limiter still caps throughput at 5/15 min), which is
why this is High and not release-blocking-critical. But §7's stated control is inoperative, and
`.claude/security/authentication.md` §7's new "The ladder, as built" table is a false description of
the endpoint under the one access pattern an attacker would actually choose.

### H2 — `newDeviceSignIn` got its first shipped caller, and it renders 512 characters of attacker-chosen text to the victim

Ruling 63's rule is: *a message this product sends to one person must never render text a different
person chose.* `whereAndWhen` interpolates the signing-in party's `User-Agent` as `Device: <value>`,
bounded at 512 characters by `request-context.ts:35`. Until this branch, `newDeviceSignIn` had no
caller. `login.service.ts:402` is now that caller.

Rendered from the built module on this tree:

```
Your Sentinel account was signed in to from a device we have not seen before.
When: 2026-08-26 09:41 UTC
IP address: 203.0.113.9
Device: Mozilla/5.0 -- SECURITY ALERT: confirm your account now at
        https://sentinel-verify.evil.example/login or it will be deleted
--
If this was not you, sign in to Sentinel the way you normally do and change your password
immediately, then contact your organisation owner.
Sentinel will never ask you for your password or a code by email or phone, and never
includes a link in a security notice like this one.
```

`has https in html: true` / `has https in text: true`. The footer's promise is false in the same
message that breaks it.

**Why this is a finding and not merely an inherited residual.** `registry.spec.ts`'s
characterisation test explicitly accepts the residual on four templates, and its stated grounds are:
*"Lower severity than H1 and not zero: reaching these requires the account's own credentials, and
**none of the four has a caller yet (Tasks 9 and 11 add them)**."* Task 9 is the task that made that
sentence false. It shipped the caller, edited that file in the same commit, and left the sentence —
and the risk acceptance that rests on it — untouched. Nobody re-decided.

Three further things make this worse than an ordinary inherited residual:

1. **The recipient and the chooser are different people in exactly the case the notice exists for.**
   The message fires on an *unfamiliar* sign-in. If it is a real takeover, the `Device:` line is the
   attacker's sentence, sent to the victim, over Sentinel's branding, telling them to act.
2. **It is repeatable.** Familiarity is exact-match on `(userId, ip, userAgent)`, so varying the
   user agent produces a fresh notice every time — up to the limiter's 5 per 15 minutes.
3. **Ruling 70's prescribed test was not applied to it.** The ruling says the test to write is
   "no link when EVERY caller-supplied field is a URL". That test exists, over
   `CONTEXT_FREE_NOTICE_IDS` — and `newDeviceSignIn` is in the *other* list. The new Task 9 test
   (`name-free template %s`) passes `BENIGN` values for `ipAddress` and `userAgent` and only
   hostile text for the name, so it goes green over exactly this.

`login.service.ts:397` states *"the template carries no display name so there is nothing to
inject"*, and report §2.6 states *"`newDeviceSignIn` is a branded notice about somebody's own
session"*. Both are false on the takeover path. This is the third channel the review brief said to
assume was there.

**Cost if left:** a stolen password becomes a Sentinel-branded phishing channel aimed at the victim,
triggered on demand, and the one message that was supposed to warn them is the one carrying the lure.

### M1 — The organisation lookup's "NOT OPTIONAL" tenant transaction is protected by nothing

`active-organization.store.ts:30` opens *"THE LOOKUP RUNS INSIDE A TENANT TRANSACTION, AND THAT IS
NOT OPTIONAL. MEASURED, NOT REASONED."* Report §2.8 and §5.2 make it the task's centrepiece
decision. I replaced `withTenantTransaction(base, organizationId, tx => tx.organization.findUnique(…))`
with a direct `base.organization.findUnique(…)` — the exact code the docblock says would "return
`null` in production for every session that had an organisation" — and ran both lanes:

```
MUT-B FULL-INTEGRATION EXIT=0   Test Files 18 passed   Tests 275 passed
MUT-B UNIT               EXIT=0   Test Files 81 passed   Tests 1252 passed
```

**Nothing turned red.** The reason is in `auth-harness.ts:101`:
`.overrideProvider(PRISMA).useValue(prisma)` where `prisma = createUnscopedPrismaClient(postgres.ownerUrl)`.
The entire application under integration test connects as the container superuser and bypasses RLS.
`appPrisma` was added — but it is used only in `auth.login.integration.spec.ts:805`, which drives
the raw client and never touches `activeOrganizationLookup`. That test proves that Postgres enforces
RLS; it proves nothing about the lookup. The test above it drives the lookup, over the owner role,
where RLS cannot bite.

This is carry-forward ruling 58 in its own words — *a spec whose fixtures all sit on one side of
the branch under test* — in the file that spends sixty lines explaining ruling 58. The shipped code
is correct; the protection claimed for it does not exist.

**Cost if left:** the day somebody simplifies "an unnecessary transaction" out of this function, the
whole gate stays green and Task 13 inherits a lookup that answers `null` in production and looks
exactly like "no organisation chosen".

### M2 — A denial on a DISABLED or administratively LOCKED account writes no audit event at all

`login.service.ts:199`: `if (user.status !== ACTIVE_USER_STATUS) throw new AccountLockedError();`
— thrown after a **correct** password, with no `$transaction`, no `PlatformAuditService.record`,
and no counter change.

Measured:

```
PROBE2 disabled correct-pw status 403  rows before 1  rows after 1  USER_REGISTERED
```

A correct password presented to a disabled account produces a 403 and **zero** new
`PlatformAuditEvent` rows. `security/audit.md` §3 requires failures and denials to be audited, and
this is the single most investigation-relevant denial the endpoint can produce: somebody is holding
a valid credential for an account an operator deliberately switched off.

The report's §2.1 argument for writing nothing on a live lock — *"an unauthenticated caller must not
be able to grow an append-only table one row per request"* — does not reach this path, because
reaching it requires the correct password, and the `ACCOUNT_LOCKED` row that "already records that
the lock happened" does not exist for an administrative status. Neither the report, nor
`api/authentication.md` §6, nor `security/audit.md` §4 records the gap; `api/authentication.md` §6
says only that both kinds of lock "answer with it", which is about the response and not the trail.

**Cost if left:** a compromised credential for a de-provisioned account can be exercised repeatedly
and leaves no trace in the table built for exactly that question.

### M3 — The burst notice is sent inside the request, and the report does not name it

`login.service.ts:308`: `await this.mailer.sendFailedLoginBurst(...)` runs after the transaction
commits but **before** the handler returns, awaited. `AuthMailer.deliver` swallows the error, so the
status code is unaffected — but the wall clock is not.

That is carry-forward ruling 68's exact shape, reproduced on a new endpoint: the response to the
fifth wrong password against a **real** address pays a full SMTP round trip that the fifth wrong
password against an **unknown** address does not. Five requests within the per-account budget is all
it takes to distinguish them.

Report §4.3 says *"No login timing was measured"* and names one residual — the skipped `Credential`
read. That residual turns out to be immeasurable (§3.3 below). This one is structural, larger by
orders of magnitude, and is named nowhere: not in the report, not in
`security/authentication.md` §2's new "Two residuals, both measured and both open", not in §7's
burst-notice section. The recording mailer in the harness makes it invisible to every test.

I did not measure it against a real relay, because the integration harness substitutes the mailer;
the finding is structural and is stated as such.

**Cost if left:** an enumeration oracle on a route whose entire byte-comparison apparatus exists to
deny one, plus an unauthenticated caller who can hold API connections open across third-party
network I/O.

---

## 3. Measurements

### 3.1 Concurrency (H1) — see above.

### 3.2 Mutation results

Thirteen mutations, each applied to the finished code, run, and reverted (`git status` clean after
each; final `git diff HEAD` empty).

| # | Mutation | Suite | Result |
|---|---|---|---|
| A | `CrossSiteGuard` reads `getAllAndOverride([handler, class])` | unit, guard spec | **RED** (ruling 61's control holds) |
| B | `activeOrganizationLookup` drops `withTenantTransaction` | **unit + integration, all** | **GREEN — survived** → M1 |
| C | New-device notice ignores `emailVerifiedAt` | unit | RED |
| D | No-account audit row carries the attempted address | unit | RED |
| E | `lastLoginAt` stamped on the MFA arm too | unit | RED |
| F | Familiarity lookup ignores the user agent | unit | RED |
| G | Ladder never locks | unit | RED |
| H | Logout audits the `User`, not the `Session` | unit | RED |
| I | Raw session token used as the CSRF cookie value | unit (controller) | GREEN — **but RED in the integration lane** |
| J | `credentialUnreadable` never reported | unit | RED |
| K | Absent account short-circuits before Argon2 | unit | RED |
| L | Lock never consulted | unit | RED |
| M | Failure audit names the account owner as actor | unit | RED |
| N | `ACCOUNT_LOCKED` audit row never written | unit | RED |
| P | Account status consulted **before** the password | unit | RED |

Mutation I is worth a sentence: `auth.controller.spec.ts` does not see the CSRF cookie's value, so
a mutation that puts the raw `HttpOnly` session token into the JS-readable `__Host-csrf` cookie
survives the unit lane. `auth.login.integration.spec.ts:147` catches it (`Tests 1 failed | 40
passed`), so the property is held — by one test, in one lane.

### 3.3 Login timing, measured (the report declined to claim it; this measures it)

25 samples per path through the real application, alternating, five warm-up requests first,
rate-limit windows cleared between each so the limiter is never in the path. Milliseconds:

| Path | n | min | p50 | max | mean |
|---|---|---|---|---|---|
| Known account, wrong password | 25 | 39.74 | 48.52 | 68.89 | **49.78** |
| Address with no account | 25 | 41.81 | 50.68 | 70.06 | **51.20** |

Fully overlapping ranges, and the absent-account path is marginally the *slower* of the two. **The
structural residual report §4.3 names is not an oracle at current Argon2 parameters** — one index
probe is lost in the noise of a verification two orders of magnitude more expensive. Contrast Task
8's resend (4.0 ms vs 8.6 ms, non-overlapping), which was a working oracle. This does not touch
carry-forward ruling 24, which is about a parameter raise and remains open and untouched, correctly.

### 3.4 The `PENDING_MFA` credential is genuinely unreachable

Seeded a confirmed `MfaFactor`, logged in, took the `pendingToken` from the body, and presented it
as `__Host-session` together with a correctly derived `__Host-csrf` cookie and `X-CSRF-Token`:

```
PROBE login mfa status 200  setCookie null  tokenLen 43
PROBE pending token -> /api/v1/auth/logout   401 {"error":{"code":"MFA_REQUIRED", …}}
PROBE pending token -> /api/v1/auth/session  401 {"error":{"code":"MFA_REQUIRED", …}}
```

`AuthenticationGuard:165` refuses on `status === 'PENDING_MFA'` unless the handler carries
`@AllowPendingMfa()`, which no shipped handler does. Report §4.1's claim holds, including on the
route it did not test.

### 3.5 Enumeration paths the byte comparison does not cover

I compared a `DISABLED` account against an unknown address on a wrong password: both 401, both
`{"error":{"code":"INVALID_CREDENTIALS","message":"Email address or password is incorrect.", …}}`.
No difference. The comparison file covers wrong-password, no-`Credential`-row and lock-live; the
uncovered cases all funnel through the same `InvalidCredentialsError` and I found no divergence in
status, code or message. `RateLimit-Limit/Remaining/Reset` **are** inside `comparableHeaders`
(only `date` and `x-request-id` are filtered) and did not diverge, because the per-account window
is the "worst" scope on both sides.

---

## 4. False sentences in prose

Separated from the code defects because they are fixed differently.

**L1 — `active-organization.store.ts:64` cites a file that does not exist.**
*"`auth.session.integration.spec.ts` therefore drives this lookup over a second client bound to the
harness's `appUrl`."* There is no `auth.session.integration.spec.ts` anywhere in the repository
(`ls apps/api/src/modules/auth/`, and `grep -rn` finds only this line and its build artefact). The
spec is `auth.login.integration.spec.ts`, and per **M1** it does not drive the lookup over
`appPrisma` either. Two false claims in one sentence, in the file whose subject is a claim that a
test would have confirmed. Carry-forward ruling 11 is the precedent.

**L2 — `cross-site.guard.ts:111` documents a line of code that is not in the file.**
The comment reads *"`typeof origin === 'string'` rather than a truthiness check"*; line 120 is
`if (origin !== undefined && origin !== this.webOrigin)`. The behaviour the comment argues for is
delivered anyway (an array is neither `undefined` nor equal to the origin, so it is refused), so
this costs a reader's trust rather than a defect — but it is a docblock quoting code that was never
written.

**L3 — `auth-harness.ts:158` keeps a deprecated export for readers that do not exist.**
*"`@deprecated` Task 8's name for the list above. **Kept so its two specs still read.**"*
`grep -rn "TASK_8_RATE_LIMIT_CLASSES" apps/api/src` returns one line: the definition. No spec
references it.

**L4 — Two citations in report §2.2 do not support what they are cited for.**
(a) *"a wrong password on a `LOCKED` account is byte-identical to a wrong password on any other
(asserted in `auth.enumeration.integration.spec.ts`)"* — that spec's third test seeds
`{ failedLoginCount: 5, lockedUntil: <future> }` and never sets `User.status`. It asserts the
*brute-force* lock, not the administrative one §2.2 is about. The behaviour is covered, in
`login.service.spec.ts:846`; the citation names the wrong lane and the wrong lock.
(b) *"Carry-forward ruling 37 requires the endpoint to check it"* — ruling 37 is about
`TokenService.consume` returning a user whose status nobody checked, and it binds **Tasks 8, 10 and
15**. It does not name Task 9 and login consumes no token. The decision to check `User.status` is
right; the reason written beside it is not the ruling's. Carry-forward ruling 22 exactly.

**L5 — `AccountLockedError` tells a permanently disabled user three false things.**
Measured: a correct password against a `DISABLED` account answers
`403 {"code":"ACCOUNT_LOCKED","message":"This account is temporarily locked. Try again later, or
reset your password."}`. For an administratively disabled account it is not temporary, trying again
later will never work, and resetting the password will not help. Report §2.2 reasons about what an
*operator* can tell from the response and does not notice that the *user* is told something false.
`api/authentication.md` §6's new "Both kinds of lock answer with it" paragraph inherits the problem.

**L6 — `auth.controller.ts:46` — "THE SIX ROUTES THIS PRODUCT PUBLISHES"** while `check:openapi`
reports ten and the same docblock says so four lines later. Six is the count on this controller.
Minor, but this file's route-count sentences have already been rewritten once this phase.

**L7 — §7's "one attacker must not lock out a whole tenant" is a bound, not a prohibition, and the
documents present it as satisfied.** Arithmetic, not a measurement: the per-IP window is 20 attempts
per 15 minutes and a lock costs 5 attempts, so one IP can trip four locks per window, and holding
accounts at the 30-minute cap indefinitely costs 5 attempts per account per 30 minutes — roughly
**eight accounts held permanently locked from a single address**, more if the ladder is allowed to
lapse between cycles. `abuse-prevention.md` §1's new paragraph and `api/authentication.md` §7 both
present the independence of the two windows as §7's property "asserted through the real
application". What the two integration tests assert is independence; neither asserts, and nothing
bounds, how many accounts one caller can hold offline. Worth a sentence in §7 rather than a fix.
(Note that H1 currently makes this moot in the attacker's *disfavour* — under concurrency no lock
engages at all.)

---

## 5. What I could not check

- **The SMTP half of M3.** The integration harness substitutes a recording in-memory mailer, so I
  could measure the structure of the send but not its wall-clock cost against a relay. The finding
  is stated structurally and is not given a number.
- **Browser behaviour of `CrossSiteGuard`.** I read and mutation-tested the guard and confirmed its
  class-level metadata cannot widen it (mutation A). I did not drive a real browser at it, so
  "every current browser sends `Origin` on a cross-site `POST`" remains the guard docblock's claim
  rather than mine. One asymmetry I noticed and did not pursue: the `sec-fetch-site` comparison has
  no duplicate-header handling of the kind the `Origin` comparison's comment reasons about
  (`'cross-site, cross-site'` would not match), but `Sec-Fetch-*` is a forbidden header name so a
  page cannot produce the duplicate, and the `Origin` arm catches the case regardless.
- **`pnpm test:e2e`.** Not run, correctly — no `apps/web` path is touched.

---

## 6. What I did not find

- No cross-tenant isolation gap. Nothing Task 9 touches is tenant-owned; `check:registry` reports
  three tenant-owned models and none appears in the diff. Report §4.2 is correct to say so rather
  than omit it.
- No secret in an audit row, a log line, or an email body. Mutations D, J and M all turn red, and
  the `LOGIN_FAILED` metadata is held to an exact key set.
- No route reachable without its declared rate-limit class or access declaration; the
  exhaustiveness test in `auth.controller.spec.ts` covers all six handlers.
- No `AuditEvent` write where ruling 62 requires a `PlatformAuditEvent`.
- No timing oracle between the two enumeration paths at current parameters (§3.3).
