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

### M1 (Medium) — the reset's compare-and-swap is asserted only by a fake, and the integration probe its own comment points at does not cover it

D3 puts a compare-and-swap on all three credential writes. Two of them are held by a real
two-request test. The reset's is not.

**Measured.** Predicate removed at `password-reset.service.ts` (`where: { userId: user.id,
passwordHash: existing.passwordHash }` becomes `where: { userId: user.id }`), then the whole
password integration file re-run:

```
pnpm vitest run --project integration apps/api/src/modules/auth/auth.password.integration.spec.ts
INTEGRATION EXIT=0    Test Files 1 passed (1)    Tests 25 passed (25)
```

All 25 integration tests stay green with the reset's compare-and-swap deleted. The only test that
sees it is a unit test driving `identityStoreFake`'s `replaceCredentialAfterRead` flag, and that
flag's own docblock says:

> **It fakes the TIMING of the sibling's write, never the arbitration of it.** … there is no lock
> here and no second caller. `auth.password.integration.spec.ts`'s parallel probe owns that against
> real Postgres, and nothing set through this flag may be read as evidence for it

That sentence is true of `password-change`: `LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT` does
own it, and I confirmed it bites (see the mutation table below). It is **false of the reset**. The
only parallel reset probe is `lets EXACTLY ONE of two parallel redemptions of the same token
succeed`, which is arbitrated entirely by `TokenService.consume`'s conditional `UPDATE` and reaches
the credential predicate on one branch only. There is no second caller in any lane for the reset's
predicate.

The race that predicate exists for is a reset against a concurrent `change-password` or the rehash:
a session thief's password change landing between the reset's read and its write. I tried to force
it (`reset-password` and `change-password` in one `Promise.all`, four rounds) and the *change* lost
every time on its own predicate, so I could not produce the interleaving that would exercise the
reset's. That is the point — nothing in this repository can currently observe whether the reset's
predicate works.

**Cost if left.** Exactly ruling 74's cost, one endpoint over from where it was paid last time: a
control that reads correct, carries a comment saying a real probe owns it, and would be deleted by
a refactor with the whole eleven-command gate green.

### M2 (Medium) — the fifth channel: `invitation` renders a stored display name into a message carrying a live link

The brief told me to assume a fifth channel for ruling 70. There is one, and it is in the registry
this task declared closed.

`token-link.templates.ts`'s `renderInvitation` takes `inviterName` and `organizationName` and
renders both. `inviterName` is a stored `User.name` — the same 200 characters of free text ruling
70 is about — and it reaches a recipient who chose none of it, in a message carrying a **live token
link**, which is the property that made `passwordReset` "the sharpest instance in the codebase".

**Measured**, rendering the shipped module with a hostile inviter name:

```
--- TEXT ---
You have been invited to Acme on Sentinel

Sam <script>x</script> https://evil.example/login?token=abc has invited you to join Acme on Sentinel.
...
Accept the invitation: https://app.sentinel.test/accept-invitation?token=FIXTURE_...
```

The HTML part escapes it, and the escaping test covers that. The **text** part does not, and mail
clients autolink a bare URL in a `text/plain` part — which is precisely how Task 8's H1 and Task 9's
H2 were rendered.

**Why the suite does not see it.** `registry.spec.ts` has two ruling-70 blocks and neither reaches
this:

- `describe.each(IDS)('template %s under ruling 70')` runs over the whole registry but passes
  `{ ...BENIGN, name: XSS_WITH_URL }`. Only the **recipient's** name is hostile; for `invitation`,
  `inviterName` and `organizationName` stay at their benign fixtures.
- `describe.each(NOTICE_TEMPLATE_IDS)('notice %s under ruling 70 prescribed payload')` passes the
  fully `HOSTILE` fixture, but runs over `NOTICE_TEMPLATE_IDS` only — and `invitation` is a
  token-link template.

So the one template in the registry that actually renders caller-supplied text is the one template
the hostile-everything payload is never run against. Carry-forward ruling 58's family again: every
fixture on one side of the branch under test. The docblock over the second block says the test now
runs "OVER THE WHOLE REGISTRY, WITH NO EXEMPT LIST"; it runs over the notices, and
`ATTACKER_STRING_TEMPLATE_IDS` is an exempt list with one member in it.

**What is genuinely true, and should be said instead.** No template renders the **recipient's**
stored display name. That is what the implementer's report claims, in those words, and it holds.
D1's list (`passwordReset`, `passwordChanged`, `mfaEnabled`, `mfaDisabled`) is complete, the field
is gone from the context types, and `pnpm typecheck` is therefore the control. The residual test
**was deleted rather than adjusted** — confirmed in the diff — and its replacement states in its own
docblock that the typecheck is the real control rather than implying the assertion bites. That part
of D1 is done properly, and more honestly than the previous two attempts at this ruling.

**Cost if left.** `invitation` has no caller until Task 15, and ruling 71's own lesson is that
"safe because it has no caller yet" is the sentence that shipped H2. Ruling 70 as written in
`progress.md` says it "Binds Task 15 for the invitation, **which already names nobody**" — that
clause is false, and closing ruling 70 now removes the pressure that would have caught it. Medium
rather than High only because nothing sends this message today.

### M3 (Medium) — `change-password` is a better password-guessing oracle than `login`, and nothing bounds it per account

One of the eight decisions the brief left to the implementer, and the load-bearing one.
`password-change.service.ts` deliberately keeps the endpoint out of the lockout ladder. The
argument given is sound as far as it goes: `ACCOUNT_LOCKED` on an authenticated route would be a
distinguishable outcome, and a caller who could lock an account with a stolen session could deny
service. What is not stated is what the endpoint is left with by comparison.

| | account fixed by | per-account bound | lockout | owner notified |
|---|---|---|---|---|
| `POST /auth/login` | the body's `email` | **5 / 15 min** | yes, ladder and `ACCOUNT_LOCKED` | `failedLoginBurst` on the lock |
| `POST /auth/change-password` | the session cookie | **none** | no | **no message at all** |

`passwordChange` is `perIp: { limit: 10, windowSeconds: 3600 }` and nothing else, and
`rate-limit.config.ts` says plainly why the per-principal half cannot be declared today (ruling 55:
the limiter runs before the authentication guard). So for an attacker holding a stolen session the
per-account guess budget is 5 per 15 minutes at `/auth/login` and **unbounded by account** at
`/auth/change-password`, bounded only by how many source addresses they have. Neither the ladder
nor the burst notice fires, so the account owner learns nothing at all. The documented compensating
signal is the `PASSWORD_CHANGE_FAILED` audit row, and nothing reads `PlatformAuditEvent` until
Phase 3's `/audit-logs`.

Confirmed by the shipped test `does NOT touch the lockout ladder`: six wrong current passwords
leave `failedLoginCount` at 0 and `lockedUntil` null.

**Cost if left.** The endpoint that requires a session in order to prove a password is a weaker
guard on that password than the endpoint that requires nothing. It is reachable only with a stolen
session, which is what keeps this Medium rather than High — but a stolen session is the exact
premise the endpoint's own docblock argues from. Per-account throttling here needs neither the
ladder nor `ACCOUNT_LOCKED`: a 429 keyed on the resolved principal would do it, and it is the same
owed limiter stage rulings 55 and 59 already want.
