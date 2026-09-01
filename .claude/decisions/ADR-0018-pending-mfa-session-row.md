# ADR-0018: The pending MFA credential is a `Session` row in `PENDING_MFA` status, not a Redis-only token

**Status:** Accepted · **Date:** 2026-09-02

## Context

`security/authentication.md` §5 requires that MFA be checked *after* password verification,
"against a short-lived, unprivileged pending session that can do nothing but complete MFA". That
sentence names a credential without saying what it is made of, and the shape is a real decision:
between accepting a password and accepting a code, this product hands the caller something, and
that something is a bearer credential for a half-authenticated account.

Three forces:

- **It is issued on a path that runs before anything is proved twice.** A login that reaches the
  MFA arm has proved a password and nothing else. Whatever is handed over must be revocable, must
  expire on its own, and must be unable to read anything.
- **This codebase already has a revocable, expiring, unprivileged-by-status credential.**
  `Session` carries `status` with no `@default` (carry-forward ruling 6), two independent expiry
  clocks, `revokedAt`, a Redis tombstone that no live write can overwrite, and
  `SessionService.rotate`, which is `security/authentication.md` §3's session-fixation defence.
  `SessionStatus` has had a `PENDING_MFA` value since Phase 2 Task 1.
- **Phase 2 Task 9 shipped the credential provisionally and left the decision unrecorded**
  (carry-forward ruling 81). Login returns `{ mfaRequired: true, pendingToken }` in the body with
  no cookie, the token is a `PENDING_MFA` `Session` row, and until Task 11 no route could reach
  it. This ADR number was reserved at that point precisely so the decision would be written by
  the task that gives the credential a consumer.

## Decision

**The pending MFA credential is a `Session` row whose `status` is `PENDING_MFA`.** It is minted by
`SessionService.issue` on login's MFA arm, returned in the response body, and spent by
`POST /api/v1/auth/mfa/verify`, which promotes it with `SessionService.rotate({ status: 'ACTIVE',
mfaCompletedAt })`.

Four consequences follow from that choice and are the reason for it:

- **Revocation is the mechanism that already exists.** Signing every session out — a password
  change, a reset, an administrative action — sweeps pending sessions with the same `updateMany`
  and the same cache tombstone, with no second code path to remember. A Redis-only token would
  need its own revocation, and every future bulk-revocation site would have to remember to call
  it.
- **"Rotate on privilege change" becomes literal rather than analogous.** §3 lists MFA completion
  as a privilege change. Because the pending credential and the full credential are the same kind
  of row, completing MFA *is* a rotation: the predecessor is revoked, the successor carries
  `rotatedFromId`, and the token in the caller's hand before the promotion cannot be used after
  it. With a separate credential type, "rotation" would have been a word for "delete one thing and
  create a different thing", and `rotatedFromId` would have no value to hold.
- **It survives a Redis restart mid-login.** Postgres is the system of record for sessions and
  Redis is a cache in front of it (ADR-0005). A user who reaches for their phone while the cache
  is restarted types their code into a credential that is still there. A Redis-only token is gone,
  and the failure mode is "your password was accepted and then nothing worked", on the path where
  a user is least able to tell a bug from an attack.
- **The refusal machinery is one guard, not two.** `AuthenticationGuard` refuses a `PENDING_MFA`
  session on every route that does not carry `@AllowPendingMfa()`, with 401 `MFA_REQUIRED`. That is
  one rule over one credential type. A second credential type would mean a second resolver, and
  the question "which routes accept the other kind?" answered in two places.

**The pending token is not set as a cookie.** It travels in the login response body and is posted
back in the `mfa/verify` request body. A cookie is ambient — the browser attaches it to every
request to the origin — and a credential that may reach exactly one endpoint should be presented
deliberately. This is why `mfa/verify` is declared `@Public()`: no cookie authenticates it, and
the pending token is a credential the handler resolves itself.

## Alternatives considered

**A Redis-only pending token (a random value keyed to a user id with a TTL).** The obvious
lightweight option, and the one this ADR exists to reject. It avoids a database write per login
that reaches MFA — the cost named below — and it expires by itself with no sweeper. It loses on
every other axis: it is invisible to session revocation, so a password reset would leave a live
half-credential behind unless every revocation site remembered a second call; it disappears on a
Redis restart in the middle of the one flow where a user cannot distinguish a bug from an attack;
it gives `rotate` nothing to rotate, so MFA completion becomes create-and-delete and the audit
trail loses `rotatedFromId`; and it puts a bearer credential in a component whose keyspace is
readable by anything with a connection.

**A signed, stateless token (JWT or an HMAC of `userId|expiry`).** No storage at all, and the
server can verify it with a key. Rejected for ADR-0005's reason, which does not weaken because the
token is short-lived: a stateless credential cannot be revoked before it expires. The pending
credential is precisely the one an attacker holds when they have the password and not the factor,
so "we cannot take it back for ten minutes" is the wrong property on the wrong credential.

**A dedicated `PendingMfaChallenge` table.** Honest about the domain, and it would let the attempt
counter live in a column of its own. Rejected because it duplicates `Session` almost exactly —
token hash, expiry, revocation, IP, user agent — and duplicating the credential table is how two
revocation stories, two expiry stories and two cache stories come to exist. The one thing it buys
(a column for the failed-attempt counter) is obtainable without it; see D5's counter in
`mfa-verification.service.ts`, which counts `MFA_CHALLENGE_FAILED` rows in `PlatformAuditEvent`
under a per-session advisory lock.

**No pending credential at all — one request carrying password and code together.** Simplest of
all, and it is what some products do. Rejected because it forces the client to hold the password
until the user has fetched their phone, and because it makes every MFA failure cost a full
Argon2id verification, which turns the MFA endpoint into a password-guessing oracle with a
built-in delay.

## Consequences

**A database write per login attempt that reaches MFA, and it is the cost of this decision.** Every
correct password on an MFA-enrolled account inserts a `Session` row that will usually be revoked
minutes later by the rotation that replaces it. A Redis-only token would have written nothing to
Postgres. Two things bound it: only a *correct* password reaches this path, so it is not a write an
unauthenticated caller can produce at will, and the row is one insert on a table that already takes
one insert per successful login. It does mean `Session` accumulates rows that were never real
sessions, which the session-pruning job Phase 4 owes will have to expect.

**The promoted session's lifetime is a question this design forces, and Task 11 could not answer it
well.** `login.service.ts` deliberately discards `rememberMe` on the MFA arm — a pending session is
not a session anybody asked to be remembered, and `absoluteLifetimeSeconds` ignores the flag for
`PENDING_MFA` anyway — so the row carries `rememberMe: false`. `SessionService.rotate` inherits
`rememberMe` from the predecessor. The consequence is that **an MFA-enrolled user who ticks
"remember me" gets the 7-day absolute lifetime rather than the 30-day one**, silently, and there is
no defect in either component: `issue` is right not to honour the flag on a ten-minute credential,
and `rotate` is right to inherit rather than invent. The gap is between them, and it is a
consequence of modelling the pending credential as a session that carries the field at all. It is
recorded here, in `security/authentication.md` §5, and in Task 11's report as a known behavioural
gap rather than fixed: carrying the preference across the promotion needs either a column on
`Session` that means "what the user asked for, not what this row got" or a `rememberMe` parameter
on `rotate`, and both are decisions with a wider blast radius than Task 11's scope.

**A pending session is a `Session` row, so everything that reads that table sees it.**
`/settings/security`'s device list (Task 17), any future "sessions" count, and the
`liveSessionsAtWrite` metadata on a password change all count pending sessions unless they
deliberately exclude them. Naming it here so the next reader of that table knows the row can exist.

**`AllowPendingMfa` is the only exception to the guard, and it is handler-level only.** The
decorator is typed `MethodDecorator` and `AuthenticationGuard` reads `context.getHandler()` alone,
so a class-level annotation exempts nothing (carry-forward ruling 61). One route carries it today
and none should carry it without an argument written down beside it.
