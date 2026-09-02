# Task 11 review — TOTP MFA and recovery codes

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a fresh adversarial reviewer on 2026-09-02. Range `cc81494..9953d77` on
`feat/phase-2-task-11`. **Nothing was fixed.** Every mutation used to prove a defect was reverted
and the output from both states is pasted below; `git status --porcelain` is clean apart from this
file. The migration was not applied and `db:migrate` / `migrate reset` were never run.

> The review brief's own header names the range `cc81494..9513d97`; `HEAD` is `9953d77`, which is
> the review brief's own commit. Immaterial, recorded because sentence accuracy is what this branch
> is being audited for.

---

## Findings index

| # | Severity | Claim |
|---|---|---|
| H1 | **High** | Two concurrent `POST /auth/mfa/recovery-codes` leave **20** live recovery codes, and `spendRecoveryCode`'s unordered `take: 10` makes **ten of the twenty codes the API returned with a 200 permanently unusable**. Measured: `setA[0]` and `setA[9]` refused 401, `setB[0]`/`setB[9]` accepted 200. |
| M1 | Medium | Two concurrent `POST /auth/mfa/enroll` answer **`500 INTERNAL_ERROR`** — the ruling-7 P2002 the task was written to close, moved from the sequential path to the concurrent one and left unhandled. |
| M2 | Medium | The report's headline D4 measurement (`survivors=25 refusals=0` / `0`/`25`) **cannot be reproduced from the repository**: the 25-round probe is not committed and the committed "credential race (D4)" tests race nothing. |
| M3 | Medium | The `mfa/verify` refusal is claimed to be indistinguishable across every failure mode; **measured, it is distinguishable by ~100× latency** whenever the submitted code is recovery-shaped — a dead/locked pending session answers in 3–4 ms where a live one costs a full recovery-code scan. The code comment asserting indistinguishability is false. |
| M4 | Medium | Gap 2 (regeneration sends no email) is **undersized as a deferral**. It is the one MFA state change with no notice, and it is the change that makes the owner's printed break-glass credential dead. |
| M5 | Medium | The arithmetic justifying `mfaVerify`'s 60/hour — "one expected success every **630 years** from one address" — is **wrong by a factor of 1000**. The correct figure from the same premises is **0.63 years**. It appears in the rate-limit class comment and in `abuse-prevention.md` §1. |
| M6 | Medium | `security/authentication.md` §5 and `.env.example` state that MFA key rotation is "**incremental and resumable**". It is not built: the process holds exactly one key and `decryptMfaSecret` refuses every version but `1`. An operator who rotates the key on the strength of that sentence bricks every enrolled factor. |
| L1 | Low | `auth.mfa.integration.spec.ts:47-50` states `GET /auth/session` with a pending token "**nothing has ever tested**". It was tested at `cc81494` in two places. The false sentence originates in the orchestrator's brief §4. |
| L2 | Low | `auth.mfa.integration.spec.ts:38-41` states "**The replay probes use ONE pending session**" and gives a ruling-87 rationale for it. Both replay probes use **two** pending sessions, and the test's own docblock 30 lines lower says so. |
| L3 | Low | `report.md` describes the migration as "**42 lines of reasoning with the first executable statement on line 44**". The file is 43 lines: 40 lines of comment, blank, `-- AlterTable`, and the `ALTER TABLE` on **line 43**. |
| L4 | Low | `refuses the code that CONFIRMED the factor, at the very next request` is **time-boundary flaky** — observed red once in four otherwise identical runs, on a step rollover between `enableMfa` and the test's `codeFor(secret)`. |
| L5 | Low | `MfaEnrolmentService` selects `emailVerifiedAt` at three sites and uses it at none, while `MfaVerificationService` gates its notice on it. One of the two is wrong and nothing says which. |
| L6 | Low | `spendRecoveryCode`'s `findMany` has `take: 10` and **no `orderBy`**, so which ten rows a security control examines is left to Postgres. |
| L7 | Low | ADR-0018's Consequences section says the `rememberMe` gap "is recorded here, in `security/authentication.md` §5, and in Task 11's report". §5 does not mention it; the record is in `api/authentication.md` §2. |
| L8 | Low | Both `report.md` ("pre-existing defects found, **not fixed**") and the orchestrator's own re-verification assert in the present tense that `audit.md`'s ADR-0019 link is broken. It was fixed in the same commit that ships both sentences. |

Sizing verdicts on the six declared gaps, and the false/unsupported-sentence register, are in their
own sections below.

---

## H1 — Concurrent regeneration issues twenty recovery codes and silently kills ten of them

**What is wrong.** `MfaEnrolmentService.regenerateRecoveryCodes` runs
`deleteMany({ userId })` then `createMany(ten)` inside one interactive transaction. Prisma runs
interactive transactions at Postgres READ COMMITTED, so a second concurrent regeneration's
`deleteMany` takes its snapshot before the first transaction's `INSERT`s are visible: it deletes the
*old* set, waits on nothing it can see, and inserts its own ten. Both commit. The account now holds
twenty live `RecoveryCode` rows.

That alone would be untidy. What makes it a defect is the consumer:

```ts
// mfa-verification.service.ts:283-288
const stored = await this.store.recoveryCode.findMany({
  where: { userId, usedAt: null },
  select: { id: true, codeHash: true },
  take: RECOVERY_CODE_COUNT,   // 10 — and no orderBy
});
```

With twenty unused rows, ten of them are never loaded and therefore can never verify. The user was
shown both sets in two `200 OK` responses.

**The measurement.** Temporary probe `zzz-review-probe.integration.spec.ts` (deleted after the run;
`git status` is clean), against the real app, real Postgres, real Redis:

```
PROBE2 statuses= [200,200] liveCodes= 20
PROBE2 verify setA[0] -> 401
PROBE2 verify setB[0] -> 200
PROBE2 verify setB[9] -> 200
PROBE2 verify setA[9] -> 401
```

Two codes the API handed the account owner with a 200 were refused at `mfa/verify`. (An earlier run
of the same probe returned 200 for `setA[0]` and `setB[0]` — the outcome depends on which ten rows
the unordered `findMany` happens to return, which is L6.)

**Cost if it ships.** The recovery set is the break-glass credential — it is used exactly when the
user has lost their phone. A double-click on "Regenerate codes" in Task 17's UI, or a retried
request, hands the owner a printout that may be entirely dead, and they find out at the one moment
they cannot recover any other way. There is no endpoint that reads codes back, so the failure is
undiagnosable from the product.

**Recommended disposition.** Fix. The cheap form is the device this codebase already uses twice for
exactly this shape: take a per-user `pg_advisory_xact_lock` at the top of the transaction (carry-forward
ruling 84's mechanism, already used in `recordFailure` one file over). Independently, `findMany`
should carry an `orderBy` and the `take` should not be able to hide rows — or the invariant "at most
ten live codes per user" should be expressed in the database. `confirm()` has the same
delete-then-create shape but is protected by its `confirmedAt: null` compare-and-swap, so only
`regenerateRecoveryCodes` is exposed.

---

## M1 — Two concurrent enrolments answer 500

**What is wrong.** `enroll` does `deleteMany({ userId, confirmedAt: null })` then `create(...)`
inside a transaction. `MfaFactor` carries `@@unique([userId, type])`. Two concurrent enrolments
both find nothing to delete, and the loser's `create` raises Prisma `P2002` on the unique index.
Nothing in `mfa-enrolment.service.ts` catches it — the only `P2002` handling in the auth module is
`identity.store.ts:361`, which this service does not use — so it reaches the global filter as an
unhandled error.

Carry-forward ruling 7 is the reason this task exists at that line; the fix moved the P2002 from the
sequential path to the concurrent one rather than removing it.

**The measurement.** Same probe:

```
PROBE1 statuses= [500,200]
bodyA= {"error":{"code":"INTERNAL_ERROR","message":"Something went wrong on our side. Quote the request ID if you contact support.","requestId":"req_01M1FQSFF1F8SSVJWAXMAP969T"}}
bodyB= {"secret":"CC3CSNCJUN7JCDM7KXCY4DUZ3JN6U5NV","otpauthUri":"otpauth://totp/Sentinel:probe-1-...@example.test?secret=...&issuer=Sentinel&algorithm=SHA1&digits=6&period=30"}
PROBE1 factors= 1
```

**Cost if it ships.** No data corruption — one factor row survives, and the surviving row is
unconfirmed, so nothing is enabled. What ships is a 500 on a user-facing authenticated route,
reachable by an ordinary double-click, in violation of the "errors use the shared error envelope"
rule. It also produces a Sentry page for a condition that is not an outage.

**Recommended disposition.** Fix — either catch `P2002` and retry once (the delete-then-create is
idempotent from the caller's point of view), or serialise on a per-user advisory lock as H1 needs
anyway, or make the create an upsert keyed on `(userId, type)` guarded by `confirmedAt: null`. Low
cost; the review brief named "concurrent enrolments" explicitly and no committed test covers it.

---

## M2 — The report's D4 survivor measurement is not reproducible from the tree

**What is wrong.** `report.md` presents this as the D4 proof:

```
check disabled:  D4 PROBE: survivors=25 refusals=0  of 25
check enabled:   D4 PROBE: survivors=0  refusals=25 of 25
after revert:    D4 PROBE: survivors=0  refusals=25 of 25
```

That probe is not in the repository. `grep -rn "D4 PROBE" apps packages` returns nothing. What is
committed is `describe('the credential race (D4)')`, two tests, **neither of which races anything**:
both write the credential to completion and *then* issue one `mfa/verify`. The docblock is candid
that it "isolates the PREDICATE rather than the revocation" — but the report presents a
25-of-25 concurrency number, in the register Task 10's High was accepted in, for a probe a reviewer
cannot re-run.

**The measurement.** I mutated the shipped code twice instead, which is what the tree does support.

Disabling the check (`if (false && !(await this.credentialStillCurrent(pending)))`):

```
MUTATION_F_EXIT=1
   × the credential race (D4) > refuses the promotion when the password was replaced after the pending session was created  834ms
     → expected 200 to be 401 // Object.is equality
   ✓ the credential race (D4) > stands when the credential row moved for a rehash rather than a replacement  744ms
```

Reducing the predicate to the timestamp alone (deleting the `PlatformAuditEvent` second stage), which
is ruling 83's other half:

```
MUTATION_G_EXIT=1
   ✓ the credential race (D4) > refuses the promotion when the password was replaced after the pending session was created  765ms
   × the credential race (D4) > stands when the credential row moved for a rehash rather than a replacement  760ms
     → expected 401 to be 200 // Object.is equality
```

Both mutations reverted; the suite is green again (see the verification table). So **both stages of
the predicate are load-bearing and both have an advocate** — that part of the report is true and I
verified it. What is unsupported is the 25-of-25 number and the word "race".

**Cost if it ships.** The predicate is real and tested. The cost is to the ledger: a number in the
register the phase reserves for measured concurrency results, attached to sequential tests, is
exactly the class of sentence rulings 82/83/88 exist to stop.

**Recommended disposition.** Either commit the 25-round probe (the shape ruling 88 approves: assert
what holds every round, and say in the docblock what deleting the predicate does *not* turn red), or
rewrite the report's D4 paragraph to say plainly that the survivor counts came from a throwaway probe
and that the committed tests are sequential predicate tests. Renaming the `describe` block would
also help.

---

## M3 — The refusal is uniform in bytes and not in time, and the comment says otherwise

**What is wrong.** `mfa-verification.service.ts:163-167`:

> ONE REFUSAL FOR EVERY WAY THE TOKEN CAN BE WRONG. Unknown, expired, revoked and "resolved but not
> pending" are indistinguishable to the caller — a caller holding a token that was never issued must
> not be able to learn that one that WAS issued has merely expired.

The bytes are indistinguishable. The latency is not. `resolve()` fails before any Argon2 work, so a
dead pending token costs one Redis/Postgres read; a **live** pending token with a recovery-shaped
code costs ten Argon2id verifications by construction (`findMatch`'s padding, which is the control
D7 added on purpose).

**The measurement.** All eight refusal modes, real app, at the harness's reduced Argon2 parameters:

```
PROBE3 unknown-token/6-digit    status=401 ms=5   code=MFA_INVALID
PROBE3 unknown-token/10-symbol  status=401 ms=4   code=MFA_INVALID
PROBE3 wrong-TOTP               status=401 ms=11  code=MFA_INVALID
PROBE3 wrong-recovery           status=401 ms=370 code=MFA_INVALID
PROBE3 spent-recovery           status=401 ms=399 code=MFA_INVALID
PROBE3 replayed-TOTP            status=401 ms=10  code=MFA_INVALID
PROBE3 locked-session/6-digit   status=401 ms=3   code=MFA_INVALID
PROBE3 locked-session/10-symbol status=401 ms=3   code=MFA_INVALID
```

Every body is byte-identical apart from `requestId` — the enumeration property the task claims is
real and I confirmed it. But `wrong-recovery` (370 ms) against `locked-session/10-symbol` (3 ms) is a
**123× separation on the same submitted code shape**, and it widens, not narrows, in production:
ADR-0014's parameters put the recovery scan at ~2.5 s against the same ~3 ms.

So the caller *can* learn "this pending session is dead" versus "this pending session is live",
which is precisely the distinction the comment says is unavailable. It is also the distinction that
tells an attacker the five-attempt lock has fired — the lock's own refusal is otherwise deliberately
indistinguishable.

**Cost if it ships.** Low in isolation: reaching a live pending session already requires the
password, and learning that a token is dead saves the attacker only wasted requests. The cost that
matters is the false sentence in the file that is the security control, in a phase that has now
found twelve of those.

**Recommended disposition.** Do not add padding to `resolve` — a full Argon2 scan on every unknown
token would hand an unauthenticated caller a 2.5 s CPU cost per request, which is worse (and see
gap 4). Correct the comment to say what is true: *the refusals are byte-identical; the recovery-code
path is not constant-time relative to the token-resolution path, and the residual is
"is this token live", not "which account" or "how many codes are left".* Record it in
`security/authentication.md` §5 alongside the two oracles already named there.

---

## M4 — Gap 2 (regeneration sends no notice) is undersized

The report lists this as one of six declared gaps and reasons that adding an eighth template is a
Task 5 registry change (ruling 43). The deferral is honest and the ruling is real. The *sizing* is
what I disagree with.

Of the four state changes MFA has, three notify the owner: enable, disable, and (via D9) a completed
challenge from a new device. The fourth — regeneration — is the only one that **destroys a
credential the owner is holding on paper**, and it is the one an attacker with a stolen session plus
the password would choose, precisely *because* it is silent: disable sends mail and flips the login
arm the owner will notice next time; regeneration changes nothing the owner can see until the day
they need a code.

`auth.controller.ts`'s own OpenAPI description for the route says "from a stolen session it is a way
to make the account's break-glass credential be one the attacker holds" — the code already knows the
threat model and then ships no detection for it.

**Recommended disposition.** Not necessarily fix-in-this-round: reusing `mfaEnabled` would be a
false statement and the eighth template genuinely belongs to a registry change. But it should be
carried as an **owed defect with a named owner**, not as a cosmetic gap, and
`security/authentication.md` §5 should say that regeneration is unnotified. Compare ruling 43, which
says the next template added is the eighth and *no task owns it* — that is exactly the state in which
this gap never gets closed.

---

## Low findings

### L1 — "nothing has ever tested" is false

`apps/api/src/modules/auth/auth.mfa.integration.spec.ts:47-50`:

> **`GET /auth/session` with a pending token**, which `api/authentication.md` §2 has promised answers
> 401 `MFA_REQUIRED` since Phase 2 Task 7 and which nothing has ever tested.

It was tested before this branch existed:

```
$ git show cc81494:apps/api/src/modules/auth/auth.login.integration.spec.ts | grep -n "pending session cannot reach GET /auth/session"
764:  it('the pending session cannot reach GET /auth/session', async () => {
```

and again at the guard layer in `apps/api/src/common/guards/authentication.integration.spec.ts:179`
(`refuses a PENDING_MFA session everywhere except the route that allows it`). The sentence came from
the orchestrator's brief §4 — *"which `api/authentication.md` §2 already promises and nothing has
ever tested"* — and the implementer copied it into committed source. **The brief is the origin.**

Disposition: correct the spec docblock; correct the brief's record.

### L2 — "The replay probes use ONE pending session" is false, and the rationale attached to it is backwards

`auth.mfa.integration.spec.ts:38-41` says the replay probes use one pending session, citing ruling
87. The probe at line 625 opens two:

```ts
const a = await pendingLogin(email);
const b = await pendingLogin(email);
```

and its own docblock at line 601 says so explicitly — *"TWO CONCURRENT REQUESTS, ON TWO SEPARATE
PENDING SESSIONS."* Two is also the **correct** choice: with one pending session the loser would be
refused by `SessionRepository.rotate`'s compare-and-swap on `revokedAt`, which would mask the replay
predicate entirely — the file header states the opposite reasoning and reaches the opposite
conclusion from the code beneath it. Two contradictory sentences about a ruling-87 property, in one
file, is the shape ruling 87 was written about.

Disposition: correct the header.

### L3 — The migration's line count is wrong in the report

`report.md:38-39`: "42 lines of reasoning with the first executable statement on line 44."

```
$ wc -l < packages/db/prisma/migrations/20260901185059_mfa_factor_last_accepted_step/migration.sql
43
```

Lines 1–40 are comment, 41 is blank, 42 is `-- AlterTable`, 43 is the `ALTER TABLE`. So it is 40
lines of reasoning and the first executable statement is line 43 — and the file has no line 44.

The SQL block pasted in the report **is** byte-identical to the file (`diff` exit 0), which was the
load-bearing half of the claim, so this is a wrong number rather than a wrong artefact. It is
recorded because the brief asked for the class.

### L4 — A time-boundary flaky test

Under mutation C (widened `UPDATE` predicate) the first run produced:

```
   × POST /auth/mfa/verify — the replay defence (D6) > refuses the code that CONFIRMED the factor, at the very next request  636ms
     → expected 200 to be 401 // Object.is equality
```

Three immediately following runs of the same test under the same mutated code were green, and the
unmutated baseline is green. The mutation cannot reach this test (the in-memory floor refuses the
replay before the `UPDATE` is issued, which is exactly what the mutation matrix says). The mechanism
is the test's own timing: `enableMfa()` confirms server-side at step `N`, and the test then computes
`confirmingCode = codeFor(secret)` locally. If the 30-second step rolls over in between, the "replay"
is a code for step `N+1`, which is legitimately accepted — 200 where the test asserts 401.

Cost: a red CI run at roughly (time between confirm and `codeFor`) / 30 s, on a spec whose entire
subject is the replay defence, which is the worst possible test to have cry wolf.

Disposition: capture the step at confirm time and derive the code from it, rather than re-reading the
clock. Observed once in four runs; the mechanism is deterministic given the rollover.

### L5 — `emailVerifiedAt` is read and discarded

`mfa-enrolment.service.ts:99`, `:230` and `:297` all `select: { id, email, emailVerifiedAt }` and
then return `{ email }`. The notices go out regardless of whether the address is proven.
`mfa-verification.service.ts:472` does the opposite for the new-device notice
(`user.emailVerifiedAt !== null`), citing ruling 71, and `login.service.ts:718` does the same.

`password-change.service.ts` also sends without the gate, so the enrolment service is at least
consistent with *something* — but three unused selects mean the author considered the gate and did
not decide. One of the two policies is wrong for MFA notices and nothing in the diff says which.

Disposition: decide and delete the unused selects, or apply the gate. Not a security defect on its
own — a `mfaEnabled` notice to an unverified address the account owner controls is not a disclosure
— but it is a loose end in exactly the code ruling 71 governs.

### L6 — A security control reads an unordered, truncated row set

```ts
const stored = await this.store.recoveryCode.findMany({
  where: { userId, usedAt: null },
  select: { id: true, codeHash: true },
  take: RECOVERY_CODE_COUNT,
});
```

No `orderBy`. With the invariant intact (≤ 10 unused rows) the `take` never truncates and the order
does not matter, so this is latent — but H1 shows the invariant is breakable, and when it breaks
the set of codes that work is chosen by the planner. The docblock argues the `take` is a bound
against "a user cannot accumulate more"; H1 is the case where they can.

Disposition: add `orderBy: { createdAt: 'asc' }` (or `id`), and treat the `take` as a bound rather
than as a filter.

---

## The six declared gaps — sizing verdict

| # | Gap as declared | My verdict |
|---|---|---|
| 1 | The promoted session is always 7 days, never 30 | **Correctly sized.** Verified: `session.service.ts:620` and `:635` inherit `predecessor.rememberMe`, and `login.service.ts` never sets it on the pending arm. Fails in the safe direction (shorter session), costs a re-login, needs a column or a `rotate` parameter. A defect, correctly deferred, correctly recorded in three places. |
| 2 | Recovery-code regeneration sends no email | **Undersized — see M4.** |
| 3 | Disable revokes no sessions | **Correctly sized**, and I agree with the decision: the caller proved the password, and the notice is the detection. Documented at the site and in the OpenAPI description. |
| 4 | The recovery path costs ~12.5 s of CPU per login before the lock | **Correctly sized, and it deserves the explicit verdict the review brief asked for: acceptable as shipped.** The reason is ordering: `resolve()` runs before any Argon2 work, so an attacker without a valid pending token pays 3–4 ms (measured, M3). A valid pending token costs one correct password. Five attempts × ten verifications is bounded by the five-attempt lock, and `mfaVerify` is 60/hour per IP fail-closed. What is *not* bounded is memory under a distributed valid-password attack — but that attacker already owns the account modulo one factor. **One caveat the report does not name:** the ten verifications are sequential, so the cost is ~2.5 s of *wall clock* on a Node event loop per request; the harness measured 370 ms at reduced parameters. That is a latency budget question for Phase 4, not a Task 11 defect. |
| 5 | The attempt counter is per pending session, so re-authenticating grants a fresh five | **Correctly sized, and I disagree that it is a defect at all.** Re-authenticating costs the attacker a full password submission through `login`, which *is* on the lockout ladder — so the outer bound is login's five, not MFA's. The comment at `recordFailure` already makes this argument. The orchestrator's suspicion that this is undersized is, on measurement, unfounded: the committed test `counts per pending session, so signing in again starts a fresh five` documents it, and the per-account bound exists one endpoint up. |
| 6 | `@AllowPendingMfa()` is inert on the shipped route | **Correctly sized.** Verified at `authentication.guard.ts:152` — `if (access?.kind === 'public') return true;` runs before `allowsPendingMfa`. The decorator is documentation. The report, the decorator's own docblock and the guard spec were all corrected to say so, which is the right outcome. |

---

## M5 — The rate limit's own arithmetic is wrong by a factor of 1000, in two places

**What is wrong.** `rate-limit.config.ts`, on the class that bounds second-factor guessing:

> **60/hour per IP.** The arithmetic is worth writing down, because six digits is a small space: a
> million codes, ±1 drift so three are live at any instant, which is a 3-in-10^6 chance per guess.
> At 60 attempts an hour that is about **one expected success every 630 years** from one address […]

`abuse-prevention.md` §1 repeats it: "about one expected success every 630 years from one address at
this rate".

**The measurement.** The premises are right; the division is not.

```
$ node -e "const g=1e6/3; const h=g/60; console.log('guesses',g.toFixed(0),'hours',h.toFixed(1),'days',(h/24).toFixed(1),'years',(h/24/365).toFixed(3))"
guesses 333333 hours 5555.6 days 231.5 years 0.634
```

**0.63 years — about eight months — not 630 years.** From one address. Ten addresses is under a
month; a modest botnet is hours.

The real bound is better than 0.63 years, but for a reason the comment does not give: a pending
session is required, and minting one costs a successful login, which is limited at
`perPrincipal: { limit: 5, windowSeconds: 900 }` keyed on the email (`rate-limit.config.ts:74`).
Five logins per fifteen minutes, five attempts each, caps an *account* at roughly 100 attempts/hour
however many IP addresses the attacker owns — expected time to success about 3,333 hours, or
**4.6 months** — and every attempt writes an `MFA_CHALLENGE_FAILED` row. That is a defensible
posture. It is simply not the posture the comment claims, and the comment is the justification for
the number.

**Cost if it ships.** A future reader tuning this limit, or asking whether 60/hour is appropriate
for a second factor, reads a security argument that is off by three orders of magnitude and
concludes there is enormous headroom. This is the failure mode ruling 55 records: a false sentence
reaching a code comment and a document.

**Recommended disposition.** Correct both sites. The honest sentence names the per-account bound
(login's `perPrincipal` limit multiplied by the five-failure lock) as the load-bearing control and
the per-IP figure as the outer loop, with the corrected 0.63-year single-address figure.

---

## M6 — "Key rotation is incremental and resumable" is not built

**What is wrong.** `security/authentication.md` §5, in a bullet labelled **Built**:

> `MfaFactor.secretKeyVersion` is written explicitly on every row, **so key rotation is incremental
> and resumable** rather than an all-or-nothing re-encryption.

`.env.example` says the same: "Rotating it is incremental rather than all-or-nothing:
`MfaFactor.secretKeyVersion` records which key encrypted each row."

What is built is a *version stamp*. The process holds exactly one key — `auth.module.ts` provides
`MFA_SECRET_KEY` as `Buffer.from(env.MFA_SECRET_ENCRYPTION_KEY, 'base64')`, a single value — and
`mfa-secret.ts:145-147` refuses anything else:

```ts
if (envelopeVersion !== CURRENT_MFA_SECRET_KEY_VERSION) {
  throw new MfaSecretError('The stored MFA secret names a key version this process cannot use.');
}
```

`CURRENT_MFA_SECRET_KEY_VERSION` is the literal `1`. There is no key map, no second key variable,
and no path that reads a row written under any other version. The **code** is honest about this —
`mfa-secret.ts:52-55`: *"When a second key exists this becomes a lookup"* — so the two documents
overstate what the code says about itself.

**Cost if it ships.** An operator reads a bullet marked **Built** in the security document, rotates
`MFA_SECRET_ENCRYPTION_KEY`, and every existing `MfaFactor` becomes undecryptable. The failure is
quiet in the worst way: `spendTotpCode` catches `MfaSecretError`, logs, and returns `null`, so every
enrolled user gets an ordinary `MFA_INVALID` on every code — indistinguishable, by design, from a
wrong code. Recovery codes still work (Argon2id, key-independent), so the operator sees a partial
outage with no client-visible error naming the cause. `mfa/confirm` does *not* catch it and would
500.

**Recommended disposition.** Reword both sentences: the column makes rotation *possible without a
migration* and is the precondition for an incremental rotation that Task 11 did not build. Building
the lookup is a decision with an ADR in it, not a wording fix. Either way the bullet must stop being
labelled **Built**.

---

## False or unsupported sentences

The register the review brief asks for as a first-class finding class. Eight entries; several are
also findings above and are cross-referenced rather than restated.

| # | Where | The sentence | Why it is false |
|---|---|---|---|
| 1 | `auth.mfa.integration.spec.ts:47-50`, `.claude/api/authentication.md`, and the orchestrator's `brief.md` §4 | `GET /auth/session` with a pending token is something "nothing has ever tested" / "Phase 2 Task 11 is the first to put a test behind […] including the strongest form: presenting the pending token *as* a session cookie". | `git show cc81494:apps/api/src/modules/auth/auth.login.integration.spec.ts` line 764 is `it('the pending session cannot reach GET /auth/session')`, and it presents the token **as a session cookie** — the exact "strongest form" claimed to be new. `authentication.integration.spec.ts:179` asserts the same property at the guard layer. Three copies of one false claim, originating in the brief. (L1) |
| 2 | `auth.mfa.integration.spec.ts:38-41` | "The replay probes use ONE pending session, so the loser is refused by the replay predicate rather than by an authentication guard that got there first." | Both replay probes open two (lines 632-633), and the probe's own docblock at line 601 says "**ON TWO SEPARATE PENDING SESSIONS**". Two is the correct choice; the header states the opposite of both the code and the reason. (L2) |
| 3 | `rate-limit.config.ts` and `.claude/security/abuse-prevention.md` §1 | "about one expected success every 630 years from one address". | 0.634 years. Off by 1000×. (M5) |
| 4 | `.claude/security/authentication.md` §5 and `.env.example` | "key rotation is incremental and resumable", under a **Built** label. | One key in the process; every version but `1` is refused. (M6) |
| 5 | `mfa-verification.service.ts:163-167` | "Unknown, expired, revoked and 'resolved but not pending' are indistinguishable to the caller." | Byte-identical, yes. 3 ms against 370 ms on the same submitted code shape, measured. (M3) |
| 6 | `ADR-0018-pending-mfa-session-row.md`, Consequences | The `rememberMe` gap "is recorded here, in `security/authentication.md` §5, and in Task 11's report." | `awk '/^## 5\. MFA/,/^## 6\./' .claude/security/authentication.md | grep -i 'remember\|lifetime'` returns nothing (exit 1). The record is in `api/authentication.md` §2:117-119 — which the implementer's report cites correctly, so the ADR names the wrong document. (L7) |
| 7 | `report.md`'s "Pre-existing defects found, **not fixed**" list, and the orchestrator's re-verification: "The broken ADR link **is** real. `.claude/security/audit.md:148` links `ADR-0019-platform-audit-event-table.md`" | Present tense, about the finished tree. | `git show 9513d97:.claude/security/audit.md | sed -n '148p'` already reads `ADR-0019-platform-audit-events.md`. The orchestrator fixed it in the same commit that ships both sentences — its commit message says so. True at `7b09aa4`; false in the artefact a reader picks up. (L8) |
| 8 | `report.md`, migration section | "42 lines of reasoning with the first executable statement on line 44." | 40 lines of reasoning; the `ALTER TABLE` is line 43 of a 43-line file, which has no line 44. The pasted SQL itself is byte-identical to the file (`diff` exit 0). (L3) |

**Claims I checked and found TRUE**, listed because the brief named them and a verified claim is
worth as much as a falsified one:

- **RFC 6238 Appendix B, all 18 rows, all three algorithms.** Six time values × three algorithms =
  18 cases, and every value matches the published table. The seeds really are different per
  algorithm — `seedFor(20|32|64)` off `'12345678901234567890'.repeat(4)` — so the SHA-256 and
  SHA-512 rows are not the 20-byte seed reused. The step column is derived through `stepAt` rather
  than transcribed, and `stepAt` is separately pinned against the RFC's own hexadecimal `T` values.
- **RFC 4648 §10, all 7 vectors**, asserted padded *and* unpadded (14 cases), values correct.
- **The D4 predicate is two-stage**, and both stages are load-bearing — proved by mutation in both
  directions (M2's two pastes).
- **"Registered in no module" cannot pass vacuously.** `require-mfa.spec.ts` reads both module files
  through `readFileSync` (a wrong path throws rather than passing), strips block and line comments,
  and asserts the absence of both `MfaEnrolmentGuard` and `MFA_ENROLMENT_POLICY`. It covers
  `auth.module.ts` and `app.module.ts`, which is where the guard would have to be registered to run.
- **"Always padded to exactly ten."** `findMatch` counts verifications and tops up with
  `verify(null, …)`; the caller bounds the read with `take: 10`, so a user with one code left and a
  user with ten pay the same. Confirmed by measurement: `wrong-recovery` 370 ms against
  `spent-recovery` 399 ms on a set with nine remaining.
- **The migration is not applied.** Verified independently against the running container:
  `_prisma_migrations` holds 8 rows ending at `20260828051500_verification_token_partial_unique`;
  `20260901185059_mfa_factor_last_accepted_step` is absent.
- **The migration SQL in the report is byte-identical to the file on disk** (`diff` exit 0).
- **Ruling 85 holds.** `renderMfaChanged` takes `NoticeOccurrenceContext` — `occurredAt` and
  `ipAddress`, no name, no user agent — and the templates are untouched by this branch
  (`git diff --stat cc81494..HEAD -- apps/api/src/modules/auth/emails/` is empty). The new-device
  notice on the MFA arm calls `sendNewDeviceSignIn({ to, occurredAt, ip })`, matching login's call
  site, and is gated on `emailVerifiedAt`.
- **`@AllowPendingMfa()` is inert on the shipped route**, as the report says:
  `authentication.guard.ts:152` returns on `access?.kind === 'public'` before `allowsPendingMfa` is
  ever consulted.
- **The secret does not leak.** No `secret` example in `openapi.json`; every `MfaSecretError` message
  is a constant; `mfa-secret.spec.ts` carries three dedicated absence tests including one that puts
  the value under an innocent log key and asserts the redacting logger does *not* rescue it
  (ruling 67's shape).
- **`error-codes.spec.ts` really does close ruling 27.** It existed at `cc81494`, is untouched by
  this branch, compares `ERROR_CODES` against `api/errors.md` §3 in both directions, refuses
  duplicates, and carries a ≥30 floor so a reshaped document cannot make it vacuous.
- **Audit rows are inside the same transaction as the change** at every mutation site I read
  (`enroll`, `confirm`, `disable`, `regenerateRecoveryCodes`, the challenge success, the failure
  counter). `PlatformAuditService.record` takes a transaction handle and never opens its own, and
  the integration suite asserts no row survives a rolled-back transaction.
- **Double promotion of one pending session is impossible.** `SessionRepository.rotate` is a
  compare-and-swap — `updateMany({ where: { id, revokedAt: null } })`, `count !== 1` aborts before
  the successor insert.
- **`check:secrets` is 404, not 389.** The orchestrator's correction stands; I reproduced 404.

---

## Verification table — what I ran myself

Exit codes captured outside a pipe (`out=$(cmd 2>&1); code=$?`).

| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | "All matched files use Prettier code style!" |
| `pnpm lint` | 0 | 14 tasks — **full turbo cache replay** |
| `pnpm typecheck` | 0 | 14 tasks — **full turbo cache replay** |
| `npx turbo run lint typecheck --force` | 0 | **22 tasks, 0 cached** — a genuinely fresh execution of both, 20.4 s. The row the report and the re-verification could not offer. |
| `pnpm check:specs` | 0 | 108 spec files, each claimed once |
| `pnpm check:secrets` | 0 | **404** tracked files |
| `pnpm build` | 0 | 8 tasks |
| `pnpm check:openapi` | 0 | byte-identical, **18 routes** |
| `pnpm check:registry` | 0 | 15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm test` | 0 | **88 files / 1501 tests** |
| `pnpm test:integration` | 0 | **20 files / 352 tests**, 143.7 s |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)` |
| `docker exec sentinel-postgres-1 psql -U sentinel -d sentinel -c "select migration_name from _prisma_migrations order by started_at;"` | 0 | 8 rows, ending `20260828051500`. **Task 11's migration is not applied.** |
| `diff <(sed -n '43,85p' report.md) migration.sql` | 0 | identical |
| MFA integration spec, unmutated baseline | 0 | 27 tests passed, 22.0 s |

### Mutations I ran myself, and their reverts

Each was applied with `sed` to the working tree and reverted with `git checkout --`;
`git status --porcelain` after each reported nothing but this review file.

| # | Mutation | Result | Matches the report? |
|---|---|---|---|
| A | Delete the `pg_advisory_xact_lock` line in `recordFailure` | exit 1 — sequential lock test **green**, concurrent test **red**: `→ expected null not to be null` | Yes, exactly |
| A′ | Revert A | exit 0 — 3 passed | — |
| B | Drop `usedAt: null` from the recovery-code `updateMany` | exit 1 — sequential **green**, concurrent **red**: `→ expected [ 200, 200 ] to deeply equal [ 200, 401 ]` | Yes, exactly |
| B′ | Revert B | exit 0 | — |
| C | Widen `replaySpendWhere` (`lt: step + 1_000_000`) | exit 1 — statement-level probe **red** (`→ expected [ 1, 1 ] to deeply equal [ +0, 1 ]`); both sequential endpoint tests and the concurrent endpoint test **green** across three repeat runs | Yes — and see L4 for the one anomalous run |
| D | `minimumStep: undefined` (in-memory floor removed) | exit 0 — **all 27 green** | Yes, exactly |
| E | C and D together | exit 1 — **4 red**: both sequential replay tests, the concurrent endpoint test, and the statement probe | Yes, exactly |
| E′ | Revert C, D, E | exit 0 — 27 passed | — |
| F | `if (false && !(await this.credentialStillCurrent(pending)))` | exit 1 — the replacement test **red** (`expected 200 to be 401`), the rehash test **green** | The report's claim confirmed, by a different route than the one it used |
| G | Reduce `credentialStillCurrent` to the timestamp alone | exit 1 — the rehash test **red** (`expected 401 to be 200`), the replacement test **green** | Confirms ruling 83's second stage has an advocate |
| G′ | Revert F and G | exit 0 | — |

Plus one temporary probe file (`zzz-review-probe.integration.spec.ts`, three `describe` blocks) used
to produce H1, M1 and M3's measurements and **deleted afterwards**. At the end of this review
`git status --porcelain` reports only `?? docs/superpowers/ledger/phase-2/task-11/review.md`.

**Not run:** `pnpm test:e2e` (`git diff --stat cc81494..HEAD -- apps/web packages/ui` is empty,
confirmed a third time), `pnpm db:migrate`, `prisma migrate reset`, `pnpm db:seed`, `pnpm dev`.

**What I could not verify:** the report's `D4 PROBE: survivors=25 …` figures (the probe is not in
the repository — M2), and the report's "green on the first run" claims about the RFC vector suites,
which are unfalsifiable after the fact. I verified the vectors themselves instead.

---

## Verdict

**Changes requested.** One High, six Medium, eight Low.

This is a strong branch and that should be said before the objection. The RFC vectors are real and
correctly seeded, the two-layer replay defence is genuinely load-bearing in both layers and I proved
it by mutation rather than by reading, the D4 predicate's *availability* half has an advocate — which
ruling 83 says is the half that usually does not — the enumeration surface is byte-identical across
eight distinct refusal modes, ruling 85 holds, the audit rows are transactional, the migration was
generated and not applied, and the report's paragraph about what the endpoint probe does *not* prove
is the best single paragraph on this branch. All three of the report's headline concurrency mutations
reproduced on my machine with the same failure messages, which not every previous task's report could
claim.

The verdict is negative anyway, for one reason. The concurrency discipline this task was explicitly
briefed on — rulings 74, 84, 87 — was applied to the three places the brief named and to none of the
places it did not. **The two write paths nobody thought to race are both broken**: enrolment answers
500, and regeneration silently issues a second live set of break-glass credentials of which half do
not work. H1 is the same read-check-write shape as the two defects the branch *did* close, one
method away in the same file, and it reaches the user as a printout that fails on the day they have
lost their phone.

The false-sentence count is eight — comparable to Phase 1's twelve, on a much smaller branch — and
three are in files that are themselves security controls: a rate-limit justification, a
security-document capability claim marked **Built**, and the comment on the refusal path. One
originates in the orchestrator's brief and was propagated into two committed artefacts; one was
introduced by the orchestrator's own re-verification in the same commit that falsified it. The brief
was right that this class deserves first-class treatment, and right that the brief itself is fair
game.

**What I would gate a merge on:** H1, M1, M5 and M6. M2, M3, M4 and the Lows are cheap and belong in
the same fix round, but none of them alone should block. Whatever the fix round changes, re-run the
exact mutation that exposed it and paste both states (ruling 66) — and for H1 that mutation is two
concurrent `POST /auth/mfa/recovery-codes`, followed by a `recoveryCode` count and a verification of
the **last** code of each returned set, not the first.
