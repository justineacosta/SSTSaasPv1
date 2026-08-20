# ADR-0005 — Opaque server-side sessions, not JWTs

**Status:** Accepted · **Date:** 2026-08-20

## Context

The platform stores customers' unfixed vulnerabilities, penetration test reports, and evidence
captured from inside their applications — Restricted data by our own classification. A stolen
credential here is unusually valuable.

We need browser authentication, machine authentication for CI and integrations, MFA, immediate
revocation, and a model that can accommodate SSO and SCIM later without re-modelling identity.

## Decision

**Opaque, server-side sessions** for browser authentication. A 256-bit random token in an
`HttpOnly; Secure; SameSite=Lax; __Host-` cookie, with **only a SHA-256 hash stored** in
Postgres and cached in Redis. Argon2id for passwords. TOTP MFA with recovery codes. **Separate
API keys** for machine access, hashed at rest, scoped, and independently revocable.

`User` is a global entity; `Membership` binds a user to an organisation. Authorization is always
evaluated as `(user, organization, permission)`, never `(user, permission)`.

## Alternatives considered

**JWTs with short expiry and refresh tokens.** The obvious modern default, and rejected
deliberately. A JWT is valid until it expires because validity is a property of the token, not
of our records. That means: a compromised session cannot be killed instantly; a removed team
member keeps access until expiry; a demoted user keeps their old permissions in-token; a
suspended organisation's users keep working. Every one of those is mitigated by shortening
expiry and adding a revocation list — at which point there is a server-side lookup on every
request, which is what sessions already are, with more moving parts and a worse failure mode.

The usual argument for JWTs is avoiding a database lookup per request. We cache session lookups
in Redis with a short TTL and **delete the cache entry and the row together on revocation**, so
the common path is one fast Redis read and revocation is genuinely immediate.

**Third-party auth (Auth0, Clerk, WorkOS).** Rejected for the core, though WorkOS remains a
candidate for SSO/SCIM specifically in Phase 11. Reasons: we are a security product and
outsourcing the primary authentication of our customers' most sensitive data is a hard
conversation in every enterprise security review; per-user pricing scales badly against our
model; and we need tight coupling between authentication, organisation membership, and our own
audit log.

**Session tokens stored in plaintext.** Rejected. Storing the hash means a database read cannot
mint a session.

**Passwords only, MFA later.** Rejected. Retrofitting MFA into an auth model is painful, and a
security product without MFA at launch is not credible.

## Consequences

**Positive.** Immediate revocation of sessions, keys, and memberships. Users can see and revoke
their own active sessions. Permission and role changes take effect on the next request. No
token contents to leak or mis-verify. Session rotation on privilege change closes session
fixation.

**Negative.** A session lookup per request (Redis-cached). Session state must be shared across
API instances — satisfied by Postgres and Redis, both of which we already run. Horizontal
scaling requires no sticky sessions, but does require Redis availability for the cache; the
fallback path reads Postgres directly.

**Neutral.** `IdentityProviderLink` and a multi-row, typed `MfaFactor` table exist from Phase 2
so SSO, SCIM, and WebAuthn are additive rather than a migration of the identity model.
