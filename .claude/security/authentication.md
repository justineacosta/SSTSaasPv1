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

TOTP (RFC 6238), 30s step, ±1 window for clock drift.

- Secret generated server-side, encrypted at rest with the application key, shown once as
  a QR code, and **only persisted as enabled after the user proves one correct code**.
- 10 single-use recovery codes, hashed like passwords, shown once, regenerable.
- Enabling or disabling MFA requires the current password, writes an audit event, and
  emails the user.
- MFA is checked **after** password verification against a short-lived, unprivileged
  pending session that can do nothing but complete MFA.
- Failed attempts are rate limited and lock the pending session after 5.
- Organisations may **require** MFA; members without it are forced into enrolment before
  any other action. Enforced server-side on every request, not only at login.
- WebAuthn is the intended second factor type. The `MfaFactor` table is typed and
  multi-row from the start so adding it is not a migration of the auth model.

## 6. Email verification, reset, invitations

> **Status of the email-verification row: Implemented (Phase 2 Task 8).** The password-reset row
> is Task 10's and the invitation row is Task 15's; both remain Designed only.

All three use the same token discipline: 256-bit random, **hashed at rest**, single-use,
expiring, invalidated by use or by a newer token, and delivered only by email.

| Token | TTL | Notes |
|---|---|---|
| Email verification | 24h | Unverified users may sign in but cannot create organisations, invite, or scan |
| Password reset | 1h | Response is identical whether or not the address exists |
| Invitation | 7d | Bound to the invited address; revocable; accepting requires authentication as that address |

Password reset does not reveal account existence, is rate limited per address and per IP,
and revokes all sessions on completion.

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
  non-existing accounts. **Registration is built (Task 8)**; login is Task 9's and reset is
  Task 10's. The registration half has a second part that is easy to leave out: the address that
  already has an account receives a notice about the attempt, so the person who can act on it
  learns what the wire response deliberately does not say.
- Failed logins are audited with IP and user agent; a burst notifies the account owner.
- CAPTCHA hook at the registration and reset endpoints, enabled by feature flag when abuse
  is detected rather than permanently degrading the experience.

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
