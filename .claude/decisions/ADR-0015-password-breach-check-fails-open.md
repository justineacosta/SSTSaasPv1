# ADR-0015 — The password breach check calls HIBP by k-anonymity, and fails open

**Status:** Accepted · **Date:** 2026-08-25

## Context

[`security/authentication.md`](../security/authentication.md) §2 requires a **breach check**
"against a k-anonymity range API (HIBP-style) on registration and change; a matched password is
refused with a clear explanation". It does not say what happens when that API is unreachable, and
that omission is the whole of this decision.

The check is a network call to a third party on the two paths a user cannot route around:
registration and password change. Password *reset* reaches the same code. So the availability of
`api.pwnedpasswords.com` becomes, by default, the availability of account creation for this
product — unless something is decided.

Two properties are in tension and only one can be had.

- **Completeness.** Every password is checked, always. No breached password ever enters the
  database, including during an outage.
- **Availability.** A user can always create an account and change their password, including
  during someone else's outage.

There is a third consideration that decides it: **the breach check is not the control that
protects the account.** Argon2id ([ADR-0014](ADR-0014-argon2-implementation.md)), the 12-character
minimum, lockout (Task 9), MFA (Task 11) and session revocation are. The breach check is a
*hardening* measure — it removes a class of already-compromised password from the population. A
hardening measure that can deny service is worth less than the service it denies.

## Decision

**A k-anonymity client, and only the first five hex characters of the SHA-1 leave the process.**
The password is hashed with SHA-1 locally, the first 5 characters of the hex digest are sent to the
range API, and the remaining 35 are matched against the returned list *in this process*. **The
password never leaves the process, and neither does its full hash.** SHA-1 here is the API's
required addressing scheme for a bucket lookup, not a security primitive; nothing is stored under
it. The test asserting the outbound URL contains exactly five characters of the digest and nothing
else **is the entire privacy claim** — without it the claim is a sentence, and this phase has a
recorded history of sentences that were not true.

**It is behind `PASSWORD_BREACH_CHECK_ENABLED`, and that flag defaults to false in `test`.** No
test suite may depend on a third party being reachable. A suite that reds because someone else's
service is down teaches the team to ignore red.

**A 2-second timeout, and it fails open.** On any error, timeout, non-200 response, or malformed
body: log at `warn` and allow the password. The user's request proceeds as though the check had
returned no match.

**A confirmed match is refused with a clear explanation, at HTTP 422.** §2 says the user is told
why, so the response says the password appears in a known breach corpus and asks for a different
one. It is a 422 rather than a 400 because the request shape was valid —
[`api/conventions.md`](../api/conventions.md) §2's status table reserves 422 for "valid shape,
failed a domain rule", which is exactly this. Getting it wrong would file a policy refusal in the
same bucket as a typo'd field name.

**This needs an error code that does not exist yet.** `api/errors.md` §3 lists no breach code, and
neither does `ERROR_CODES` in `packages/contracts/src/error-codes.ts`. Task 3 adds one to **both**
— the two lists have no parity spec between them, which is the same silent-drift shape that
carry-forward rulings 5 and 13 were written about, and `api/errors.md` is a document this task
makes false if it does not update it.

## Alternatives considered

**Fail closed — an unreachable HIBP blocks registration.** This is the more secure-sounding option
and it is the one being deliberately rejected, so it deserves the fairest statement: it is the only
choice under which the guarantee "no breached password is ever stored" actually holds. Every
alternative here weakens it to "no breached password is stored while a third party is up".

Rejected anyway. It hands a third party a switch that turns off account creation, password change,
and password reset for this product — including, at the worst possible moment, the reset flow
someone is using *because* they think their password is compromised. The security gained is
bounded and probabilistic; the availability lost is total and correlated with exactly the incident
where a user most needs to change a password. **Named here so the trade cannot be re-litigated as
an oversight: it was considered, and availability won.**

**Queue the check and enforce it after the fact** — accept the password, verify asynchronously,
force a reset on a match. Rejected for this phase. It needs a job queue (Phase 4), a forced-reset
state on the session, and a notification path, none of which exist at Task 3; and it turns a clean
synchronous refusal into a confusing later eviction. Worth revisiting once Phase 4 lands, as a
superseding ADR.

**Ship a local breach corpus.** Rejected. The useful lists are gigabytes, they go stale, and
distributing a corpus of real credentials inside a repository and every container image is a worse
security posture than the one it replaces.

**Retry before giving up.** Rejected as the default. Retries against an already-struggling service
push the tail latency of registration past what a user will wait, and the outcome after the last
retry is the same fail-open. A single 2-second attempt reaches the same decision faster.

**No breach check at all.** Rejected — `security/authentication.md` §2 requires one, and credential
stuffing against reused passwords is the most common way accounts on a platform like this are lost.

## Consequences

**Positive.** Registration, password change and password reset never depend on a third party being
up. Test suites are hermetic by default. The privacy property is strong and is pinned by an
assertion rather than asserted in prose.

**Negative — the real costs, stated plainly.**

- **During a HIBP outage, breached passwords are accepted and stored.** They are stored as
  Argon2id hashes with a 12-character minimum behind them, but they are accepted. This is the
  price of the decision and it is not hedged.
- **The failure is silent to the user.** They are told nothing, because there is nothing useful to
  tell them. The only signal is a `warn` log, which means **the rate of fail-open events is worth a
  metric and an alert** — a check that has been failing open for a month is functionally a check
  that was removed, and nothing in this design would surface that on its own. Not built at Task 3;
  named here as owed work for Phase 4's observability, and its absence is a real gap, not a
  formality.
- **SHA-1 appears in the codebase.** It is required by the range API's addressing scheme and is not
  used as a security primitive, but it will trip a scanner and it will read as alarming to anyone
  who greps for it. A comment at the call site should say so.
- **The check adds up to 2 seconds of third-party latency** to registration and password change on
  a slow day, on top of a deliberate ~250ms of Argon2id.
- **`PASSWORD_BREACH_CHECK_ENABLED` defaulting to false in `test` means the enabled path is only
  exercised against a stubbed transport.** No test proves the real integration works. That is the
  correct trade for suite hermeticity, and it does mean a change in HIBP's response format would be
  discovered in production.

**Neutral.** The flag makes fail-closed a per-environment choice, not a rewrite: an operator who
wants completeness over availability in one environment can have it. Changing the *default* is a
security decision and gets a superseding ADR rather than a quiet edit.
