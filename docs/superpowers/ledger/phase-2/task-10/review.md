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

## Findings

| | | |
|---|---|---|
| **H1** | High | A completed reset leaves every in-flight old-password login holding a live, fully privileged session for 7–30 days |
| **M1** | Medium | The reset's compare-and-swap is asserted only by a fake; deleting it leaves all 25 integration tests green |
| **M2** | Medium | Ruling 70's fifth channel — `invitation` renders a stored display name into the text part of a live-link message |
| **M3** | Medium | `change-password` has no per-account bound, no lockout and no notice, so it is a weaker guard on the password than `login` |
| **L1** | Low | `ownSessionRotated: true` is written before the rotation is attempted and can be false |
| **L2** | Low | The unit lane cannot honestly evaluate the mutation "delete the predicate" — the fake returns `count: 0` where Postgres would write |
| **L3** | Low | `reset-password` pays the breach check and a full Argon2id hash before it validates the token |
| **L4** | Low | "A reset for a user with no `Credential` row sets a password" is an SSO bypass in Phase 11, and only the benign half is written down |
| **L5** | Low | A completed reset proves mailbox control and does not record it |
| **L6** | Low | `audit.md` §4 describes `liveSessionsAtWrite` incorrectly for the change row |
| **L7** | Low | A completed reset does not clear `lockedUntil`, and no document says which remedy applies to which lock |
| **P1–P7** | prose | Seven false or unsupported sentences, four of them about H1, listed separately below |

**One High. Three Mediums. Seven Lows.** I found nothing at a level I have not listed: there is no
second High, and I say that having gone looking — the compare-and-swaps, the revocation scope, the
rotation, the enumeration comparison, the audit trail and the rate-limit class assertions were all
attacked and all held.

The work is of a materially higher standard than Tasks 8 and 9. The one structural failure is H1,
and the implementer found it, measured it and named it owed before anyone reviewed it. What makes
it a High rather than an accepted residual is not the hole but the four sentences shipped beside it
that say it is not there.

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

### L1 (Low) — `ownSessionRotated: true` is written before the rotation is attempted, and can be false

`password-change.service.ts` spends a paragraph explaining why `liveSessionsAtWrite` is not called
`sessionsRevoked` — *"a tidier name would be a false statement in an append-only table"* — and then
writes `ownSessionRotated: true` **inside the same transaction**, before `sessions.rotate()` is
called. `rotate` returns `null` when the caller's session was concurrently revoked, and the service
has a shipped test for exactly that case.

**Measured.** I added one `console.log` to the existing test `reports no token when the caller
session was concurrently revoked`, ran it, and reverted:

```
AUDIT METADATA = [{"liveSessionsAtWrite":0,"ownSessionRotated":true}]
```

Nothing was rotated. The append-only row says it was. It is a boolean predicting a step that has
not run yet — precisely the shape the same file rejects two fields earlier. Nothing asserts the
field in either lane, so this is invisible to the suite. Cost: one false fact in the table an
investigation reads, in the rarest and most interesting case.

### L2 (Low) — the unit lane cannot honestly evaluate the mutation "delete the predicate"

`identityStoreFake`'s `swapCredential` compares `stored !== where.passwordHash`. With the predicate
removed from a call site, `where.passwordHash` is `undefined` and the fake returns `count: 0` —
where real Postgres would update the row. So the mutation makes every credential write **refuse**
rather than **succeed twice**.

**Measured.** Deleting the reset's predicate turned **7** unit tests red in
`password-reset.service.spec.ts`, and none of them was `refuses when the credential moved under
it`; the concurrency test passed, because it expects a refusal and got one for the wrong reason.
That is ruling 66's trap in a new place: before believing a red, check which failure it is
observing.

This is not a defect in shipped code. It is a hazard for the next round: an implementer or reviewer
running the obvious mutation against the unit lane will see a satisfying wall of red that proves
nothing about concurrency. The honest unit-lane mutation is "re-read the credential inside the
transaction and predicate on that", which turns exactly the one concurrency test red on all three
sites — that is the form I used, and all three bit.

### L3 (Low) — `reset-password` pays the breach check and a full Argon2id hash before it validates the token

`PasswordResetService.reset` runs `breachCheck.isBreached`, then `passwords.hash` (~40 ms here,
ADR-0014 targets ~250 ms in production), and only then opens the transaction that consumes the
token. So a caller submitting a token that was never issued still buys a full Argon2id hash, and an
outbound HIBP request when the check is enabled.

The ordering is deliberate and the *reason* is good (a 422 must not cost the user their link), and
`rate-limit.config.ts` explicitly reasons about the unit of work when setting 20/hour per IP — so
this is considered, not overlooked. What is not written down anywhere is that the expensive half is
bought **before** any authentication of the input, which is what makes the per-IP figure the whole
control. Worth a sentence in `abuse-prevention.md` §1 beside the figure.

### L4 (Low) — "a reset for a user with no `Credential` row SETS a password" is defensible today and is an SSO bypass tomorrow, and only the first half is written down

The implementer names this decision and its cost as "one branch to reverse". The direction of the
risk is not named. A `User` with no `Credential` row is, by the code comment's own account, what an
SSO-only account will look like when Phase 11 lands. Allowing an emailed link to *create* a
password credential on such an account means email possession becomes a second authentication path
on an account an operator may have deliberately restricted to an identity provider. That is not a
one-branch preference; it is a policy question Phase 11 has to answer, and the comment currently
reads as though the only cost of the other choice is stranding somebody.

### L5 (Low) — a completed reset proves mailbox control and does not record it

`reset()` writes the credential, counts sessions, audits and revokes. It does not touch
`emailVerifiedAt`. An account that registered, never confirmed, and then completed a reset has
demonstrably proved mailbox control — that is the stated justification for sending it a link at all
— and is still `emailVerifiedAt: null` afterwards, so it goes on being excluded from the things
verification gates (the unfamiliar-sign-in notice, for one). Either behaviour is arguable; neither
is written down.

### L6 (Low) — `audit.md` §4 describes `liveSessionsAtWrite` incorrectly for the change row

`.claude/security/audit.md` §4 says both rows carry *"the number of sessions that existed at the
instant the new credential committed"*. On the reset path that is exactly right. On the change path
the query is `{ userId, revokedAt: null, id: { not: command.sessionId } }` — the caller's own
session is excluded, deliberately, with a test pinning it (`counts the OTHER sessions, excluding
the one being rotated`). The document is off by one for that row, and the field carries the same
name in both. The code is right and the document is wrong.

### L7 (Low) — a completed reset does not clear `lockedUntil`

The ladder's temporary lock is `User.lockedUntil` and is independent of `User.status`, so an
account that is `ACTIVE` but currently locked receives a reset link (D4 only refuses non-`ACTIVE`
statuses), completes the reset, and then still cannot sign in: `login` reaches
`isLocked(user.lockedUntil, now)` before it looks at anything else and answers `ACCOUNT_LOCKED`
with the correct new password. The behaviour is self-resolving within the lock window and the
refusal message no longer promises that a reset helps (ruling 76 removed that), so this is a Low —
but no document states which of the two remedies actually applies to which kind of lock.

---

## False or unsupported sentences in prose

Separated from the code defects above, per the brief.

### P1 — `password-reset.service.ts:342-344` asserts in code that H1 does not exist

```
// AFTER THE COMMIT, AND THAT ORDERING IS D2. The new hash is durable before
// a single session is revoked, so there is no window in which the old
// password can mint a session that the revocation has already passed over.
```

Written by this task, in this task's own new file, and measured false by this task in the same
sitting. The implementer found the residual, wrote it into `security/authentication.md` §6 and into
the integration test's docblock, and left the flat contradiction standing in the service. This is
ruling 11's propagation shape with the propagation already inside one commit range.

### P2 — `security/authentication.md` §6 under-reports H1 by a factor of five

> Measured through the real application: five old-password logins fired alongside a reset left
> **one live session** behind.

Re-measured: **five of five, in five consecutive rounds** (and 3–4 of 5 with `rememberMe: true`).
The sentence is doing load-bearing work — it is what makes the residual sound like a narrow
straggler rather than "every login in flight survives" — and it is the only figure any reader will
have. The paragraph beside it, *"under write-then-revoke it is only a login whose verification
straddles the few milliseconds between the commit and the revocation"*, is the same understatement
restated: the straddle interval is one Argon2id verification wide, not a few milliseconds, and it
grows with the security parameter.

### P3 — `session.service.ts:695` still carries the original overstatement, uncorrected and unmarked

> A password change must write the new hash **before** calling this, so that a racing login cannot
> mint a session with the old credential once this call has finished. Task 10 owns that ordering

`git diff cfc0cb7..HEAD -- apps/api/src/modules/auth/session.service.ts` is **empty**. Task 10 is
the task that owned this ordering, discovered the sentence was wrong, and did not touch the file
that says it. Ruling 53 set the precedent for a claim that cannot be edited in place — carry the
correction elsewhere *and name the pointer at the site*. Nothing at this site points anywhere.
Carry-forward ruling 51 carries the same overstatement in `progress.md` and should move with it.

### P4 — `api/authentication.md` §9 states the revocation without the residual

> completing a reset revokes **every** session, including any the caller happened to hold

True of every session that exists when the credential commits, and untrue as a flat statement (H1).
`security/authentication.md` §6 carries the qualification and this document does not point at it.
The same sentence appears in the `reset-password` controller docblock and in the OpenAPI
`description` shipped to clients — *"replaces the password, and signs every session out"* — which
is the one copy of it a customer reads.

### P5 — `registry.spec.ts`: "OVER THE WHOLE REGISTRY, WITH NO EXEMPT LIST"

The block under that heading iterates `NOTICE_TEMPLATE_IDS`, and `ATTACKER_STRING_TEMPLATE_IDS` is
an exempt list with one member. See M2. The implementer's report is more accurate than the code
comment here: report §"Things in the brief I found false or incomplete" item 4 says plainly that
the prescribed test "is not literally satisfiable in one shape". That is right, and the correct
conclusion was to run the hostile payload at `invitation` in the token-link block, not to leave it
the only template never attacked.

### P6 — `identity-fakes.ts`: the integration probe it names does not cover the reset

> `auth.password.integration.spec.ts`'s parallel probe owns that against real Postgres

True for `change-password`, false for `reset-password`. See M1.

### P7 — carry-forward ruling 70: "the invitation, which already names nobody"

Pre-existing rather than this task's, but Task 10 is the task that closes ruling 70 and therefore
the last moment anyone would have checked it. `renderInvitation` names the inviter. See M2.

### Checked and found sound

These were candidates and did not survive contact with the tree, and I am recording them so nobody
re-opens them:

- **The implementer's finding 1** (the concurrent change probe that was green for the wrong reason)
  reproduces exactly as described. Deleting the change predicate now turns
  `LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT` red.
- **`reset-password` sets no cookie** is not merely a docblock claim: `expect(setCookies(response))
  .toEqual([])` pins it, and adding a `Set-Cookie` to the handler turns that test red (measured).
- **Ruling 64** is satisfied — the three new handlers, their rate-limit classes, their access kind
  and their `@RefuseCrossSite()` state are asserted on the real controller with an exhaustiveness
  test.
- **Rotation on change** is fully covered: the successor is live, the caller's pre-rotation cookie
  answers 401, the other session answers 401, and the CSRF cookie is re-derived.
- **Every ruling number cited by a line this task added checks out.** `git diff cfc0cb7..HEAD |
  grep '^+'` cites rulings 3, 6, 9, 11, 21, 22, 24, 28, 29, 31, 37, 44, 45, 51, 55, 56, 58, 59, 62,
  64, 65, 68, 70, 71, 72, 73, 74, 75, 77 and 78 — thirty of them. I opened every one in
  `progress.md`, and each says what the citing comment says it says. That is a first for this range:
  ruling 11 exists because a phrase attributed to a document that contained no such string reached
  a comment, and nothing of that kind is here. The two false sentences I did find (P1, P6) are
  claims the author made in their own words, not misquotations.
- **Enumeration.** `forgot-password`'s byte comparison covers unknown / unverified / verified /
  `LOCKED`, with an anti-vacuity test proving the three paths really differ in the mailbox and the
  audit table. `reset-password`'s refusals are compared with the `requestId` substituted (ruling 77
  applied correctly, and the choice between the two comparison kinds is argued rather than
  assumed). The paths not compared are `expired` and `superseded`, which share the `consumed ===
  null` branch with `unknown`, and a user row with no `Credential` — none of which reaches a
  different code or message. I found no enumeration path the comparison misses.

---

## Verification I ran

Every row re-run on this tree, exit code captured outside a pipe. All eleven reproduce the
implementer's evidence table exactly.

| Command | Exit | Output |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **83 files, 1348 tests** |
| `pnpm check:specs` | 0 | 102 spec files, each claimed by exactly one project |
| `pnpm test:integration` | 0 | **19 files, 317 tests**, 145 s |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 13`, byte-identical |
| `pnpm check:registry` | 0 | 15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm check:secrets` | 0 | 388 tracked files |
| `docker compose ps` | 0 | four services `Up (healthy)` |

`git diff --stat cfc0cb7..HEAD` is **empty** for `apps/web`, `packages/ui` and
`packages/db/prisma/migrations`, so the missing `test:e2e` row and the "no migration" claim are
both correct.

### Mutations

Rows marked *reproduced* are the implementer's, re-applied and re-reverted by me.

| | Mutation | Result | |
|---|---|---|---|
| A | render `ipAddress` raw | RED ×12 in `registry.spec.ts` | reproduced |
| B | remove the reset's revocation | RED ×4 | reproduced |
| C | defeat the reset CAS by re-reading inside the transaction | RED ×1 — `refuses when the credential moved under it` | reproduced |
| D | drop `exceptSessionId` on change | RED ×1 | reproduced |
| E | remove the denial audit row | RED ×1 | reproduced |
| F | defeat the rehash CAS by re-reading | RED ×1 — `writes it under a COMPARE-AND-SWAP on the hash it verified` | reproduced |
| G | make the rehash rethrow | RED ×2 | reproduced |
| H | delete the change CAS predicate entirely | **RED** — `LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT` | reproduced post-fix |
| **C2** | **delete the reset CAS predicate entirely** | **integration GREEN 25/25**; unit RED ×7, none of them the concurrency test | **new — M1, L2** |
| H2 | defeat the change CAS by re-reading inside the transaction | unit RED ×1, integration GREEN | new |
| I | make `reset-password` set a `Set-Cookie` | integration RED | new — the no-cookie decision is pinned |
| J | racing-login probe: 5 old-password logins in one `Promise.all` with a reset | 25 of 25 sessions survived, all authenticating | **new — H1** |
| K | racing-login probe against `change-password` | 0 of 16 survived | new — timing, not structure |

The tree was restored after every mutation. `git status --porcelain` is empty apart from this file.

---

## What I could not check

- **The timing figures in `security/authentication.md` §6** (25 samples per case, 11.4 / 11.7 /
  14.1 ms medians). I did not re-run the measurement. They remain the implementer's claim; the
  qualitative point they support — that the ranges overlap where the resend's did not, and that an
  in-memory mailer understates the production gap — is sound on inspection of the code path.
- **`pnpm test:e2e`.** Not run. Correctly has no row: the `apps/web` and `packages/ui` diffs are
  empty, which I verified.
- **Whether `organizationName` can inject an SMTP header through the invitation subject line.** The
  subject is `You have been invited to ${organizationName} on Sentinel` and the registry's subject
  test asserts only `length > 0`. Not exercised, because nothing sends this message; it belongs
  with M2 in Task 15.
- **Production Argon2id cost.** The ~250 ms figure I use in H1's window argument is ADR-0014's
  target, not something I measured. The harness runs at reduced parameters.
- **Behaviour under a real SMTP relay.** The harness mailer is in-memory, so nothing here observes
  what a send failure or a slow relay does to any of these paths.
