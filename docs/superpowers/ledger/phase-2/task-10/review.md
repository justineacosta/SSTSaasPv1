# Task 10 review — the adversarial pass

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a fresh adversarial reviewer on 2026-09-01, at `feat/phase-2-task-10` = `42ddbf8`.
Code range reviewed: `c446947..d7822ae`. I did not write this code.

Everything below that says "measured" was run on this machine, on this tree, with the mutation
applied and reverted. Exit codes were captured outside a pipe. `git status` was clean before this
file was written and is clean apart from this file now.

This document is written and committed **incrementally**, finding by finding, rather than at the
end.

---

## Verdict on the question the brief names first

**High.** A completed password reset does **not** end every session created with the old
credential, and the residual is much larger than the implementer measured. The report and
`security/authentication.md` §6 both say five old-password logins fired alongside a reset left
**one** live session. Re-measured here: **five out of five, in five consecutive rounds — 25 of 25
racing logins survived**, every one of them a fully privileged `ACTIVE` session that authenticates.

---

## Code defects

### H1 (High) — a completed password reset leaves every in-flight old-password login holding a live session

**What the documents claim.** `password-reset.service.ts:342-344`, written by this task, states
flatly:

```
// AFTER THE COMMIT, AND THAT ORDERING IS D2. The new hash is durable before
// a single session is revoked, so there is no window in which the old
// password can mint a session that the revocation has already passed over.
```

`session.service.ts:695` (untouched by this task) still says a racing login "cannot mint a session
with the old credential once this call has finished", and carry-forward ruling 51 says the same.
Only `.claude/security/authentication.md` §6 carries the correction, and it under-reports the size.

**Measured.** A probe integration spec (added, run, deleted) firing one `reset-password` and five
`POST /auth/login` with the **old** password in one `Promise.all`, five rounds, then counting
`Session` rows with `revokedAt: null` and driving each returned cookie at `GET /auth/session`:

```
ROUND 0: reset=200 logins=200,200,200,200,200  live sessions after reset = 5
ROUND 1: reset=200 logins=200,200,200,200,200  live sessions after reset = 5
ROUND 2: reset=200 logins=200,200,200,200,200  live sessions after reset = 5
ROUND 3: reset=200 logins=200,200,200,200,200  live sessions after reset = 5
ROUND 4: reset=200 logins=200,200,200,200,200  live sessions after reset = 5
TOTAL SURVIVORS across 5 rounds: 25
  every survivor: status=ACTIVE  rememberMe=false
                  idle=+24h  absolute=+7d
  minted cookie -> GET /auth/session = 200   (all 25)
```

A second run with `rememberMe: true` produced 3–4 survivors per round with
`absolute=+30 days`, and each survivor again answered `GET /auth/session` with 200.

**How long it lives and what it reaches.** Nothing bounds it beyond the ordinary session clocks:
`idleExpiresAt` +24h **renewed on every use**, `absoluteExpiresAt` +7 days (+30 with "remember
me"). Nothing in the reset path revokes it afterwards, and the user has no way to see it — there is
no session-list screen until Task 17. It is a normal `ACTIVE` session, so it reaches every
authenticated route the product has and every route Tasks 12–15 will add. It cannot change the
password (measured: `POST /auth/change-password` with the old password → 401, because the
credential really did move), which is the one thing that limits it today.

**Why the ordering does not close it.** The login reads the credential, spends an Argon2id
verification on it, and only then inserts its `Session` row. The reset commits the new hash and
then runs `revokeAllForUser`. Any login whose read preceded the commit and whose insert follows the
revoke is never swept — `updateMany` cannot revoke a row that does not exist yet. The vulnerable
window is therefore approximately one Argon2id verification wide, which ADR-0014 targets at
**~250 ms in production** rather than the ~40 ms this harness runs at. The window grows with the
security parameter.

**Not symmetric with `change-password`.** Measured, four rounds: one change-password against four
concurrent old-password logins left `liveSessionRows=1` (the rotated caller) and
`oldPasswordSessionsStillUsable=0` every time. That is a **timing accident, not a structural
difference**: the change path pays a verify *and* a hash before its transaction, so its revoke
lands after the racing logins have already inserted, where the reset path pays only a hash and
lands before them. Neither path is protected by construction.

**What it costs to leave.** The reset endpoint exists to evict a party who knows the old password.
This is exactly the party positioned to exploit it: they know the credential, so they can hold
logins in flight. The victim completes the reset, receives `passwordChanged` saying *"Any other
sessions were signed out"* — which is false — and the attacker keeps a fully privileged session for
up to 30 days, renewed indefinitely while used. The `PASSWORD_RESET_COMPLETED` audit row records
`liveSessionsAtWrite` counted **before** the racing sessions exist, so an investigator reading the
table sees a number that does not include them.

The mitigation that exists is the `login` rate-limit class: 5 per 15 minutes per account. That
makes a targeted attempt expensive rather than impossible, and it is not a control anybody chose
for this purpose. It also does not bound the accidental case — a client with a retry in flight, or
a user signing in on a second device while resetting on a first.

**Grade.** High. `brief.md` §4 states the requirement as *"A login racing a completed reset must
not mint a session with the old password"*, and the shipped code does not meet it. The fix is on
the login path — the `Session` insert must be conditional on the credential that was verified —
and is correctly identified in the report as **owed and not built**. What is not acceptable as
shipped is (a) the size of the hole being under-reported by 5x in the only document that names it,
and (b) `password-reset.service.ts` asserting in code that the hole does not exist.
