# Task 9 brief — login, logout, the session endpoint, lockout

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31, at `main` = `00ac4ab`, branch `feat/phase-2-task-09`.
Task 8 was re-verified on this tree before the branch was cut: ten commands, all exit 0, at the
numbers Task 8's own evidence table records (76 files / 1120 unit tests, 17 / 230 integration,
`check:openapi` **7 routes**, `check:registry` 15 models, compose stack `Up (healthy)`).

You are the implementer for Task 9 and, in a later session, Task 10. **Read the whole brief before
writing anything.**

---

## 1. The two rules that outrank everything below

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative claiming a state. The
   orchestrator writes every sentence that asserts anything. Your report is: what you changed, the
   commands you ran, their exit codes and their output, and every fact you *measured*. Where you
   want to claim something, cite the command or the file and line that establishes it.
   *(Phase 1 shipped twelve false factual claims in prose; five of them were introduced while
   correcting an earlier one. This rule is why.)*
2. **Test-first.** A test is written, run, and seen to fail for the right reason before the code
   that satisfies it exists. When you fix a defect, re-run the exact mutation that exposed it —
   carry-forward ruling 66: a test that passes both before and after the mutation is not a test,
   and a fake's default can make it one.

---

## 2. What Task 9 ships

Four routes' worth of behaviour, on top of the seven routes that exist:

- `POST /api/v1/auth/login` — 200 `{ mfaRequired: false }` with the session cookie, or 200
  `{ mfaRequired: true, pendingToken }`.
- `POST /api/v1/auth/logout` — 204, cookies cleared, session revoked and its cache entry
  tombstoned.
- `GET /api/v1/auth/session` — the principal, the active organisation, the effective permission
  set, an entitlements placeholder.
- Account lockout, the failed-login audit trail, and the two email notices §7 requires.

`check:openapi` must report **10** routes when you are done, and the committed
`apps/api/openapi.json` must be regenerated in the same commit as the controller change
(`pnpm --filter @sentinel/api openapi:generate -- --out openapi.json`, then `pnpm check:openapi`).

**Task 9 opens no migration.** `User.failedLoginCount`, `User.lockedUntil` and `User.lastLoginAt`
already exist (`packages/db/prisma/schema.prisma`), `Session` has everything the session service
needs, and the audit action names are a TypeScript union, not a database enum. If you find yourself
reaching for `prisma migrate dev`, stop and say why in your report instead — a migration in this
task is a design change, and carry-forward ruling 65 records what an applied migration costs to
correct.

**Out of scope, and do not build it:** password reset and change (Task 10), MFA enrolment and
`mfa/verify` (Task 11), tenant resolution, the authorization guard and real permissions (Task 12),
organisations and switch-org (Task 13), anything under `apps/web` (Tasks 16–17).

---

## 3. Decisions already taken — implement these, do not relitigate them

Each of these is the orchestrator's call, made before you start, with its reason. If you find one is
*wrong on the evidence* — not merely different from what you would have chosen — say so in your
report with the measurement that shows it, and implement it anyway unless it is unsafe.

### D1. Login brings its own cross-site defence, and it is not double-submit

Carry-forward ruling 56. `CsrfGuard` skips `@Public()` routes deliberately, and login is public — a
cross-site login `POST` carries no session cookie, so a double-submit token has nothing to bind to,
and demanding one would refuse every legitimate caller with no client-side remedy.

Ship a **separate, narrow guard** covering exactly the routes that opt in (login today; Task 10's
reset endpoints and Task 11's MFA verify will opt in later). Its rule, in order:

- `Sec-Fetch-Site: cross-site` → refuse. (`CsrfGuard` already refuses on this header for
  cookie-authenticated routes; reuse the constant rather than restating the string.)
- An `Origin` header that is present and is **not** the configured web origin → refuse.
  `CorsMiddleware` already holds that single allowed origin; take it from the same configuration
  rather than deriving a second answer.
- Neither header present → allow. A non-browser client (curl, a CI script, an integration test)
  sends neither, and this control exists to stop a *browser* being driven cross-site.

Refusal is **403 `CSRF_TOKEN_INVALID`**, one code and one message for every arm, for the reason
`api/authentication.md` §3 already gives: telling a caller which half they defeated is telling them
what to fix. What this defends is login CSRF — an attacker silently signing a victim's browser into
an account the attacker controls, so that the victim's subsequent activity accrues to it.

The guard is declarative (a decorator plus metadata read from `context.getHandler()` only, never
from the class — `access.decorator.ts`'s `AllowPendingMfa` docblock records what class-level
metadata did to the last exemption in this codebase). Wire it in `app-setup.ts` where the other
guards are, and update `architecture/backend.md` §3's stage list in the same change.

### D2. The lockout ladder, and where it may not climb

`security/authentication.md` §7: "progressive delay then temporary lock per account, with
independent per-IP limits". Implement it with the two columns that exist and **no sleeping**:

| Consecutive failures after the attempt | `lockedUntil` set to |
|---|---|
| 1–4 | not set |
| 5 | now + 1 minute |
| 6 | now + 5 minutes |
| 7 | now + 15 minutes |
| 8 or more | now + 30 minutes (the cap) |

- **A real `setTimeout` delay is not the mechanism.** A login handler that sleeps is a handler an
  attacker can pin: N concurrent attempts hold N connections and N event-loop timers for as long as
  the attacker chooses. The escalating lock window *is* the progressive delay, and it costs the
  attacker time without costing us a held connection.
- **While `lockedUntil` is in the future, an attempt changes no state.** No increment, no
  extension, no new lock. Otherwise an attacker who wants an account offline keeps it there
  forever by attempting once a minute, which is §7's "one attacker must not lock out a tenant"
  reappearing one level down. The ladder still climbs across cycles, because the counter is not
  reset by a lock expiring — only by a successful login.
- **30 minutes is a cap, not a quotation.** §7 names no figure. Record it as a decision in
  `security/authentication.md` §7 in the same change, the way Task 8 recorded 30/hour in
  `abuse-prevention.md` §1 rather than pretending it was transcribed.
- The counter resets to 0 and `lockedUntil` to NULL on a successful login, in the same transaction
  as `lastLoginAt`.

### D3. `ACCOUNT_LOCKED` is returned only when the password was otherwise correct

`api/authentication.md` §6 gives a locked account **403 `ACCOUNT_LOCKED`** (not 401 — the plan
calls this out because it is easy to get wrong). But answering `ACCOUNT_LOCKED` to *any* attempt on
a locked account hands an enumeration oracle to exactly the caller who has just proved they will
make five attempts: the response would confirm the address is registered.

So: verify the password first (always, against the dummy hash when there is no account — see D4),
and only then consult the lock.

- Correct password + locked → 403 `ACCOUNT_LOCKED`. This is the real user, who needs to be told why
  their correct password is not working, and it tells an attacker nothing they did not already have.
- Wrong password + locked → 401 `INVALID_CREDENTIALS`, identical to every other failure.
- No account → 401 `INVALID_CREDENTIALS`, identical to wrong password, byte for byte.

### D4. Both paths pay for Argon2id, and a corrupted credential stops being silent

`PasswordService.verify(storedHash: string | null, password)` already runs the dummy-hash path when
the stored hash is `null` (carry-forward ruling 21) — **use it; do not branch around it.** The
absent account must not be the cheap path.

Carry-forward ruling 25 is Task 9's to close: a stored credential that cannot be parsed as a PHC
string is today indistinguishable from a wrong password, with no log line at all. A credential row
that Argon2 refuses to read is an operational fault, not a failed login: log it at `error` with the
user id and **no** hash, no password, no fragment of either, and answer the caller
`INVALID_CREDENTIALS` exactly as before. The caller learns nothing new; the operator learns that a
row is corrupt.

Carry-forward ruling 24 is **not** Task 9's to close and you must not pretend it is: timing equality
holds against the dummy at *current* Argon2 parameters and not against hashes stored before a
parameter raise (measured 4.6× in Task 3). Leave it open, and state it in your report as inherited
and untouched.

### D5. A failed login is audited, including one against an address with no account

The pause state hands Task 9 the thing Task 8 could not discharge: `audit.md` §3 says failures and
denials are audited, and Task 8's failed verification writes nothing because the refusal rolls back
the transaction the event would live in. **Login has no such excuse**, because a failed login
*does* write — the counter increment — so the event goes in the same transaction as the increment
and commits with it (`CLAUDE.md` rule 10).

Ruling 62: every event here goes in `PlatformAuditEvent`, never `AuditEvent` — a login has no
organisation, and `AuditEvent`'s RLS policy *refuses* the insert (measured twice in Task 8).

| Situation | Action | `actorType` / `actorId` | `resourceId` |
|---|---|---|---|
| Successful login | `LOGIN` | `USER` / the user | the user |
| Wrong password on an existing account | `LOGIN_FAILED` | `SYSTEM` / null | the user |
| Attempt on an address with no account | `LOGIN_FAILED` | `SYSTEM` / null | null |
| The attempt that trips the lock | `ACCOUNT_LOCKED` | `SYSTEM` / null | the user |
| Logout | `LOGOUT` | `USER` / the user | the session |

- `actorType: SYSTEM` with a null actor on every failure, following
  `registration.service.ts`'s `recordBlockedAttempt`: naming the account owner as the actor of a
  failed login would be a false statement in an append-only table, and the whole point of the row is
  that it was probably not them.
- **The attempted address is never written into the metadata of the no-account row.** The forensic
  signal that matters is "this IP failed against N unknown addresses", which `ip` + `requestId`
  already carry; the address belongs to somebody who is not a customer, and an append-only table is
  the worst place to learn that. Precedent: the rate limiter hashes the address before it becomes a
  Redis key.
- Both paths write exactly one audit row, which is also what keeps them close in cost.
- `LOGIN`, `LOGIN_FAILED` and `LOGOUT` are already in `security/audit.md` §4's taxonomy.
  **`ACCOUNT_LOCKED` is not** — add it to §4 and to `platform-audit.actions.ts` in the same change,
  exactly as Task 8 added its three. `PLATFORM_AUDIT_RESOURCE_TYPES` gains `Session` for the logout
  row.

### D6. The two notices, and what may appear in them

Rulings 63 and 70 govern this and they are the sharpest constraints in the task. **A message this
product sends to one person must never render text a different person chose, and a message to an
address whose ownership has not been proven must render no stored display name.** `User.name` is
free text an attacker seeds by registering a victim's address first.

- **`newDeviceSignIn`** (successful login from an unfamiliar IP + user agent): send it **only when
  `emailVerifiedAt !== null`**, and **remove `recipientName` from the template's context type** so
  no parameter exists for the stored name to travel through — structurally, the way `emailVerification`
  and `registrationAttempt` were closed, not by a filter. The IP and user agent stay: for a verified
  address this is the message describing the recipient's own session, which is ruling 63's licensed
  side of the partition.
- **A new template, `failedLoginBurst`** — §7's "a burst notifies the account owner", which no
  template covers today. It renders **no display name, no user agent and no IP**: a burst is not the
  recipient's session, it is somebody else's, so none of those three describe them and the user
  agent is attacker-chosen free text. `{ occurredAt, attemptCount }` and nothing else. It is a
  notice, so it goes in `NOTICE_TEMPLATE_IDS`, it carries no link, and it inherits every assertion
  in `registry.spec.ts` by existing (add its row to `CASES` — the table is
  `Record<EmailTemplateId, …>`, so omitting it is a compile error).
- Send the burst notice **once per lock**, on the attempt that trips the lock, not on every failure
  past the threshold — otherwise the notice is itself an outbound-email amplifier aimed at the
  victim, and the fifth message tells them nothing the first did not.
- **"Unfamiliar" is your decision to make and to write down.** Define it narrowly and honestly with
  what the `Session` table can answer (the user's previous sessions' `ip` / `userAgent`), and say in
  your report exactly what query you used and what it costs. Do not invent a device-fingerprinting
  scheme.
- Every send happens **after** the transaction commits and a failed send never changes the response
  (carry-forward rulings 44 and 45, `AuthMailer`'s docblock). `AuthMailer` is where these two
  methods go, and it takes no transaction handle so that putting one inside a transaction is
  awkward to write rather than easy to do by accident.

### D7. Logout revokes; it does not delete — and the document is what changes

The plan and `api/authentication.md` §2 both say "session row deleted". `SessionService.revoke`
sets `revokedAt` and tombstones the cache entry (Task 6), and that is the behaviour to keep: the row
is the forensic record of a session that existed, `rotatedFromId` chains are reconstructed from it
during an incident, and `Session.revokedAt` is what `/settings/security` (Task 17) reads. **Correct
the sentence in `api/authentication.md` §2 in the same change**, and say why in the document rather
than only here. Revocation must remain immediate — that is the property that mattered — and
`revoke` already tombstones before it writes.

Logout clears **both** cookies (session and CSRF) using the clearing helpers in `cookies.ts`, and
returns 204 with no body.

### D8. `GET /api/v1/auth/session` tells the truth about what does not exist yet

`@AuthenticatedOnly()`. Return `userId` from the principal, `entitlements: {}` (billing is Phase 5),
and:

- `permissions: []` — **today the effective permission set is genuinely empty**: there is no role
  assignment machinery until Task 12, and inventing a value would be a lie the frontend would
  believe. Say so in a comment at the site and in `api/authentication.md` §2. Do not fabricate a
  placeholder permission.
- `activeOrganization` — implement the lookup **for real** from `Session.activeOrganizationId`
  (`id`, `slug`, `name`), through a narrow port in the style of `IdentityStore`, not against the
  whole Prisma client. It resolves to `null` for every session Phase 2 can currently create, because
  nothing sets that column until Task 13 — so prove the non-null arm in the integration lane by
  inserting an `Organization` row and a session that points at it. An unimplemented lookup here is
  a lookup Task 13 has to discover is missing.

### D9. The MFA arm is implemented as a refusal, and its credential shape is provisional

No account can hold a confirmed `MfaFactor` today (there is no enrolment endpoint until Task 11) —
but login must still **refuse to issue an `ACTIVE` session when one exists**, or Task 11 lands on
top of a latent MFA bypass. So: after a correct password, look for a confirmed factor; if there is
one, issue a `PENDING_MFA` session via `SessionService.issue` (status stated explicitly — ruling 6 —
and `mfaCompletedAt: null`), set **no cookie**, and return
`{ mfaRequired: true, pendingToken: <the raw session token> }`.

**This is provisional and you must record it as such.** ADR-0018 is reserved for the pending-MFA
credential decision and belongs to Task 11; Task 9 is not writing it. What Task 9 pins is only the
response shape already committed in `loginResponseSchema`, so Task 11 remains free to change how the
pending credential is delivered without a breaking wire change. Note in your report that a
`PENDING_MFA` session token returned in the body is unreachable by any current route — the
authentication guard reads the cookie, and `@AllowPendingMfa` sits on no shipped handler.

### D10. `rememberMe` joins the login contract

Carry-forward ruling 18: `loginRequestSchema` has no `rememberMe` and Task 9 adds it — an
**optional** boolean, which is additive under `api/conventions.md` §8. It flows to
`SessionService.issue`, which already implements the 7-day / 30-day split and the browser-session
cookie (`cookieMaxAgeSeconds: null`). Ruling 49: pin one side of any expiry assertion to a fixed
instant rather than comparing two clock readings.

### D11. Rate-limit classes are declared on the handlers, and one of them resolves nothing

Ruling 64 — assert the class on the shipped handler, never only on the config table.
`auth.controller.spec.ts` is the pattern and its exhaustiveness test fails when a handler arrives
without a row; extend it rather than writing a new file.

- `login` → the existing `login` class (5 / 15 min per account keyed on the body's `email`, 20 /
  15 min per IP, fail closed). **This is the first route on which a `{ bodyField }` principal source
  has ever resolved.** Assert in the integration lane that the per-account window and the per-IP
  window bite independently — that is §7's actual property ("one attacker must not lock out a whole
  tenant"), not merely that a limit exists.
- `logout` and `session` → `generalSession`, declared explicitly. **Say at the site that it resolves
  nothing today**: the limiter runs before the authentication guard by design
  (`architecture/backend.md` §3), so `principalSource: 'authenticated'` resolves on no request, the
  class is fail-open, and carry-forward ruling 55 records that nothing reports this at the default
  log level. Declaring it is honest bookkeeping, not a control — and a route with no decorator would
  fall to the same class silently, which is worse.

---

## 4. What the tests must prove

Unit lane (`*.spec.ts`, no Docker), against the fakes in `apps/api/src/testing/identity-fakes.ts` —
extend them rather than writing a second set:

- Both login paths call `PasswordService.verify`, and the no-account path passes `null` (so the
  dummy hash is paid). A mutation that short-circuits the absent account must turn a test red.
- The lock ladder at every rung, including that an attempt during a live lock changes no state.
- The burst notice fires once per lock and not per failure.
- No mail is sent from inside a transaction, and a transaction that throws at commit produces zero
  sends (`registration.service.spec.ts` is the pattern).
- The corrupted-credential path logs at `error` and answers `INVALID_CREDENTIALS`.
- Controller metadata: access declaration, rate-limit class, and the exhaustive handler list.
- `platform-audit.service.spec.ts`'s taxonomy parity extended to the new action(s).
- `registry.spec.ts` covers the ninth template by existing; assert explicitly that
  `failedLoginBurst` renders none of name, IP or user agent — pass a display name that is a URL and
  assert it appears in neither part, which is the test ruling 70 says to write.

Integration lane (real Postgres, real Redis, the real application via `buildApp`):

- Success: 200, both cookies set with the attributes `cookies.spec.ts` pins, an `ACTIVE` session
  row, `failedLoginCount` reset, `lastLoginAt` set, one `LOGIN` platform audit row.
- Wrong password: 401 `INVALID_CREDENTIALS`, counter incremented, one `LOGIN_FAILED` row, **no**
  `Set-Cookie`.
- **Enumeration: the response to a wrong password and the response to an address with no account
  are compared byte for byte** — status line, header set and body — the way
  `auth.enumeration.integration.spec.ts` already does it for registration. Extend that file.
- Lockout: five failures lock; a *correct* password then returns 403 `ACCOUNT_LOCKED`; a *wrong*
  password during the lock returns 401; an attempt during the lock does not extend it; after the
  window a correct password succeeds and clears the counter.
- Per-IP and per-account limits are independent (see D11).
- Logout: 204, both cookies cleared, the session row's `revokedAt` set, the cache entry tombstoned,
  and the next request with that cookie is 401 `SESSION_EXPIRED`.
- **Logout without `X-CSRF-Token` is 403 `CSRF_TOKEN_INVALID`** — this is the first
  cookie-authenticated route `CsrfGuard` has ever actually governed, and asserting it is how we
  learn the guard works on a real route rather than on a fixture controller.
- Login with `Sec-Fetch-Site: cross-site`, and login with a foreign `Origin`, are both 403; login
  with neither header succeeds (D1).
- `GET /auth/session`: 401 with no cookie; the document for a live session; the non-null
  `activeOrganization` arm with a seeded `Organization`; 401 `MFA_REQUIRED` for a `PENDING_MFA`
  session.
- MFA: a seeded confirmed `MfaFactor` makes login return `mfaRequired: true` with no `Set-Cookie`
  and a `PENDING_MFA` row (D9).
- `rememberMe: true` produces the 30-day absolute expiry and a cookie carrying `Max-Age`;
  its absence produces 7 days and no `Max-Age`.

**Cross-tenant isolation tests are mandatory for tenant-owned resources** (`CLAUDE.md`). Nothing
Task 9 touches is tenant-owned — `Session` is user-owned and deliberately outside the tenant
registry — so there is no row to write here; say that in your report rather than silently omitting
it.

---

## 5. Documents you must update in the same change

`CLAUDE.md`'s documentation rule, and the plan's execution protocol §6. Update the behaviour, not
the status — the orchestrator writes `roadmap.md`.

- `.claude/api/authentication.md` — §2 (the shipped shapes, `rememberMe`, what the session document
  does and does not contain, and D7's correction), §3 (login's own cross-site mechanism), §6
  (`ACCOUNT_LOCKED`'s 403 and D3's rule about when it is returned), §7 (the classes now carried by
  three more routes, and that a `{ bodyField }` source resolves for the first time).
- `.claude/security/authentication.md` — §2 (timing equality is now a shipped property of a real
  endpoint, with ruling 24's residual named), §7 (the ladder, the cap, the burst notice, and what
  the lock deliberately does not do).
- `.claude/security/abuse-prevention.md` §1 — the `login` class now governs a real route.
- `.claude/security/audit.md` §4 — `ACCOUNT_LOCKED`, and that these events are written to
  `PlatformAuditEvent`.
- `.claude/architecture/backend.md` §3 — the new guard's place in the stage list.

---

## 6. Verify, and what to hand back

Run all of these on the finished tree, capturing the real exit code outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`) — `$?` after a pipe reports the wrong stage:

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`, `docker compose ps`.

`pnpm test:e2e` is **not** in your list and must not get a row: Task 9 touches no `apps/web` path.
If that stops being true, run it.

Hand back, in `docs/superpowers/ledger/phase-2/task-09/report.md`:

1. The evidence table — one row per command **actually run**, its exit code, and the numbers it
   printed (test file and test counts, route count from `check:openapi`).
2. Every design decision you made that this brief did not make for you, with its cost if wrong.
3. Every mutation you applied to prove a test can fail, and what it did.
4. What you did **not** do, and what remains open — including the two inherited residuals (ruling
   24's parameter-raise timing gap, and D9's provisional pending credential).
5. Anything in this brief you found to be false. That is a finding, not an inconvenience: two of
   this phase's most expensive defects were sentences in a brief.

Commit as you go on `feat/phase-2-task-09`, in small commits with real messages. Never commit to
`main`.
