# Authentication architecture

> **Status: Designed. Not Implemented, except part of §2 and the service layer of §3.** Built in
> Phase 2. SSO/SCIM in Phase 11.
> Decision records: [ADR-0005](../decisions/ADR-0005-authentication-model.md),
> [ADR-0014](../decisions/ADR-0014-argon2-implementation.md) (Argon2 implementation and where its
> parameters live), [ADR-0015](../decisions/ADR-0015-password-breach-check-fails-open.md) (the
> breach check fails open).
>
> **What of §2 exists, as of Phase 2 Task 3.** Argon2id hashing and verification with transparent
> rehash-on-raise, the fixed-dummy verification that equalises login timing for an absent account,
> and the HIBP k-anonymity breach check. All three are services in `apps/api/src/modules/auth/`
> with **no caller**: no endpoint, no login path, no registration. The rest of §2 — password change
> and reset revoking other sessions and emailing the user — is Task 10's.
>
> Two limits of what shipped, stated because §2 reads as though they are settled. The ~250 ms
> figure below is a **tuning target, not a measured cost**; nothing has been tuned, and there is no
> production hardware to tune against. And "login timing equalised whether or not the account
> exists" holds against the dummy at *current* parameters — **not** against stored hashes written
> before a parameter raise, which verify more cheaply until their owners next log in. Task 9 owns
> closing that.
>
> **What of §3 exists, as of Phase 2 Task 6.** `SessionService`, `SessionRepository`,
> `RedisSessionCache` and `cookies.ts` in `apps/api/src/modules/auth/` — issue, resolve, rotate,
> revoke, `revokeAllForUser`, `revokeAllForUserInOrganization`, both lifetimes, rolling renewal, and
> the cookie serialiser. Every bullet in §3 below has a test at the layer where it can fail —
> twenty-three of them against a real Postgres and the compose Redis, and the rest as unit tests.
> The fourth bullet's `createdAt` had no assertion until the Task 6 review found it and one was
> added; nothing else in §3 was ever short of coverage.
>
> **ADR-0005's mechanism sentence predates this measurement.** Its Decision and Consequences say
> revocation "delete[s] the cache entry and the row together"; §3's paragraph below records that a
> delete does not achieve that promise, and that a tombstone does. The ADR is **not edited** — an
> accepted ADR is superseded, never rewritten — and no superseding ADR is owed here, because the
> decision it records (opaque server-side sessions, a cached lookup, immediate revocation) is
> unchanged and correct. The tombstone is how its promise is kept.
>
> **Nothing calls any of §3 yet, and that is now the narrower statement it used to be.** No
> endpoint issues a session, no guard reads one, and **no cookie has ever reached a browser** —
> `serialiseSessionCookie`'s output has been produced in specs and by one throwaway probe, and
> attached to no response. Task 9 builds the login, Task 10 the password paths, Task 11 the MFA
> completion, Tasks 13 and 14 the organisation switch and the member removal.
>
> **`AuthModule` does register a controller as of Phase 2 Task 8, and `pnpm check:openapi`
> reports seven routes, not four.** The three are §6's: registration, email verification, and
> the verification resend. Every sentence in this repository that cited "four routes" as proof
> that no endpoint shipped stopped applying at that commit. None of the three issues a session.
>
> Three limits, stated because §3 reads as settled. **Revocation's immediacy has one residual**: if
> Redis is unreachable at the moment of revocation the row is revoked but its cache entry cannot be
> poisoned, so an entry cached before the outage can serve until it expires — bounded by
> `SESSION_CACHE_TTL_SECONDS`, default 60. **The pending-MFA lifetime and the cache TTL are choices,
> not quotations**: §5 says only "short-lived" and ADR-0005 says only "a short TTL", so ten minutes
> and sixty seconds were picked here and are configuration. And **`PENDING_MFA` is only half enforced**: the
> status is recorded, its short lifetime applies, and promoting one to `ACTIVE` now requires an
> `mfaCompletedAt` — but the rule that such a session authenticates nothing except the MFA
> verification endpoint is Task 7's, and nothing enforces it today.

## 1. Model

A `User` is global — one human, one credential set, membership in many organisations.
Authentication establishes *who*; it says nothing about *which tenant* or *what they may
do*. Tenant resolution and authorization are separate, later steps in the request
pipeline. This separation is what makes multi-org consultants and organisation switching
work without re-login.

Two kinds of principal reach the API:

| Principal | Credential | Use |
|---|---|---|
| `UserPrincipal` | Session cookie | Browser |
| `ApiKeyPrincipal` | `Authorization: Bearer sk_...` | CI, integrations, scripts |

They produce the same `Principal` shape downstream, so authorization code is written once.
API keys are always scoped to exactly one organisation and carry their own permission
subset — an API key is never simply "the user's powers over the wire".

## 2. Passwords

- **Argon2id**, parameters tuned on production hardware to ~250ms (starting point:
  m=64MiB, t=3, p=4), stored with the parameters so they can be raised later and rehashed
  transparently on next successful login.
- Minimum 12 characters. No composition rules, no forced rotation — both push users toward
  weaker, more predictable passwords.
- **Breach check** against a k-anonymity range API (HIBP-style) on registration and
  change; a matched password is refused with a clear explanation.
- Constant-time comparison. Login timing equalised whether or not the account exists.
- Password change and reset **revoke all other sessions** and email the user.

**Timing equality is a shipped property of a real endpoint as of Task 9, not an aspiration.**
`PasswordService.verify` takes a nullable stored hash and performs a full Argon2id verification
against a per-process dummy when it is `null`, so `POST /auth/login` cannot express "no such
user, skip the hash" without deliberately not calling it. An account that exists but has no
`Credential` row takes the same path. What is asserted is that the work *happens* on both paths,
not a wall-clock comparison: a statistical timing assertion over a test database measures
scheduling rather than behaviour.

Three residuals, all open:

- **The absent-account path skips one indexed read.** It has no `userId` to look a credential up
  by. That is one index probe against a full Argon2id verification both paths pay, so a single
  observation separates nothing — the same trade registration records on its own two paths.
- **The burst notice is sent inside the request, so the fifth wrong password against a real
  address costs an SMTP round trip the fifth against an unknown address does not.** This is the
  same shape as the resend endpoint's residual and it is **not closable without the queue**: the
  difference is a real send happening on the response path, and moving it off that path is what
  the queue is for. Two things bound it and are recorded rather than used as an argument to ignore
  it — reaching it costs five failed attempts against one address, where the resend's costs a
  single request, and the per-account window is 5 per 15 minutes. It is structural: the test
  harness substitutes an in-memory mailer, so no test in this repository can see it.
- **Equality holds against the dummy at *current* parameters, and not against hashes stored
  before a parameter raise.** A pre-raise stored hash verifies at old, cheaper parameters while an
  absent account verifies at current ones — measured at 35.9 ms against 7.7 ms, a factor of 4.6,
  during Task 3. It is an enumeration oracle pointing the opposite way from the one the dummy
  closes, and **it opens on the day an operator raises the parameters.** Task 9 inherited it and
  did not touch it.

**A stored credential Argon2 refuses to read is now distinguishable from a wrong password — to an
operator, and to nobody else.** It is an operational fault: the row is corrupt, truncated, or
written by something else. It is logged at `error` with the user id and **no fragment of the hash
or the password**, and the caller receives the same `INVALID_CREDENTIALS` as any wrong password.
Nothing is logged for an address with no account, because a log line there would answer "is this
address registered?" in a file an operator reads.

**A successful login rehashes a credential stored at weaker parameters, as of Phase 2 Task 10.**
The "rehashed transparently on next successful login" half of the bullet above was unimplemented
between Task 3, which made `PasswordService.verify` report `needsRehash`, and Task 10, which made
login act on it. Three properties of how it is built are worth stating because each is a way this
mechanism is commonly built wrong:

- **It is a compare-and-swap on the hash the verification ran against.** The write is decided from
  a value read before a ~40 ms verification, so a password change or reset that committed in
  between must not be overwritten. Without the predicate this maintenance write would reinstate the
  old password's digest and **silently undo a password change**. An affected-row count of zero
  means the credential moved and there is nothing to upgrade; it is not an error.
- **It never changes the response and never fails the login.** The user authenticated successfully
  and a maintenance write is not permission to refuse them, so a failure is swallowed — but logged
  at `warn`, naming the user id and no fragment of the hash or the password. Silence there would
  make this promise look kept while the residual below stayed wide open.
- **It runs on the MFA arm too.** The credential was proved correct; whether a second factor is
  still owed says nothing about the parameters the hash was stored at.

**It closes the third residual above only partially, and the remainder is structural.** Rehashing
on login is the mechanism that drains the population of hashes stored before a parameter raise, so
the oracle narrows every time somebody signs in — but an account whose owner never signs in again
keeps its old hash indefinitely, and nothing in this product can reach it.
[ADR-0014](../decisions/ADR-0014-argon2id-password-hashing.md) §116 already acknowledges that. The
residual is therefore **open and shrinking**, not closed, and no document may describe it as
closed.

## 3. Sessions

Opaque, server-side, revocable. Not JWTs — the argument is in ADR-0005, but the short
version is that a stolen token we cannot revoke is unacceptable for a product holding
this class of data.

- 256-bit random token; **only a SHA-256 hash is stored**. The database cannot be used to
  mint sessions.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix, path `/`.
- Absolute lifetime 7 days (30 with "remember me"); idle timeout 24h; rolling renewal past
  the halfway mark.
- Row records IP, user agent, `createdAt`, `lastSeenAt`, so the user can see and revoke
  their sessions from `/settings/security`.
- **Rotated on every privilege change**: login, MFA completion, password change, role
  change. This is the session-fixation defence.
- Redis caches the session lookup with a short TTL; **revocation reaches the cache entry
  and the row together**, so revocation is immediate rather than eventually consistent.

**How revocation reaches the cache, corrected in Task 6 after measuring it.** Deleting the
cache entry does not achieve the bullet above, in either order relative to the row: a
resolve that has already read a live row from Postgres can land its cache write *after* the
delete, leaving a live entry for a revoked session until the TTL expires. Measured — with a
`DEL`-then-`SET` cache, a resolve raced against a revocation left the session's JSON payload
on the key and the next resolve returned it as valid. So revocation writes a **tombstone**
over the key, and every live write goes through a Lua script that refuses to run over one;
Redis executes a script atomically, so there is no interleaving in which a live entry can
replace a tombstone. Both cases are in
`apps/api/src/modules/auth/session.service.integration.spec.ts`.

Two other properties that are not visible in the bullets. A session's **absolute expiry is
inherited across a rotation, not restarted** — otherwise the seven-day cap would bound
nothing for a user who changes their password weekly; the exception is `PENDING_MFA` ->
`ACTIVE`, where the pending session's few minutes were never the user's session lifetime.
And **`Session.status` has no database default**, deliberately, so every insert states
whether the session it is creating is privileged. The same rule reaches one layer up after the Task
6 review: neither `issue` nor `rotate` defaults it, and a `PENDING_MFA` -> `ACTIVE` rotation
additionally has to carry an `mfaCompletedAt` — the promotion carries its evidence rather than
asserting itself, because `rotate` is the one call that can raise a session's privilege.

## 4. CSRF

> **Status: Implemented as of Phase 2 Task 7**, in
> `apps/api/src/common/guards/csrf.guard.ts` and `modules/auth/csrf-token.ts`. It is a
> global guard, so it governs every route the application has — which today is four, none
> of which is cookie-authenticated. **No request has ever been refused by it outside a
> test.** Task 9 ships the first route it will govern in earnest.

Cookie authentication requires CSRF defence. `SameSite=Lax` is the baseline, not the
control. Every unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) authenticated **by cookie**
additionally requires a double-submit token: a non-`HttpOnly` **`__Host-csrf`** cookie
echoed in the `X-CSRF-Token` header, compared in constant time, and bound to the session.

Requests authenticated by API key are exempt — they carry no ambient credential, so there
is nothing for a cross-site request to abuse. Origin and `Sec-Fetch-Site` are checked as
a secondary signal.

**The cookie is `__Host-csrf`, not `csrf`.** This section named it `csrf` until Task 7;
the prefix is strictly stronger and costs nothing, because a browser refuses to store a
`__Host-` cookie carrying a `Domain`, or a `Path` other than `/`, or one that arrives
without `Secure`. Without it a sibling subdomain could set `csrf` for the whole
registrable domain and the value the page echoes back would be the attacker's — which is
exactly the cookie-injection weakness double-submit is known for.

**What "bound to the session" means here, and it is stronger than the plain pattern.** The
token is not stored: it is `HMAC-SHA256(key = the session token, message = a constant)`,
so it is computable from the session cookie on every request by every instance, it is a
different value for every session, and it changes on rotation with no extra step because
rotation mints a new session token. The guard compares the presented header against **that
derived value**, not against the CSRF cookie. Comparing header to cookie compares two
values an attacker who can write cookies controls both of; comparing against a value
derived from the `HttpOnly` session token trusts neither. In the honest case the two are
the same string, because the cookie is issued as the derived value.

The comparison hashes both sides to a fixed 32 bytes before `crypto.timingSafeEqual`,
because that function throws on unequal lengths — so the naive version answers 500 for a
short token and 403 for a wrong-but-right-length one, which is a length oracle.

**`Origin` and `Sec-Fetch-Site` remain a secondary signal and nothing may be deleted on
the grounds that they cover it.** They are absent from every non-browser client, so a
control resting on them would be no control at all. `Sec-Fetch-Site: cross-site` is
refused early because it is free; everything else is decided by the token.

**Login CSRF is not covered by this control, and that is now a deliberate layering rather
than an accident.** The guard skips a `@Public()` route entirely, exactly as the
authentication guard does, so neither of the two cases reaches it: a cross-site `POST` to
login carrying no session cookie, and one carrying a *stale* session cookie. The second is
why the exemption exists at all — the expected header is derived from the raw session
cookie, which is `HttpOnly`, so a page holding a stale `__Host-csrf` cannot produce it and
there would be no client-side way past a 403 on the login route. Task 7 originally refused
that request; the Task 7 review found it, and it is fixed.

**Task 9 owns login CSRF with its own mechanism.** A public route performs no action on an
ambient credential, so this control has nothing to protect there — but login CSRF is a real
attack (an attacker signs a victim into the attacker's account), and the remedy is a
pre-session token issued by the login page rather than one derived from a session that does
not exist yet.

## 5. MFA

TOTP (RFC 6238), 30s step, ±1 window for clock drift, six digits, HMAC-SHA1.

**Every bullet below is either built by Phase 2 Task 11 or deliberately deferred by it, and
says which.** The five routes are `POST /api/v1/auth/mfa/{enroll,confirm,verify,disable,
recovery-codes}` — [`../api/authentication.md`](../api/authentication.md) §2 documents their
bodies and errors.

- **Built.** The secret is generated server-side (20 random bytes, RFC 4226 §4's recommended
  length), **encrypted at rest** with `MFA_SECRET_ENCRYPTION_KEY` — AES-256-GCM, a random
  12-byte IV per encryption, the auth tag stored beside the ciphertext in one self-describing
  envelope. It is encrypted rather than hashed because verifying a code means recomputing it,
  and it is the only field in this phase that is. It is returned **once**, by `mfa/enroll`, as
  base32 and as an `otpauth://` URI; no endpoint can read it back. The QR **image** is the
  frontend's (Phase 2 Task 17); the API returns the URI.
- **Built.** `MfaFactor.secretKeyVersion` is written explicitly on every row, so key rotation
  is incremental and resumable rather than an all-or-nothing re-encryption. A row whose column
  and envelope disagree about the version is **refused**, not guessed at: that state means a
  re-encryption wrote one and not the other, and guessing decrypts with the wrong key and hands
  back bytes that look like a secret.
- **Built.** The factor is **only persisted as enabled after the user proves one correct
  code**. `confirmedAt IS NOT NULL` is the only test for "this user has MFA" anywhere in the
  codebase; counting rows is the wrong query. An abandoned enrolment leaves an unconfirmed row
  that gates nothing, and the next enrolment **replaces** it — without that, the
  `(userId, type)` unique constraint would mean a user who closed the tab could never enable
  MFA. Enrolment over a **confirmed** factor is refused with 409, because replacing a working
  factor without proving a code is an account-takeover step.
- **Built.** 10 single-use recovery codes, `XXXXX-XXXXX` over a 32-symbol alphabet with no
  confusable pair left intact — 50 bits each. **Argon2id-hashed**, not SHA-256: they are
  human-typed and low-entropy relative to a 256-bit token, so they need the work factor.
  Shown once at confirmation and once at regeneration, never retrievable. Using one sets
  `usedAt` under a conditional `UPDATE`, so the same code fails the second time under
  concurrency as well as sequentially. Regeneration deletes the whole set and issues ten new
  ones in one transaction.
- **Built.** Enabling or disabling MFA requires the **current password**, writes an audit event
  in the same transaction as the change, and emails the user. Regenerating recovery codes
  requires the password too, for the same reason — it invalidates the ten codes the owner
  printed. **A wrong password on any of the three writes `MFA_MANAGEMENT_DENIED`** and changes
  nothing.
- **Built.** MFA is checked **after** password verification, against a short-lived,
  unprivileged pending session that can do nothing but complete MFA. That credential is a
  `Session` row in `PENDING_MFA` status ([ADR-0018](../decisions/ADR-0018-pending-mfa-session-row.md)),
  delivered in the login response body with no cookie. `GET /auth/session` presented with one
  answers 401 `MFA_REQUIRED`.
- **Built, and it is a control §5 did not previously mention: REPLAY.** A TOTP code accepted at
  step `t` is never accepted again. The ±1 drift window means a single six-digit code stays
  computable for about ninety seconds, so an attacker who observes one — over a shoulder,
  through a phished form, from a proxy in front of the real site — can present it a second time
  inside that window. **The drift window does not defend against this; it is what creates the
  window**, and nothing else in the TOTP design does either. `MfaFactor.lastAcceptedStep`
  records the last accepted step and any code at or below it is refused. The check and the
  store are **one conditional `UPDATE`**, so two concurrent requests carrying the same valid
  code produce exactly one success. A consequence users see: the code that confirmed enrolment
  cannot be reused to complete the first challenge — they wait for the digits to roll over.
- **Built.** Failed attempts are rate limited (`mfaVerify`, 60/hour per IP, fail closed —
  [`abuse-prevention.md`](abuse-prevention.md) §1) **and lock the pending session after 5**.
  The lock is durable rather than a Redis counter: it counts `MFA_CHALLENGE_FAILED` rows for
  that pending session, under a per-session advisory lock so the count survives concurrent
  attempts. The fifth failure revokes the pending session; the user starts again from login,
  which costs them the password again. **The count is per pending session**, so signing in
  again starts a fresh five — what is bounded is guessing at one challenge, and the outer bound
  is the rate limit plus login's own 5 / 15 min per account.
- **DEFERRED, AND ENFORCED BY NOTHING TODAY.** Organisations may **require** MFA; members
  without a confirmed factor are to be forced into enrolment before any other action, enforced
  server-side on every request and not only at login. The **decision** is built and unit-tested
  (`apps/api/src/modules/auth/require-mfa.ts`, with `MFA_ENROLMENT_REQUIRED` as its refusal),
  and it is **registered in no module and applied to no request**, because the check needs
  tenant resolution and organisation membership, which Phase 2 Task 12 builds. `Organization.requireMfa`
  is a column nothing reads. This is the same status `@RequirePermission()` has: metadata and a
  mechanism, with no guard in the pipeline. **Task 12 places it.**
- **DEFERRED.** WebAuthn is the intended second factor type and none of it is built. The
  `MfaFactorType` enum carries `WEBAUTHN` and the `MfaFactor` table is typed and multi-row from
  the start, so adding it is an insert rather than a migration of the authentication model —
  that is the whole of Phase 2's WebAuthn work.

**Two things Task 11 did NOT do, named here rather than left to be discovered.** Disabling MFA
does **not** revoke existing sessions: the caller proved the password, so signing every device
out would punish the legitimate user for a settings change, and the `mfaDisabled` notice is what
reaches the owner's mailbox on the takeover path. And regeneration sends **no** email — §5
requires a notice for enabling and disabling and names none for regeneration, and there is no
template for one.

## 6. Email verification, reset, invitations

> **Status of the email-verification row: Implemented (Phase 2 Task 8). The password-reset row:
> Implemented (Phase 2 Task 10).** The invitation row is Task 15's and remains Designed only.

All three use the same token discipline: 256-bit random, **hashed at rest**, single-use,
expiring, invalidated by use or by a newer token, and delivered only by email.

| Token | TTL | Notes |
|---|---|---|
| Email verification | 24h | Unverified users may sign in but cannot create organisations, invite, or scan |
| Password reset | 1h | Response is identical whether or not the address exists |
| Invitation | 7d | Bound to the invited address; revocable; accepting requires authentication as that address |

Password reset does not reveal account existence, is rate limited per address and per IP,
and revokes all sessions on completion. **The first clause is true of the response body and not
of the response latency** — see the residuals under the reset heading below.

### The email-verification token, as Task 8 actually built it

- **One live token per account, enforced by the database.** "Invalidated by use or by a newer
  token" was held only by `TokenService.issue`'s advisory lock until Task 8; the partial unique
  index `VerificationToken_userId_purpose_live_key` — `UNIQUE (userId, purpose) WHERE
  "consumedAt" IS NULL` — now holds it against any writer, including one that bypasses that
  service. Requesting a resend therefore invalidates the previous link by construction.
- **`consumedAt` is the only column, so "used" and "superseded" are one fact.** A row cannot
  distinguish the two; the audit event is the forensic record.
- **Redeeming checks `User.status` as well as the token.** `TokenService.consume` asserts
  nothing about the user it returns, so a `LOCKED` or `DISABLED` account's link would otherwise
  still redeem. A non-`ACTIVE` user is refused with the same `TOKEN_INVALID` as every other
  refusal, and the redemption is **rolled back** rather than burned — a link that was refused
  because an account was locked still works if an administrator unlocks it.
- **Every refusal is one code and one message.** Unknown, expired, already-used, superseded and
  not-active all produce `TOKEN_INVALID`. A fifth distinguishable outcome would be a fifth thing
  a caller can learn by submitting values.
- **The response to a registration or a resend does not depend on the account.** §7's rule,
  proved by byte comparison in `auth.enumeration.integration.spec.ts` rather than by inspection.

**Two residuals, stated because this section otherwise reads as settled.**

1. **Latency is not equalised, only dominated — and for the resend it is not even dominated.**
   Measured on 2026-08-28 through the real application against a Testcontainers Postgres, the
   compose Redis and a recording mailer (25 samples per case after 5 warm-up rounds, rate-limit
   windows cleared outside the timed region; Windows 11 x64, Node v26.7.0):

   | Request | median | range |
   |---|---|---|
   | `register`, new address | 47.8 ms | 41.4–57.6 ms |
   | `register`, address already in use | 44.5 ms | 37.9–56.7 ms |
   | `resend-verification`, no such account | 4.0 ms | 3.6–4.9 ms |
   | `resend-verification`, account awaiting confirmation | 8.6 ms | 7.7–12.4 ms |
   | `resend-verification`, account already confirmed | 4.2 ms | 3.6–5.9 ms |

   **Registration is the good case.** The Argon2id hash is paid on both paths and dominates, so
   the two differ by 3.3 ms of median on ~46 ms and their ranges overlap almost entirely — a
   single observation separates nothing, and a statistical attack would need a large, quiet
   sample.

   **The resend is the bad case and it is open.** Only the account-awaiting-confirmation path
   writes a row and sends a message, and its range does not overlap the other two at all: any
   single request over 7 ms is that case. The figures above use a recording mailer with no
   network; a real relay makes the gap larger, not smaller. So the response is byte-identical
   and the latency is a reliable oracle for "this address has an unconfirmed account".

   Closing it means moving the send off the response path, which needs the queue Phase 4 brings
   (ADR-0016). Nothing in Phase 2 closes it, and no document may describe the resend as
   enumeration-resistant without this qualification.
2. **A failed send is absorbed.** The mail is sent after the transaction commits, and a
   transport failure is logged and not propagated, because propagating it would make a
   mail-transport outcome into an existence signal. The consequence is ADR-0016's known gap: the
   person whose message was lost gets a success response and no email, and
   `POST /auth/resend-verification` is their only remedy.

### The password-reset token, as Task 10 actually built it

The bullets above about the email-verification token hold for this one too — it is the same
`VerificationToken` machinery, the same partial unique index, the same single conditional `UPDATE`
arbitrating a redemption, and the same `TOKEN_INVALID` for every refusal. What follows is what is
specific to a reset.

- **Redeeming checks `User.status`, and a refusal ROLLS BACK.** Same as verification, and the
  argument is stronger here because the token is worth more: a link refused because an account was
  administratively locked still works once an operator unlocks it, rather than being destroyed in
  exchange for nothing. The integration lane proves that by refusing a locked account's link,
  unlocking the account, and redeeming the same link successfully.
- **Six outcomes, one refusal.** Unknown, expired, already used, superseded, not-active, and a
  lost concurrent credential write all produce `TOKEN_INVALID`.
- **The breach check runs before the token is spent**, so a `PASSWORD_BREACHED` refusal does not
  cost the user their link. That matters for a check that is disabled by default and fails open
  ([ADR-0015](../decisions/ADR-0015-hibp-breach-check.md)).
- **A request for an address with no account still writes an audit row**, naming nothing and
  carrying no address in its metadata. The wire response is identical for every input by design,
  so that row is the only trace a distributed sweep leaves. See [`audit.md`](audit.md) §4.
- **An account that has never confirmed its address does get a link**, and **completing the reset
  now confirms the address**. The opposite of the resend's rule, and deliberate: the link is itself
  the proof of mailbox control, the message renders nothing a caller supplied, and refusing would
  strand anybody who registered and then lost their password before confirming. Redeeming it is the
  same evidence `emailVerifiedAt` carries, so the reset stamps it rather than leaving the account
  excluded from everything verification gates.
- **A completed reset clears the temporary brute-force lock.** `User.lockedUntil` is the ladder's
  lock and is independent of `User.status`, so before this an account could complete a reset and
  still be refused at `login` with `ACCOUNT_LOCKED` while holding the correct new password — the
  failure mode reset exists to fix, inflicted on somebody who had just proved mailbox control. The
  failure counter clears with it. An **administrative** lock (`User.status`) is not cleared and
  never should be: D4 refuses such a link outright.
- **A reset for a user with NO `Credential` row sets a password, and that is a Phase 11 decision
  waiting to happen.** It is correct today: a `User` without a `Credential` is currently only
  reachable by deletion, and refusing would strand such an account permanently. But once
  `IdentityProviderLink` accounts exist, that shape is exactly an **SSO-only** account, and letting
  an emailed link mint a password credential on one makes mailbox control a second authentication
  path onto an account an operator may have deliberately restricted to an identity provider.
  **Binds Phase 11**, which must either gate the branch on the absence of a linked provider or
  refuse for such accounts. Deliberately not decided here.

### The credential is written before anything is revoked, and that ordering is the control

§2's "password change and reset **revoke all other sessions**" stops being aspirational here, and
the order of the two halves is what makes it worth anything.

- **Reset revokes every session, with no exception.** The person completing it is holding none —
  they arrived from a link in their mailbox — and if somebody else is holding one, that is exactly
  the session being taken away.
- **Change revokes every *other* session and ROTATES the one in hand.** Losing your own session on
  a password change is a usability bug; keeping every other one is a security bug. §3 lists a
  password change as a privilege change, so the rotation is required rather than cosmetic: the
  token in the browser before the change cannot be used after it. The CSRF cookie is derived from
  the session token rather than stored, so it rotates with it and the user is not left signed in
  but unable to submit a form.
- **The new hash is committed BEFORE either revocation runs.** `revokeLiveForUser` is one
  `updateMany` whose predicate is evaluated at execution time, so it catches a session created
  *during* the call — what nothing inside it can catch is one created *after* it, and the only
  thing that prevents that is the old password having already stopped working.
- **Every credential write is a compare-and-swap** predicated on the hash that was read, because
  both endpoints read the credential, spend ~40 ms verifying or hashing, and only then write. Two
  concurrent changes both verify against the same old hash; without the predicate both commit and
  the account's password is whichever request happened to land last, with no error anywhere. An
  affected-row count of zero is a refusal, not a no-op.

### The racing login, and why the ordering alone was not enough

**This was shipped as an accepted residual, re-measured five times larger by review, and is now
closed.** The history is worth keeping because the fix is a pair of mechanisms rather than one, and
either half alone is insufficient.

The claim originally written here — and in `SessionService.revokeAllForUser`'s own docblock — was
that writing the new hash before revoking meant a racing login could not mint a session with the
old credential. It could. A login that has *already read* the old credential verifies successfully
against the value it read and inserts its `Session` row when its Argon2id verification finishes; if
that lands after the revocation, the row is never swept, because an `updateMany` cannot revoke a
row that does not exist yet.

This document first reported that as **one** surviving session out of five. Re-measured by review
across five consecutive rounds: **25 of 25 racing logins survived**, every one a fully privileged
`ACTIVE` session that answered `GET /auth/session` with 200, living seven days — thirty with
"remember me" — with the idle clock renewed on every use. With `rememberMe: true` the survivors
carried a thirty-day absolute clock. The vulnerable window is one Argon2id verification wide and
therefore **grows with the security parameter**: ADR-0014 targets ~250 ms in production against the
~40 ms the test harness runs at.

**What closes it, in two halves that only work together:**

1. **The reset commits the new credential before it revokes anything** (the ordering above). This
   is what makes the second half a guarantee rather than a narrowing.
2. **Login re-reads the credential after `SessionService.issue` returns.** If the credential it
   authenticated against is no longer the account's, it revokes the session it has just issued and
   answers `INVALID_CREDENTIALS`.

There are only two interleavings and both are covered: a `Session` insert landing *before* the
revoke is swept by the revoke, and an insert landing *after* it means the credential write
committed first, so the post-issue read observes it. There is no third ordering. Reverse the two
halves of the reset and the guarantee evaporates — the login would read the old hash, find it
unchanged, and keep its session.

The check compares **meaning, not bytes**: a mismatch triggers a re-verification of the password
against whatever is now stored, so a transparent rehash (§2) does not make a login revoke itself,
while a reset or a change does. It costs one indexed read on a `@unique` column per successful
login, and an extra verification only when the row actually moved.

**What remains open.** `change-password` has the same shape of window and is protected only by
timing rather than by construction — review measured 0 survivors out of 16, but that is an accident
of the change path paying a verification *and* a hash before its transaction, which lands its
revoke after the racing logins have already inserted. The same post-issue check belongs on any path
that issues a session after verifying a credential; **Task 14's member removal is the next one**,
and its equivalent does not exist. Carry-forward ruling 51 carries the original overstatement and
moves with this.

**One residual, measured, and not closed.**

**`forgot-password` is enumeration-resistant in its body and not in its timing**, which is the
   same residual the resend has and the failed-login burst notice has. Measured on 2026-09-01
   through the real application against a Testcontainers Postgres, the compose Redis and a
   recording mailer (25 samples per case after 5 warm-up rounds, rate-limit windows cleared outside
   the timed region; Windows 11 x64, Node v26.7.0):

   | Request | median | range |
   |---|---|---|
   | `forgot-password`, no such account | 11.4 ms | 9.4–16.4 ms |
   | `forgot-password`, account not `ACTIVE` | 11.7 ms | 8.3–20.0 ms |
   | `forgot-password`, active account (issues a token, sends a link) | 14.1 ms | 10.9–20.9 ms |

   **These ranges overlap, unlike the resend's, and the figures understate the real gap.** The
   overlap means a single observation separates nothing here; the difference in medians is the
   token transaction and its advisory lock. The understatement is structural and is the important
   half: the harness substitutes an **in-memory** mailer, so the active-account path pays no SMTP
   round trip in this measurement and does in production. A real relay widens the gap rather than
   narrowing it, and no test in this repository can see that — the same sentence §2 already carries
   about the burst notice.

   Closing it means moving the send off the response path, which needs the queue Phase 4 brings
   ([ADR-0016](../decisions/ADR-0016-smtp-mailer-port.md)). Nothing in Phase 2 closes it, and no
   document may describe this endpoint as enumeration-resistant without this qualification.

### Unverified users

§6's table says an unverified user may sign in but may not create organisations, invite, or
scan. **The mechanism exists and it governs no route yet.** `EmailVerifiedGuard` and
`@RequireVerifiedEmail()` were built in Task 8 and are proved against purpose-built controllers;
they are registered in no module and no handler carries the decorator, because all three of
Task 8's routes are public and reachable by someone with no account. Task 13 registers the guard
and applies it to organisation creation; Tasks 14 and 15 apply it to inviting. Until then
`EMAIL_NOT_VERIFIED` is a refusal nothing can produce, and nothing may record it as enforced.

## 7. Brute force and enumeration

- Progressive delay then temporary lock per account; independent per-IP limits so one
  attacker cannot lock out a whole tenant.
- Registration, login, and reset return responses that do not distinguish existing from
  non-existing accounts. **All three are built** — registration in Task 8, login in Task 9, reset
  in Task 10 — and all three are proved by byte comparison rather than by inspection. The
  registration half has a second part that is easy to leave out: the address that already has an
  account receives a notice about the attempt, so the person who can act on it learns what the
  wire response deliberately does not say. **The reset half is true of the body and not of the
  latency**; §6 carries the measurement.
- Failed logins are audited with IP and user agent; a burst notifies the account owner.
- CAPTCHA hook at the registration and reset endpoints, enabled by feature flag when abuse
  is detected rather than permanently degrading the experience.

### The ladder, as built

The two columns are `User.failedLoginCount` and `User.lockedUntil`, and the count is the number of
**consecutive** failures after the attempt that just failed.

| Consecutive failures | `lockedUntil` |
|---|---|
| 1–4 | not set |
| 5 | now + 1 minute |
| 6 | now + 5 minutes |
| 7 | now + 15 minutes |
| 8 or more | now + 30 minutes |

**None of those figures is in this document's history — they are decisions taken in Task 9 and
written here**, the same way Task 8 wrote 30/hour into
[`abuse-prevention.md`](abuse-prevention.md) §1 rather than pretending it had transcribed it.
Five is where it starts because four is a plausible number of genuine typos for somebody with two
passwords in their head. **Thirty minutes is a cap, and the cap is the security property**: without
one the ladder becomes an indefinite lock that an *unauthenticated* caller can impose on any
account whose address they can guess, which is this section's own "one attacker cannot lock out a
whole tenant" reappearing one level down with the tenant replaced by a person.

**The escalating window IS the "progressive delay". There is no sleeping.** A login handler that
sleeps is a handler an attacker can pin: N concurrent attempts hold N connections and N event-loop
timers for as long as the attacker chooses, and the cost lands on the server rather than on them.
Growing the lock costs the attacker time and costs us one integer and one timestamp.

### The per-IP window BOUNDS this; it does not prevent it

§7's sentence is *"independent per-IP limits so one attacker cannot lock out a whole tenant"*, and
the two windows are genuinely independent — but independence bounds the damage rather than
preventing it, and this section previously read as though it settled the matter.

The arithmetic: the per-IP window is 20 attempts per 15 minutes, and tripping a lock costs 5
attempts, so **one address can trip four locks per window**. Holding an account at the 30-minute cap
costs 5 attempts per account per 30 minutes, which is roughly **eight accounts held permanently
locked from a single address** — more if the ladder is allowed to lapse between cycles. Against a
small organisation that is a meaningful fraction of its people, and it costs one IP address.

What actually prevents it is the cost of acquiring addresses, which is outside this control. The
honest statement is that the per-IP window makes locking out a *whole tenant* expensive rather than
impossible, and that a control described as stronger than it is will not be re-examined by the
person who most needs to.

### What the lock deliberately does not do

- **An attempt arriving while the lock is live changes no state at all** — no increment, no
  extension, no new lock, and no audit row. Otherwise an attacker who wants an account offline
  keeps it there forever by attempting once a minute, and an unauthenticated caller could grow an
  append-only table one row per request. The `ACCOUNT_LOCKED` audit row already records that the
  lock happened. What this costs is the forensic record of attempts *during* a lock.
- **The counter is not reset by a lock expiring.** Only a successful login resets it, so the ladder
  goes on climbing across cycles: an attacker who waits out the one-minute lock meets the
  five-minute one.
- **The lock is consulted only after the password has been verified.** Checking it first would make
  a locked account answer measurably faster than an unlocked one, which is an oracle for "this
  address is registered and somebody has been guessing at it".

### No security notice renders a user agent

**No message this product sends renders a `User-Agent`, on any template.** The field was removed
from the shared context block outright, so there is no parameter for it to travel through.

This replaces a narrower rule. The earlier one licensed a `Device:` line on the four notices that
describe an action taken with the account's own credentials, on the grounds that "there it
describes the recipient's own session". That exception produced **three findings in three tasks** —
the caller's `User-Agent` in the registration-attempt notice, the stored display name through the
same template, and then the unfamiliar-sign-in notice, whose entire purpose is to warn a victim
that somebody *else* is in their account. On that path the recipient and the party who chose the
header are different people, which is the condition the rule already forbade. A rule with an
exception that has produced three findings in three tasks is not a rule with an exception.

**The IP address stays, and the difference is enforced rather than assumed.** It is the socket peer
address, read with `trust proxy` disabled, so a client cannot choose it. That was originally the
*reason* for keeping the line and not a property of the code — a value that was not an address
would have been rendered verbatim, and measurement showed a URL passed as the address produced a
link in all four notices. The renderer now emits an address only when the value is an address
literal, and `not recorded` otherwise, which is the same answer an absent one gets.

The user agent is not discarded. It goes in the `PlatformAuditEvent` row, which is where
attacker-supplied text belongs: read by an operator, in an append-only table built for exactly
that, never rendered into a message sent to somebody else.

**That residual is closed as of Phase 2 Task 10, and it was closed to the class rather than to
the instance.** Three notices still greeted by display name until then — password-changed and the
two MFA notices — plus the password-reset link message, which was the sharpest case of all: its
endpoint is unauthenticated and the message carries a live reset link, so a stored display name
would have put a stranger's sentence and URL beside a working credential. `User.name` is free text
an attacker seeds by registering a victim's address first.

All four lost the field, although two of them have no caller until Task 11. That is deliberate:
"safe because it has no caller yet" is the sentence that was left standing over the
unfamiliar-sign-in notice in the very task that gave it one. **No template in this product now
renders the recipient's stored display name**, and the template suite asserts that over the
registry itself rather than over a list somebody has to remember to extend. The invitation still
renders the *inviter's* name, which is a different person's, chosen by an authenticated member of
the organisation, and it is escaped.

### The burst notice

**The notice is sent inside the request, and that is an enumeration oracle this endpoint does not
otherwise have.** The fifth wrong password against a registered address waits for an SMTP round
trip; the fifth against an unknown address does not. The byte-comparison apparatus around this
endpoint exists to deny exactly that kind of distinction, and it cannot see this one — the
difference is in the wall clock, not the response. It is not closable here: moving the send off the
response path needs the queue. See §2's residual list.

`failedLoginBurst` is sent **once per lock**, on the attempt that trips it, and not on every
failure past the threshold — otherwise the notice is itself an outbound-email amplifier aimed at
the victim, triggered by an unauthenticated caller at will, and the fifth message tells the
recipient nothing the first did not.

It renders **no display name, no IP address and no user agent**. A burst is somebody else's
session: none of the three describes the recipient, and the user agent is a header the guessing
party chose outright. Its context type carries `{ occurredAt, attemptCount }` and nothing else, so
there is no parameter an attacker can reach — the structural fix rather than a filter. All three
values are recorded in the `PlatformAuditEvent` row instead, which is where attacker-supplied text
belongs. It is sent to an unverified address as well as a verified one, precisely because it
carries nothing injectable and the person who most needs to hear "somebody is guessing at your
account" is the one who has not finished setting it up.

The unfamiliar-sign-in notice is the mirror image and is treated differently: it is sent **only to
an address whose ownership has been proven**, it renders the IP address, and it renders **no display
name and no user agent** — `User.name` is free
text an attacker seeds by registering a victim's address first, and the parameter was removed
rather than filtered. "Unfamiliar" means the user has held no previous session, live or revoked,
carrying the same IP and user agent. That is one indexed read and it is deliberately not device
fingerprinting: an attacker who has the password can suppress the notice by copying a popular user
agent, and a browser version bump or a change of mobile network will produce a false positive.
False positives are the fail-safe direction.

**It is not throttled, and that is an open gap rather than a decision.** Because familiarity is an
exact match on the triple, somebody holding the password can send the account owner one notice per
sign-in by varying the user agent — measured at five notices for five logins. Since the H2 fix the
content is benign (no name, no user agent, an IP held to an address shape), so what is left is
mailbox flooding and alert fatigue rather than phishing: the cost is that the notice which matters
arrives among a hundred that do not. The burst notice solves the same problem for failed logins by
sending once per lock; this one has no equivalent, because the natural key would be per device and
the device is exactly what an attacker varies. **Closing it needs per-account notice throttling,
which nothing in this product has yet** — a Phase 4 concern alongside the queue, and named here so
the next person to touch this notice knows it is missing rather than deliberate.

## 8. SSO and SCIM

> **Status: Not Implemented — Phase 11.** The data model does not block it.

`IdentityProviderLink` exists from Phase 2 with `(userId, providerId, externalId)`, and
organisations carry an optional enforced-domain setting. SAML 2.0 and OIDC land in Phase
11; SCIM 2.0 provisioning maps to the existing `Membership` and `Role` tables. Designing
these tables now costs nothing and avoids re-modelling identity later, which is the single
most expensive migration an enterprise SaaS can face.

## 9. Testing requirements

Registration, verification gating, login success and failure, timing equality, MFA
enrolment and challenge, recovery code single-use, session rotation on privilege change,
immediate revocation, idle and absolute expiry, CSRF rejection, reset token single-use and
expiry, enumeration resistance, and rate limit behaviour. Cross-tenant: a session for org
A must not authenticate a request scoped to org B.
