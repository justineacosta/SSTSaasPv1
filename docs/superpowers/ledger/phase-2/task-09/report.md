# Task 9 implementer's report — login, logout, the session endpoint, lockout

> **A dated record of what was measured and decided at the time. Not a description of current
> state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-08-31, on `feat/phase-2-task-09`, branch head `254680f`,
cut from `main` at `00ac4ab`. Twelve commits, `6f5aac0` through `254680f`.

This report states commands, exit codes and measurements. It contains no status claim.

---

## 1. Evidence table

Every command below was run on the finished tree, with the exit code captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **81 test files, 1252 tests**, all passed |
| `pnpm check:specs` | 0 | `99 spec files, each claimed by exactly one of: unit, integration, ui. No banned .test.* spellings.` |
| `pnpm test:integration` | 0 | **18 test files, 275 tests**, all passed |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 10`; `apps/api/openapi.json is byte-identical to what the contracts generate` |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `383 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit — all `Up (healthy)` |

`pnpm test:e2e` was **not** run and has no row. Task 9 touched no `apps/web` path
(`git diff --name-status main..HEAD` lists none).

### Movement against the Task 8 numbers the brief records

| | Task 8 (per brief) | Task 9 | Delta |
|---|---|---|---|
| Unit files / tests | 76 / 1120 | 81 / 1252 | +5 / +132 |
| Integration files / tests | 17 / 230 | 18 / 275 | +1 / +45 |
| `check:openapi` routes | 7 | **10** | +3 |
| `check:registry` models | 15 | 15 | 0 (no migration) |

**Task 9 opened no migration.** `git diff --name-status main..HEAD` shows no file under
`packages/db/prisma/migrations/` and no change to `schema.prisma`.

---

## 2. Design decisions this brief did not make, with the cost if each is wrong

### 2.1 An attempt during a live lock writes **no audit row either**

D2 says an attempt during a live lock changes no state — no increment, no extension, no new
lock. It is silent on the audit row. I extended the rule to cover it: `LoginService.login`
returns from the locked branch before any `$transaction` opens, on **both** arms.

*Reason:* the same one D2 gives, one layer over. An unauthenticated caller must not be able to
grow an append-only table one row per request, and the `ACCOUNT_LOCKED` row already records that
the lock happened. *Cost if wrong:* the forensic record of attempts made *during* a lock is
lost, including the sharpest one — an attacker who has the correct password and is waiting the
lock out leaves no trace of having tried. Recovering it means either a second table an attacker
can inflate, or a counter column, and both are a schema change.
Site: `login.service.ts`, the `if (isLocked(...))` branch.

### 2.2 `User.status` LOCKED / DISABLED answers `ACCOUNT_LOCKED` on a correct password

The brief never mentions `User.status`. Carry-forward ruling 37 requires the endpoint to check
it, and issuing a session for a `DISABLED` user would be a defect. The shape follows D3 exactly:
the status is consulted **after** the password has been verified, so a wrong password on a
`LOCKED` account is byte-identical to a wrong password on any other (asserted in
`auth.enumeration.integration.spec.ts`), and a correct password gets 403 `ACCOUNT_LOCKED`.

*Cost if wrong:* the administrative lock and the brute-force lock are one refusal to a caller.
An operator diagnosing "why can this person not sign in" cannot tell from the response which of
the two applies — they have to read the row. The alternative, a distinct code, is a second thing
a caller can learn by submitting values.

### 2.3 Logout revokes, then audits, in two operations rather than one transaction

`CLAUDE.md` rule 10 wants both in one transaction. `SessionService.revoke` takes no transaction
handle — deliberately, since Task 6 gave it an ordering that spans Redis and Postgres — so one
transaction covering both is not expressible without reopening Task 6.

Order chosen: **revoke, then audit**, both awaited, neither error swallowed. *Reason:* auditing
first means a failed revocation leaves an append-only row asserting a logout that did not
happen, and this codebase treats a false statement in that table as worse than a gap.
*Cost if wrong:* a failure in the audit write leaves a session genuinely revoked and an event
unrecorded, and the caller gets a 500 on a logout that succeeded. Site: `logout.service.ts`.

### 2.4 `LOGIN` is audited on the MFA arm too; `lastLoginAt` is not stamped there

D5's table has one row for "successful login". A `PENDING_MFA` login is a password that was
accepted, so it writes `LOGIN` with `metadata.mfaRequired: true`; the counter and lock are
cleared on both arms, and **`lastLoginAt` is stamped only on the `ACTIVE` arm**.

*Reason:* a user with MFA who mistyped four times must not stay one failure from a lock forever,
so the counter resets; but "last login" for a session that can do nothing but type six digits
would make the column mean "last accepted password", which is not what any reader of it will
assume. *Cost if wrong:* `lastLoginAt` under-reports for MFA users until Task 11 stamps it on
completion — and Task 11 has to know to.

### 2.5 No new-device notice on the MFA arm

*Reason:* "New sign-in to your Sentinel account" is a false statement about a session that has
not completed. *Cost if wrong:* an MFA-enrolled account gets no unfamiliar-session notice at all
until Task 11 sends one on completion. **Nothing is currently missed** — no account can hold a
confirmed factor, since there is no enrolment endpoint — but this is an obligation transferred
to Task 11 and it is written into `login.service.ts`'s docblock as such.

### 2.6 The burst notice IS sent to an unverified address; the new-device notice is not

*Reason:* the asymmetry is deliberate and rests on what each message can carry.
`failedLoginBurst` renders no display name, no IP and no user agent, so nothing an attacker
supplies can travel through it — and the person who most needs to hear "somebody is guessing at
your account" is the one who has not finished setting it up. `newDeviceSignIn` is a branded
notice about somebody's own session and goes only to a proven address.
*Cost if wrong:* an unverified, attacker-seeded address receives a Sentinel-branded message
five wrong passwords after somebody decides to trigger it. The message names nobody and links
nowhere, so what it costs is one email.

### 2.7 "Unfamiliar" is the exact `(userId, ip, userAgent)` triple, over any session

**The query, as the brief asks for it by name:**
`Session.findFirst({ where: { userId, ip, userAgent }, select: { id: true } })`, asked **before**
the new session is issued. `revokedAt` is not in the predicate.

**What it costs:** one indexed read per successful login. `@@index([userId, lastSeenAt(sort:
Desc)])` serves the `userId` prefix and the other two are a filter; the rows scanned are bounded
by how many sessions one person has ever held.

**What it does not prove**, and this half matters more: it is not device identity. A user agent
is a header the client chooses, so an attacker with the password can suppress the notice by
copying a popular string. It is exact-match, so a browser version bump or a change of mobile
network produces a false positive. False positives are the fail-safe direction, and the message
says "a device we have not seen before" rather than making a stronger claim. No fingerprinting
scheme was invented. *Cost if wrong:* the notice is noisier than "new device" suggests, and
evadable by an attacker who is paying attention.

### 2.8 The `Organization` lookup runs inside `withTenantTransaction` — measured

D8 says implement the lookup for real. A plain `prisma.organization.findUnique` through the
`PRISMA` token **returns null in production for every organisation that exists**, and would have
passed every test in this repository.

`Organization` carries `FORCE ROW LEVEL SECURITY` with
`USING/WITH CHECK ("id" = current_setting('app.organization_id', true))`
(`20260820132520_tenant_root_and_audit_restrict/migration.sql`). The API connects as
`sentinel_app`. Measured against the compose Postgres on 2026-08-31:

```
-- as sentinel_app, no app.organization_id set
SELECT id, slug, name FROM "Organization" WHERE id = 'org_probe_task9';
 id | slug | name
----+------+------
(0 rows)

-- as sentinel_app, SET app.organization_id = 'org_probe_task9'
       id        |    slug     |   name
-----------------+-------------+-----------
 org_probe_task9 | probe-task9 | Probe Org
(1 row)
```

The harness's own client is `postgres.ownerUrl` — the container superuser, which bypasses RLS —
so a spec seeded and asserted through it would have gone green over a lookup that always answers
`null`. That is carry-forward ruling 58's exact shape. Two things follow:

- `activeOrganizationLookup` uses `withTenantTransaction`, Phase 1's mechanism for this, which
  sets `app.organization_id` with `SET LOCAL` semantics and applies the scoping extension.
- `startAuthHarness` gained **`appPrisma`**, a second client bound to `postgres.appUrl`
  (`sentinel_app`), and `auth.login.integration.spec.ts` asserts both halves of the measurement
  above directly.

*Cost if wrong:* if `withTenantTransaction` is later removed as "an unnecessary transaction",
Task 13 inherits a lookup that silently returns null and looks exactly like "no organisation
chosen".

### 2.9 `credentialUnreadable` is reported by `PasswordService`, not derived by `LoginService`

D4 says to log a credential "that cannot be parsed as a PHC string". I did not implement it as a
parse check. `parseArgon2Phc` returns non-null for a syntactically valid PHC string with a
corrupt salt or digest, which argon2 still refuses — `password.service.spec.ts` asserts exactly
that case. The catch inside `runVerification` is the only site that knows, so it reports the
fact (not the message, not the hash) and `LoginService` writes the `error` line with the user id.
`credentialUnreadable` is `false` unconditionally on the `storedHash === null` path.

*Cost if wrong:* `PasswordVerification` gained a third field, so every `toEqual` against it had
to be widened (six pre-existing assertions). The alternative — a parse check in `LoginService` —
would have missed the corrupt-digest case silently.

### 2.10 `CrossSiteGuard` is registered last of the four global guards

*Reason:* it is the narrowest — every handler that opts in is `@Public()`, which is exactly the
set `CsrfGuard` skips — and a caller whose credential or CSRF token is wrong should hear about
that first. *Cost if wrong:* essentially none; the sets do not overlap. Asserted in
`app.module.spec.ts` so a reorder is visible.

### 2.11 Smaller ones, stated for completeness

- **`AccountLockedError`'s message names no duration.** Returning `lockedUntil` would let a
  caller measure which rung an account is on, and therefore how many failures it has
  accumulated — a fact about somebody else's account activity.
- **`LOGIN_FAILED` metadata is exactly `{ knownAccount, consecutiveFailures }`**, asserted as an
  exact key set rather than by substring search (`registration.service.spec.ts`'s finding: a
  mutant that inserts a value the spec cannot see survives a substring search).
- **`newDeviceSignIn` lost `recipientName` although ruling 70 does not strictly reach it** — see
  §5.4.
- **The enumeration comparison normalises `requestId`** — see §5.3.
- **`identityUserRow()`** was added to the fakes so a fixture names only the fields it is about.
  The two new required columns broke six literals.

---

## 3. Mutations applied, and what each one did

Every mutation was applied to the finished code, run, and reverted. `git diff --stat` was empty
after each revert.

| # | Mutation | Result |
|---|---|---|
| M1 | `renderNewDeviceSignIn` takes `SecurityNoticeContext` again and greets `Hello ${recipientName}`; `CASES` passes `s.name` | **1 red**: `name-free template newDeviceSignIn > renders no display name even when the display name is a URL`, on `steal()`. 104 others green |
| M2 | `LoginService.login` short-circuits `if (user === null)` **before** the verification (the mutation the brief names) | **1 red**: `both paths pay for the Argon2id verification > verifies against NULL when the address has no account`. 49 others green |
| M3 | The lock is consulted before the password is verified | **2 red**: `an attempt while the lock is live > answers ACCOUNT_LOCKED when the password is CORRECT, and still changes no state`; `... > still verifies the password, so the two arms cost the same` |
| M4 | An attempt during a live lock calls `recordFailure` (writes and re-locks) | **2 red**: `an attempt while the lock is live > changes NO state on a wrong password...`; `the burst notice > is sent ONCE PER LOCK, not once per failure past the threshold` |
| M5 | The familiarity lookup moves to **after** `sessions.issue` | **1 red**: `the new-device notice > asks the familiarity question BEFORE the session is issued` |
| M6 | `@RefuseCrossSite()` removed from the `login` handler | **2 red in the integration lane**: `the cross-site refusal > refuses Sec-Fetch-Site: cross-site with 403 CSRF_TOKEN_INVALID`; `... > refuses a foreign Origin with the same 403`. 39 others green |

Two red-before-green cycles were also run without a mutation, because the code did not exist yet
and the test named the reason:

- `platform-audit.service.spec.ts`'s taxonomy-parity test went red on **`ACCOUNT_LOCKED` is
  missing from security/audit.md §4** until §4 carried the name. That is the documented
  mechanism working, not a coincidence.
- `auth.controller.spec.ts`'s exhaustiveness test went red naming `login`, `logout` and
  `session` before a single row had been added to its table (ruling 64's purpose).

---

## 4. What I did not do, and what remains open

### 4.1 The two residuals the brief names as inherited

- **Carry-forward ruling 24 — the parameter-raise timing gap — is inherited, open and
  untouched.** Timing equality holds against the dummy at *current* Argon2 parameters and not
  against a hash stored before a parameter raise (measured at 35.9 ms against 7.7 ms, 4.6x, in
  Task 3). It opens on the day an operator raises the parameters. Task 9 did not close it and
  did not attempt to. Recorded in `login.service.ts`'s docblock and in
  `security/authentication.md` §2.
- **D9's pending credential is provisional.** A `PENDING_MFA` session token returned in the
  response body is **unreachable by any route that ships today**: `AuthenticationGuard` reads
  the session cookie and this token is not in one, and `@AllowPendingMfa()` sits on no shipped
  handler. `auth.login.integration.spec.ts` asserts that presenting it as a session cookie
  answers 401 `MFA_REQUIRED`. **ADR-0018 was not written** — it is reserved for Task 11. What is
  pinned is only the response shape `loginResponseSchema` already committed.

### 4.2 Cross-tenant isolation

**No cross-tenant isolation test was written, and the brief says to say so rather than omit it
silently.** Nothing Task 9 touches is tenant-owned: `Session` is user-owned and registered as
deliberately global (`packages/db/src/tenant-resources.ts:69`), as are `User`, `Credential` and
`MfaFactor`, and `PlatformAuditEvent` is the table ADR-0019 created *because* these events have
no organisation. `pnpm check:registry` reports 3 tenant-owned models and none of them appears in
this task's diff. There is no "Tenant A gets 404 for Tenant B's id" row to write.

The one tenant-owned table Task 9 reads is `Organization`, through the session document — and
the isolation control there is row-level security, which §2.8 measures directly rather than
asserting through a second tenant.

### 4.3 Named and not built

- **No transparent rehash on a successful login.** `PasswordService.verify` reports
  `needsRehash` and `LoginService` does not act on it, so a credential stored at weaker
  parameters stays there. ADR-0014's "rehashed transparently on next successful login" is
  therefore still unimplemented. It is a write on the login path and Task 10 already owns writing
  to `Credential`. Recorded in `login.service.ts` and in `security/authentication.md` §2.
- **No login timing was measured.** Task 8 measured registration (25 samples per path) and its
  review measured the resend (ruling 68). I asserted the *structural* residual — the
  absent-account path skips one indexed `Credential` read — with a test, and did not put a
  wall-clock figure on it. Nothing in this report or in any document may be read as a claim that
  login's two paths were measured to be equal in time.
- **Ruling 45's residual is untouched.** A failed send of `failedLoginBurst` or
  `newDeviceSignIn` is not retried, not queued, and nothing alerts on it. A failed *security
  notice* is the worse case, and it is owed by Phase 4's queue.
- **Ruling 55 is not closed.** `generalSession` on `logout` and `session` resolves nothing and
  reports nothing at the default log level. Declaring the class is bookkeeping; the fix is
  splitting the limiter into an early per-IP stage, which is not this task's.
- **Ruling 32 is not closed** (the partial unique index on `VerificationToken`). Task 9 opened no
  migration, so the "next task that opens a migration owns it" rule did not fire here.
- **`sessionResponseSchema.permissions` is `[]` on every request** and `entitlements` is `{}` on
  every request. Both are the honest current values, both are asserted, and both are named in
  `api/authentication.md` §2 as such.

---

## 5. Things in the brief I found to be false or materially incomplete

### 5.1 D1: "Wire it in `app-setup.ts` where the other guards are" — false

There are no guards in `app-setup.ts`. It registers three middlewares with `app.use()`, disables
`x-powered-by` and `etag`, applies routing, and installs the logger, the exception filter and the
logging interceptor. **Every guard is an `APP_GUARD` provider in `app.module.ts`**, whose own
comment says so: "ORDER IS ARRAY ORDER, AND NOTHING ELSE MAKES IT VISIBLE."

`CrossSiteGuard` is wired in `app.module.ts` as the fourth `APP_GUARD`, and
`app.module.spec.ts`'s order assertion moved from three guards to four. Following the brief
literally would have produced a guard that either did not run or ran outside the asserted order.

### 5.2 D8 does not anticipate that the "for real" lookup cannot work as written

D8 says to implement the lookup "for real ... through a narrow port in the style of
`IdentityStore`, not against the whole Prisma client", and to "prove the non-null arm in the
integration lane by inserting an `Organization` row and a session that points at it."

Both halves of that instruction, followed literally, produce a lookup that returns `null` in
production and a test that passes anyway. The narrow port in the style of `IdentityStore` is a
plain Prisma delegate, and `Organization` is behind `FORCE ROW LEVEL SECURITY`; the integration
harness connects as a superuser, which bypasses it. See §2.8 for the measurement and for what was
built instead. This is the closest thing in the brief to the failure class the phase's prose
rules exist for: a plausible sentence that a test would have confirmed.

### 5.3 §4's byte comparison is incomplete for an error response

Task 8's comparisons are of 200 responses whose bodies are a single constant literal, so nothing
in a body varied. Login's comparisons are of **error envelopes**, and `errorEnvelopeSchema`
carries `requestId`, minted per request by `RequestIdMiddleware` — which is the whole point of
it, and which is already excluded from the header comparison as `x-request-id`.

A literal byte comparison of the two bodies fails, and it did: the first run of the new block was
red on three tests with a buffer diff in the `requestId` characters. The value is now substituted
the way the CSP nonce already is, so `code`, `message`, `details` and `timestamp` stay inside the
comparison. `comparableBody` in `auth.enumeration.integration.spec.ts` carries the reasoning.

### 5.4 D6's stated reason does not apply to `newDeviceSignIn`

D6 says to remove `recipientName` "the way `emailVerification` and `registrationAttempt` were
closed", citing ruling 70. Ruling 70's rule is about "a message to an address whose ownership
has not been proven". `newDeviceSignIn` is sent only when `emailVerifiedAt !== null` — which D6
itself requires two bullets earlier — so ownership *has* been proven and the ruling does not
reach it.

The parameter was removed anyway, and the reason is written at the site rather than the ruling's:
the cost of keeping it is the whole attack surface and the benefit is a greeting, and the
verified-only condition is a one-line change in a service rather than a property of the template.
Flagged because a future reader following the citation would find it does not support the change.

### 5.5 Two smaller ones

- **D5's table and `PLATFORM_AUDIT_RESOURCE_TYPES` had to move together or the suite goes red.**
  `platform-audit.service.spec.ts` holds every entry in that list to being a real Prisma model,
  so `LOGOUT`'s `resourceId` being a `Session` and the list gaining `Session` are one change.
  They did move together; noted because the brief presents them as two bullets.
- **`check:openapi` reports 10, confirmed independently of the message.**
  `apps/api/openapi.json` gained 290 lines and the three paths `/api/v1/auth/login`,
  `/api/v1/auth/logout`, `/api/v1/auth/session`.

---

## 6. Files

New (13): `common/decorators/cross-site.decorator.ts`, `common/guards/cross-site.guard.ts` and
its spec, `modules/auth/lockout.ts` and its spec, `modules/auth/login.service.ts` and its spec,
`modules/auth/logout.service.ts` and its spec, `modules/auth/session-document.service.ts` and its
spec, `modules/auth/account-locked.error.ts`, `modules/auth/invalid-credentials.error.ts`,
`modules/auth/active-organization.store.ts`, `modules/auth/auth.login.integration.spec.ts`.

Modified (30), including `packages/contracts/src/auth.ts` (`rememberMe`),
`modules/audit/platform-audit.actions.ts` (four actions, `Session` resource type),
`modules/auth/emails/notice.templates.ts` (`failedLoginBurst`, `newDeviceSignIn`),
`modules/auth/identity.store.ts` (three delegates, the update union),
`modules/auth/password.service.ts` (`credentialUnreadable`), `testing/auth-harness.ts`
(`appPrisma`, `get`, the rate-limit class list), `testing/identity-fakes.ts`, and the five
`.claude/` documents.
