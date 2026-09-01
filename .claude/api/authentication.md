# API authentication

> **Status: Partially Implemented.** Phase 2.
> The underlying model is in [`../security/authentication.md`](../security/authentication.md);
> this document covers the wire contract.
>
> **§8's three routes are Implemented (Phase 2 Task 8)** — registration, email verification and
> the verification resend — and the committed `openapi.json` publishes **seven** routes rather
> than four. §2's session flow is **not**: login, MFA verification, logout, the session endpoint
> and switch-org exist as Zod schemas in `@sentinel/contracts` (`auth.ts`) and as nothing else.
> No endpoint issues a session cookie, so §3's CSRF requirement governs no cookie-authenticated
> route yet. §4 and §5 (API keys) have no contracts at all: API keys are deliberately out of
> Phase 2's scope, and only the `apiKey` arm of `Principal` exists, defined so downstream guards
> are written once and throwing where it is reached.

## 1. Two credential types

| | Session cookie | API key |
|---|---|---|
| Consumer | Browser | CI, scripts, integrations |
| Header | `Cookie: __Host-session=…` | `Authorization: Bearer sk_live_…` |
| CSRF | **Required** on unsafe methods | Not applicable |
| Scope | The user's permissions in the active organisation | The key's own permission subset |
| Tenant | Active organisation from the session | Fixed at key creation |
| Lifetime | 7 days absolute, 24h idle | Until revoked or expired |

Both resolve to the same `Principal`, so every downstream guard is written once.

## 2. Session flow

```
POST /api/v1/auth/login          { email, password, rememberMe? }
  -> 200 { mfaRequired: false }  + Set-Cookie: __Host-session, __Host-csrf
  -> 200 { mfaRequired: true, pendingToken }   # MFA enrolled, NO Set-Cookie

POST /api/v1/auth/mfa/verify     { pendingToken, code }
  -> 200 + Set-Cookie: __Host-session

POST /api/v1/auth/logout         -> 204, both cookies cleared, session REVOKED
GET  /api/v1/auth/session        -> current principal, org, permissions, entitlements
POST /api/v1/auth/switch-org     { organizationId } -> new session context
```

> **Status: login, logout and session are Implemented (Phase 2 Task 9).** `mfa/verify` is
> Task 11's and `switch-org` is Task 13's; both shapes above are contracts with no handler.

`rememberMe` is **optional** and was added by Task 9 — adding an optional field to a strict
request schema is additive under [`conventions.md`](conventions.md) §8. Absent means a session
that ends with the browser: the cookie carries no `Max-Age` and no `Expires`. `true` means the
30-day absolute lifetime and a cookie that carries `Max-Age`. The cookie is never the authority
on lifetime — `Session.absoluteExpiresAt` and `Session.idleExpiresAt` are, and both are
re-checked on every request.

**Login sets two cookies, not one.** `__Host-session` and `__Host-csrf`, in one `Set-Cookie`
header. The CSRF value is derived from the session token by HMAC rather than stored, so it
rotates whenever the session does and nothing has to remember to rotate it (§3).

**The MFA arm sets no cookie at all.** The pending token travels in the response body. A cookie
is ambient and a `PENDING_MFA` session must be presented deliberately. The pending token is a
short-lived credential that can do exactly one thing: complete MFA. It cannot read any resource,
and `GET /auth/session` presented with one answers 401 `MFA_REQUIRED`.

**Logout REVOKES the session; it does not delete the row.** An earlier version of this document
said "session row deleted" and it was wrong in three ways, all found in Task 9: the row is the
forensic record that a session existed and an incident review reconstructs `rotatedFromId`
chains from it; `Session.revokedAt` is what the security-settings screen reads to show a user
their signed-out devices; and a delete would take the `LOGOUT` audit row's `resourceId` with it,
leaving an event pointing at nothing. **The property that actually mattered — that revocation is
immediate — is unchanged**: the cache entry is tombstoned *before* the row is written, so no warm
entry can serve the session afterwards.

`GET /auth/session` returns `{ userId, activeOrganization, permissions, entitlements }` and
deliberately **not** the session identifier, which has no business being readable by a script
running in the page. Two of those fields currently have no content and say so honestly rather
than being filled with a guess:

- **`permissions` is always `[]`.** There is no role-assignment machinery until Task 12 and
  nothing anywhere computes an effective permission set, so the effective set genuinely is
  empty rather than unavailable. A placeholder would be a lie the frontend would act on.
- **`entitlements` is always `{}`.** Billing is Phase 5 and owns the real shape; an open object
  is what lets that be filled additively.
- `activeOrganization` is a real lookup and currently always resolves to `null`, because nothing
  writes `Session.activeOrganizationId` until Task 13.

**Login answers in the same shape whether or not the account exists.** A full Argon2id
verification is performed either way — against a dummy hash when there is no account — so the two
do not differ in cost either. See [`../security/authentication.md`](../security/authentication.md)
§2 for the residual that remains.

## 3. CSRF

> **Status: Implemented (Phase 2 Task 7).** `POST /api/v1/auth/logout` is the first route it
> actually governs, shipped by Task 9.

Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` require `X-CSRF-Token` matching the
`__Host-csrf` cookie, compared in constant time and bound to the session. Missing or
mismatched returns 403 `CSRF_TOKEN_INVALID`. Bearer-authenticated requests are exempt —
there is no ambient credential for a cross-site request to abuse.

| | |
|---|---|
| Cookie | `__Host-csrf` — not `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` |
| Header | `X-CSRF-Token`, sent exactly once; two of them is a refusal, not a choice |
| Methods guarded | `POST`, `PUT`, `PATCH`, `DELETE` |
| Methods exempt | `GET`, `HEAD`, `OPTIONS`, `TRACE` |
| Credentials exempt | Any request carrying no `__Host-session` cookie, which is every bearer-authenticated request |
| Refusal | 403 `CSRF_TOKEN_INVALID` — one code and one message for missing, malformed, mismatched and cross-site alike |
| Value | Derived from the session, so it changes when the session rotates. A client re-reads the cookie rather than caching the value |

The refusal never distinguishes which half was wrong: telling a caller whether the header
was absent or merely incorrect tells an attacker which half of the control they have
already defeated.

Cross-origin callers must send the header, which makes every unsafe request a preflighted
one. `X-CSRF-Token` is on the CORS allowlist (ADR-0017); a client adding another custom
header needs that list extended.

### Login brings its own cross-site mechanism, and it is not double-submit

The guard above skips `@Public()` routes, and it must: the expected token is derived from the
`HttpOnly` session cookie, so a page sitting on the login form cannot produce it, and a caller
arriving with a *stale* session cookie would be refused with no way to recover — the way out of a
bad cookie is the login page. A cross-site login `POST` also carries no session cookie at all, so
double-submit has nothing to bind to.

What that leaves uncovered is **login CSRF**: an attacker submits a cross-site login carrying
*their own* credentials, so the victim's browser is silently signed in to an account the attacker
controls and everything the victim does afterwards accrues to it. Task 9 covers it with a
separate, narrower guard that routes opt into by decoration:

| | |
|---|---|
| Applies to | Handlers carrying `@RefuseCrossSite()`. Today that is `POST /api/v1/auth/login` and nothing else |
| Rule 1 | `Sec-Fetch-Site: cross-site` → refuse |
| Rule 2 | An `Origin` header that is present and is not the configured web origin → refuse. Compared exactly, never by prefix |
| Rule 3 | Neither header present → allow |
| Refusal | 403 `CSRF_TOKEN_INVALID` — the same code and message as the guard above, for the same reason |

The two rules are AND-ed: a request reporting `cross-site` is refused even when its `Origin` is
ours, so a forged `Origin` cannot re-open the arm the browser closed.

**Absence is allowed, and that is the residual.** A non-browser client — curl, a CI script, an
integration test — sends neither header, and what this control defends is a *browser* being
driven cross-site. Refusing on absence would make the absent header the control and would fail
every non-browser caller, while buying nothing: an attacker who can suppress both headers is not
driving a browser and does not need CSRF at all.

The registration, verification and resend routes deliberately do **not** opt in. They have the
same gap and what it buys an attacker is bounded by what they do — register creates an account
under an address the attacker must control to use, verify-email needs a 256-bit secret, and
resend is rate limited per IP and per address.

## 4. API keys

```
POST /api/v1/api-keys   { name, permissions[], expiresAt?, ipAllowlist? }
  -> 201 { id, name, key: "sk_live_01J8...", permissions, expiresAt }
```

**`key` is returned exactly once, at creation, and is never retrievable again.** Only a
SHA-256 hash is stored. The response body is the only copy; the UI states this before
generation and offers copy and download.

Keys are prefixed by environment (`sk_live_`, `sk_test_`) so a key leaked in a log or a repo is
immediately identifiable, and so secret scanners can match on the prefix. A key's permissions
are a subset of its creator's, and never include `organization.delete`,
`organization.manage_roles`, `billing.manage`, or `apikey.create`
([`../security/authorization.md`](../security/authorization.md) §7).

`lastUsedAt` and `lastUsedIp` are recorded asynchronously. Revocation invalidates the lookup
cache immediately, so a revoked key fails on the very next request rather than at cache
expiry. A request presenting a revoked key writes an `API_KEY_USED_AFTER_REVOCATION` audit
event — that is a signal worth having.

## 5. Rotation

```
POST /api/v1/api-keys/{id}/rotate  { overlapHours: 24 }
  -> 201 { newKey, oldKeyExpiresAt }
```

Rotation issues a new key and schedules the old one to expire after the overlap window, so a
deployment can roll without an outage. Both keys work during the overlap; both are audited
distinctly so you can confirm the old one has stopped being used before it expires.

## 6. Errors

| Situation | Status | Code |
|---|---|---|
| No credential | 401 | `UNAUTHENTICATED` |
| Bad password | 401 | `INVALID_CREDENTIALS` |
| Session expired or revoked | 401 | `SESSION_EXPIRED` |
| MFA required | 401 | `MFA_REQUIRED` |
| Bad MFA code | 401 | `MFA_INVALID` |
| Unverified email on a gated action | 403 | `EMAIL_NOT_VERIFIED` |
| Locked account | 403 | `ACCOUNT_LOCKED` |
| Unknown, malformed, or revoked key | 401 | `INVALID_API_KEY` |
| Expired key | 401 | `API_KEY_EXPIRED` |
| Key used from an address outside its allowlist | 401 | `INVALID_API_KEY` |

The last row is deliberate: an IP-restricted key used from the wrong address returns the same
error as an unknown key, so probing cannot distinguish "wrong key" from "right key, wrong
network".

**`ACCOUNT_LOCKED` is 403, not 401, and it is returned only when the password was otherwise
correct.** The status is easy to get wrong: 401 means "we do not know who you are", and on a
locked account we do — the caller has just proved it. What is refused is the action.

The condition is the security control rather than the status code. Answering `ACCOUNT_LOCKED` to
*any* attempt on a locked account would hand an enumeration oracle to precisely the caller who
has just demonstrated they will make five attempts: the response would confirm the address is
registered. So the password is verified first, always, and only then is the lock consulted:

| | locked | not locked |
|---|---|---|
| correct password | 403 `ACCOUNT_LOCKED` | a session |
| wrong password | 401 `INVALID_CREDENTIALS` | 401 `INVALID_CREDENTIALS` |
| no account | — | 401 `INVALID_CREDENTIALS` |

The top-left cell tells an attacker nothing they did not already have: reaching it requires the
password, and with the password they can simply wait the lock out. It tells the real user the one
thing they need — that their password is fine and the account is not signable-in right now.

**The message does not say "temporarily", and that is L5.** It said so, and the sentence was false
for `status = DISABLED`: not temporary, no later attempt will work, and resetting the password will
not help. Non-disclosure was being bought by telling the legitimate user something untrue. The
shipped message is true of both kinds and distinguishes neither, and
`login.service.spec.ts` pins the string so a future edit cannot quietly reintroduce a duration.

Both kinds of lock answer with it: `User.lockedUntil`, the temporary automatic brute-force lock,
and `User.status = LOCKED`/`DISABLED`, the separate administrative one. As a *refusal* they are
one answer, because a second distinguishable outcome is a second thing a caller can learn by
submitting values. **The message names no duration**: `lockedUntil` is a real timestamp, and
returning it would let a caller measure which rung of the ladder an account is on and therefore
how many failures it has accumulated — a fact about somebody else's account activity.

`INVALID_CREDENTIALS` covers five situations and a caller cannot tell them apart: no account, a
wrong password, an account with no `Credential` row, a stored credential Argon2 refuses to read,
and a locked account whose password was also wrong.

## 7. Rate limits

Authentication endpoints are limited per account **and** per IP
([`../security/abuse-prevention.md`](../security/abuse-prevention.md) §1), and fail closed if
Redis is unavailable — an outage must not become a credential-stuffing window.

The nine routes that exist carry:

| Route | Class | Windows |
|---|---|---|
| `POST /auth/register` | `registration` | 3/hour per IP |
| `POST /auth/verify-email` | `emailVerificationConsume` | 30/hour per IP |
| `POST /auth/resend-verification` | `emailVerificationResend` | 3/hour per address, 10/hour per IP |
| `POST /auth/login` | `login` | 5 / 15 min per account, 20 / 15 min per IP |
| `POST /auth/logout` | `generalSession` | 1000/min per principal — **resolves nothing today** |
| `GET /auth/session` | `generalSession` | as above |
| `POST /auth/forgot-password` | `passwordReset` | 3/hour per address, 10/hour per IP |
| `POST /auth/reset-password` | `passwordResetConsume` | 20/hour per IP |
| `POST /auth/change-password` | `passwordChange` | 10/hour per IP |

**Login is the first route on which a per-account window has ever actually resolved**, and
`forgot-password` is the second. The class
keys its principal on the request body's `email` field, and the three routes above it either
carry no account in their body or key on it for a different class. The two windows bite
independently, which is
[`../security/authentication.md`](../security/authentication.md) §7's actual property rather than
merely "a limit exists": one attacker guessing at one address must not consume the budget of
everybody behind the same egress address, and one attacker behind one address must not lock out a
whole tenant by naming their accounts in turn. **What the integration lane asserts is that the two
windows are independent** — not the sentence about the tenant, which no test bounds.

**The second half is a bound, not a prohibition, and the arithmetic is worth writing down.** The
per-IP window is 20 attempts per 15 minutes and one lock costs 5 attempts, so a single address can
trip four locks per window, and holding an account at the 30-minute cap costs 5 attempts per
account per 30 minutes — roughly **eight accounts held locked indefinitely from one address**, more
if the ladder is allowed to lapse between cycles. That is what "independent per-IP limits" buys:
it makes locking a tenant expensive and observable, not impossible. `security/authentication.md`
§7 carries the same sentence and the same correction.

**`generalSession` on `logout` and `session` resolves nothing and is declared anyway.** Its only
scope is `perPrincipal` with `principalSource: 'authenticated'`, and the limiter runs *before* the
authentication guard by design ([`../architecture/backend.md`](../architecture/backend.md) §3), so
`request.principalId` is never set when it reads it. The class is fail-open, and nothing reports
the miss at the default log level. Declaring it is honest bookkeeping rather than a control — a
route carrying no decorator falls to the same class **silently**, which is strictly worse, and the
decorator is what lets a test assert that somebody chose.

## 8. Registration and email verification

> **Status: Implemented (Phase 2 Task 8).**

```
POST /api/v1/auth/register             { email, password, name? }
  -> 200 { status: "VERIFICATION_REQUIRED" }

POST /api/v1/auth/verify-email         { token }
  -> 200 { status: "EMAIL_VERIFIED" }

POST /api/v1/auth/resend-verification  { email }
  -> 200 { status: "VERIFICATION_REQUIRED" }
```

All three are **public** and therefore **not CSRF-covered**: `CsrfGuard` skips public routes,
because the expected double-submit token derives from an `HttpOnly` cookie a page cannot read,
so requiring one on a route reachable by someone with no account would be a refusal with no
client-side remedy. §3 covers cookie-authenticated routes, of which there are none yet.

**None of them sets a cookie.** Registration does not sign the new account in; confirming an
address does not either. Task 9's login is the first response that will carry `Set-Cookie`.

**Status codes.** Registration returns **200, not 201**. [`conventions.md`](conventions.md) §2's
table gives 201 to a creation
"with `Location`", and a `Location` header naming the new account is precisely the disclosure
this endpoint exists to avoid — a 201 for a new address beside a 200 for an existing one would
put the whole oracle in the status line.

**The bodies are constants.** `VERIFICATION_REQUIRED` and `EMAIL_VERIFIED` are literal values, so
no field can vary with the account. Registration answers identically whether or not the address
is already in use, and the resend answers identically for an address with no account, one
awaiting confirmation, and one already confirmed.

**The request bodies are published, and that is new.** The generated document describes what
each of these three accepts, not only what it answers — including that a request schema is
`.strict()`, which reaches the document as `additionalProperties: false`, so a client can see
that an unknown field is a 400 `UNKNOWN_FIELD` rather than a silently discarded value. Phase 1
shipped only `GET` health probes, so `ApiDoc` had no way to describe a body at all until these
routes needed one.

**Refusals.**

| Situation | Status | Code |
|---|---|---|
| Password found in a public breach corpus | 422 | `PASSWORD_BREACHED` |
| Verification token unknown, expired, already used, superseded, or belonging to a non-active account | 422 | `TOKEN_INVALID` |
| Over the rate limit | 429 | `RATE_LIMITED`, with `Retry-After` |

The second row is one code for five outcomes on purpose. Splitting it would tell a caller that a
token *once existed*, which tells them the address is registered.

## 9. Password reset and password change

```
POST /api/v1/auth/forgot-password   { email }
  -> 200 { status: "RESET_REQUESTED" }

POST /api/v1/auth/reset-password    { token, password }
  -> 200 { status: "PASSWORD_RESET" }

POST /api/v1/auth/change-password   { currentPassword, newPassword }
  -> 200 { status: "PASSWORD_CHANGED" }   + Set-Cookie: __Host-session, __Host-csrf
```

**The first two are public; the third is authenticated.** That split decides which cross-site
mechanism covers each. `CsrfGuard` skips public routes for the reason §3 gives, so
`forgot-password` and `reset-password` carry `@RefuseCrossSite()` — the header-based refusal, on
`Sec-Fetch-Site` and `Origin` — and `change-password` carries none, because it is
cookie-authenticated and the double-submit token has something to bind to. Both halves are
asserted on the shipped routes rather than on a fixture controller.

**Only `change-password` sets a cookie.** `reset-password` deliberately does not: completing a
reset revokes every session, including any the caller happened to hold, and issuing a fresh one
would sign in whoever redeemed the link. They sign in afterwards with the password they just chose,
which is the step that proves they know it. `change-password` replaces both cookies with the
rotated session's, or clears them when there was nothing left to rotate.

**"Every session" includes a login that was in flight while the reset ran, and that took two
mechanisms rather than one.** The reset revokes what exists when its new credential commits; a
login already in flight inserts its session afterwards and is not swept by that revocation, so
login itself re-reads the credential after issuing and revokes the session it has just created if
the credential moved. Before that second half existed, every racing login kept a fully privileged
session for up to thirty days.
[`../security/authentication.md`](../security/authentication.md) §6 carries the measurement and the
argument that the two halves cover every interleaving.

**`forgot-password`'s body is a constant**, in the same way registration's and the resend's are,
and for the same reason: a field whose value never varies with the account cannot leak whether the
account exists. An address with no account, one awaiting confirmation, one fully active, and one
that is administratively locked all produce the same status and the same bytes. Only some of them
send anything.

**An account that has never confirmed its address does get a link.** This is the opposite of
`resend-verification`'s rule and it is deliberate: the link is itself the proof of mailbox control,
the message renders nothing a caller supplied, and refusing would permanently strand anybody who
registered and then lost their password before confirming. An administratively `LOCKED` or
`DISABLED` account gets none — a reset is not the route back from an operator's decision, and
`reset-password` refuses such a link anyway.

**Refusals.**

| Situation | Status | Code |
|---|---|---|
| Reset token unknown, expired, already used, superseded, belonging to a non-active account, or lost a concurrent credential write | 422 | `TOKEN_INVALID` |
| New password found in a public breach corpus | 422 | `PASSWORD_BREACHED` |
| `change-password` with the wrong current password | 401 | `INVALID_CREDENTIALS` |
| `change-password` with no or mismatched `X-CSRF-Token` | 403 | `CSRF_TOKEN_INVALID` |
| `forgot-password` or `reset-password` refused as cross-site | 403 | `CSRF_TOKEN_INVALID` |
| Over the rate limit | 429 | `RATE_LIMITED`, with `Retry-After` |

The first row is one code for six outcomes on purpose, and it is §8's rule applied to a sharper
endpoint. Splitting it would tell a caller that a token *once existed*, which tells them the
address is registered.

**A refusal on `reset-password` never burns the link.** Every one of those six throws inside the
transaction that consumed the token, so the redemption rolls back and the same link still works —
which matters most for the non-active case, where a link refused because an account was locked has
to keep working once an administrator unlocks it. The breach check runs **before** the token is
spent for the same reason: a 422 must not cost the user their link, particularly for a check that
is disabled by default and fails open.

**`change-password` refuses with 401 rather than 403, and does not touch the lockout ladder.** It
is a credential check, so `INVALID_CREDENTIALS` is the same code login gives for the same fact.
It deliberately does not increment `User.failedLoginCount`: a caller who could lock an account by
failing here could lock it with a stolen session, and the ladder's `ACCOUNT_LOCKED` refusal would
then be a distinguishable outcome on an authenticated route.

**It does, however, tell the account owner.** Staying out of the ladder used to mean this endpoint
had no per-account bound, no lock and no message at all — a weaker guard on the password than
`login`, on the one route that proves a password while requiring nothing but a stolen session.
Five *consecutive* refused attempts within fifteen minutes now send the owner the same
`failedLoginBurst` notice a burst of failed logins sends, once per burst. The count is taken from
the `PASSWORD_CHANGE_FAILED` audit rows rather than from a column, precisely so that nothing here
can move a counter a session thief would otherwise be able to weaponise, and a successful change
resets the run. The response is the identical 401 on every attempt including the fifth.

**A per-account 429 is the right long-term answer and is not built.** It needs the limiter's
per-principal stage, which rulings 55 and 59 already owe. Until then the bounds are the per-IP
rate-limit class below and the notice.

**Rate limits.** Two of these classes are new and neither was transcribed from
[`../security/abuse-prevention.md`](../security/abuse-prevention.md) §1 — that table had a row for
requesting a reset and none for completing one or for changing a password, so both figures are
decisions written into it in the same change.

| Route | Class | Windows |
|---|---|---|
| `POST /auth/forgot-password` | `passwordReset` | 3/hour per address, 10/hour per IP |
| `POST /auth/reset-password` | `passwordResetConsume` | 20/hour per IP |
| `POST /auth/change-password` | `passwordChange` | 10/hour per IP |

`passwordReset` is the **second** class whose per-account window actually resolves, after login's:
it keys its principal on the request body's `email`. The other two are per IP only, because
neither body carries an account — `{ token, password }` and `{ currentPassword, newPassword }` —
and deriving one from the token would mean a database read bought by an unauthenticated caller
before the limiter has decided anything.

`passwordChange` is the one row in that table that is a security control rather than bookkeeping.
The endpoint verifies a password, the account is fixed by the session cookie, and the answer is a
clean 401/200 split, so it is a credential-guessing oracle for anybody holding a stolen session.
Its per-**principal** window would be the right key and resolves nothing today, because the limiter
runs before the authentication guard; it is left undeclared rather than declared-and-unresolvable,
and §1 carries the reasoning.
