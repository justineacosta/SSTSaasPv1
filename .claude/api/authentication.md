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
POST /api/v1/auth/login          { email, password }
  -> 200 { mfaRequired: false }  + Set-Cookie: __Host-session
  -> 200 { mfaRequired: true, pendingToken }   # MFA enrolled

POST /api/v1/auth/mfa/verify     { pendingToken, code }
  -> 200 + Set-Cookie: __Host-session

POST /api/v1/auth/logout         -> 204, cookie cleared, session row deleted
GET  /api/v1/auth/session        -> current principal, org, permissions, entitlements
POST /api/v1/auth/switch-org     { organizationId } -> new session context
```

The pending token is a short-lived credential that can do exactly one thing: complete MFA. It
cannot read any resource. Login and MFA verification return in constant time whether or not
the account exists or the code is correct.

## 3. CSRF

> **Status: Implemented (Phase 2 Task 7).** No route it governs is cookie-authenticated yet;
> Task 9 ships the first.

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

## 7. Rate limits

Authentication endpoints are limited per account **and** per IP
([`../security/abuse-prevention.md`](../security/abuse-prevention.md) §1), and fail closed if
Redis is unavailable — an outage must not become a credential-stuffing window.

The three routes that exist carry `registration` (3/hour per IP),
`emailVerificationConsume` (30/hour per IP) and `emailVerificationResend` (3/hour per address,
10/hour per IP). Only the resend has an account to key on: the other two carry no account in
their request body, so "per account **and** per IP" is per IP alone for them, and a class that
declared otherwise would resolve nothing while looking enforced.

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

**Refusals.**

| Situation | Status | Code |
|---|---|---|
| Password found in a public breach corpus | 422 | `PASSWORD_BREACHED` |
| Verification token unknown, expired, already used, superseded, or belonging to a non-active account | 422 | `TOKEN_INVALID` |
| Over the rate limit | 429 | `RATE_LIMITED`, with `Retry-After` |

The second row is one code for five outcomes on purpose. Splitting it would tell a caller that a
token *once existed*, which tells them the address is registered.
