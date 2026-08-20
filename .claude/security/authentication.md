# Authentication architecture

> **Status: Designed. Not Implemented.** Built in Phase 2. SSO/SCIM in Phase 11.
> Decision record: [ADR-0005](../decisions/ADR-0005-authentication-model.md).

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
- Redis caches the session lookup with a short TTL; **revocation deletes the cache entry
  and the row together**, so revocation is immediate rather than eventually consistent.

## 4. CSRF

Cookie authentication requires CSRF defence. `SameSite=Lax` is the baseline, not the
control. Every unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) authenticated **by cookie**
additionally requires a double-submit token: a non-`HttpOnly` `csrf` cookie echoed in the
`X-CSRF-Token` header, compared in constant time, and bound to the session.

Requests authenticated by API key are exempt — they carry no ambient credential, so there
is nothing for a cross-site request to abuse. Origin and `Sec-Fetch-Site` are checked as
a secondary signal.

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

All three use the same token discipline: 256-bit random, **hashed at rest**, single-use,
expiring, invalidated by use or by a newer token, and delivered only by email.

| Token | TTL | Notes |
|---|---|---|
| Email verification | 24h | Unverified users may sign in but cannot create organisations, invite, or scan |
| Password reset | 1h | Response is identical whether or not the address exists |
| Invitation | 7d | Bound to the invited address; revocable; accepting requires authentication as that address |

Password reset does not reveal account existence, is rate limited per address and per IP,
and revokes all sessions on completion.

## 7. Brute force and enumeration

- Progressive delay then temporary lock per account; independent per-IP limits so one
  attacker cannot lock out a whole tenant.
- Registration, login, and reset return responses that do not distinguish existing from
  non-existing accounts.
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
