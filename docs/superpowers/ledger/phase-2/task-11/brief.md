# Task 11 brief — TOTP MFA, recovery codes, and ADR-0018

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02, at `main` = `cc81494`, branch `feat/phase-2-task-11`
cut from that commit.

Task 10 was re-verified on this tree before the branch was cut — not taken from its report, and not
from its own branch, which no longer exists. Ten commands, exit codes captured outside a pipe, all
0: `format:check`, `lint`, `typecheck`, `check:specs`, `build`, `check:openapi` (byte-identical,
**13 routes**), `check:registry` (**15 models**), `docker compose ps` (all four `Up (healthy)`),
`pnpm test` **83 files / 1363 tests**, `pnpm test:integration` **19 files / 325 tests**. `lint` and
`typecheck` were full turbo cache replays rather than fresh executions; every other row ran.

**You are a fresh implementer.** You did not build Tasks 6–10 and you do not inherit their
conventions by memory — read them out of the files named below before you write anything. The plan
puts Task 11 in the *self-contained* mode column for exactly that reason: TOTP, base32 and the
recovery-code set are testable in isolation. The parts that are **not** self-contained are the
pending-session promotion and the login hand-off, and those are where a cold start hurts most. §3's
D4 and D5 exist to close that gap; read `login.service.ts` end to end before you touch them.

---

## 1. The two rules that outrank everything below

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   `roadmap.md` edits, no `.claude/` narrative asserting a state. You *do* update the behavioural
   content of the documents in §6 — the sentences that describe how the system behaves. You do not
   write the sentences that assert what is finished. The orchestrator writes every one of those.
2. **Test-first, and a test about two requests must be two requests.** Carry-forward ruling 74:
   Task 9's lockout ladder never engaged under concurrency while 1,120 unit and 230 integration
   tests were green over it, because every test was sequential. Ruling 84 records the same defect
   *recurring inside a fix round for a finding whose dispositions cite ruling 74*. Your two
   counters — the pending-session attempt count (D5) and the TOTP replay step (D6) — are exactly
   the shape that ruling keeps biting. Ruling 66: when you fix a defect, re-run the exact mutation
   that exposed it and paste the output.

Read `docs/superpowers/ledger/phase-2/progress.md`'s **Carry-forward rulings** in full before
starting. The ones that bind this task directly are named in §3; the list there is not exhaustive.

---

## 2. What Task 11 ships

Five new routes, all under `/api/v1/auth/mfa`:

| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /auth/mfa/enroll` | authenticated | `{ password }` | `{ secret, otpauthUri }` — shown once |
| `POST /auth/mfa/confirm` | authenticated | `{ code }` | `{ recoveryCodes: string[] }` — shown once |
| `POST /auth/mfa/verify` | `@Public()` + `@AllowPendingMfa()` semantics — see D4 | `{ pendingToken, code }` | `{ status: 'AUTHENTICATED' }` + `Set-Cookie` |
| `POST /auth/mfa/disable` | authenticated | `{ password }` | `{ status: ... }` |
| `POST /auth/mfa/recovery-codes` | authenticated | `{ password }` | `{ recoveryCodes: string[] }` — regenerate, shown once |

`pnpm check:openapi` must report **18** routes when you are done (13 + 5), with
`apps/api/openapi.json` regenerated in the **same commit** as the controller change.

Also shipped: the TOTP primitive, base32, the encrypted-secret facility, the recovery-code
service, the `requireMfa` **mechanism** (D8 — a mechanism, not a wiring), the two mail notices'
first callers, the new-device notice on the MFA arm (D9), the audit rows (D10), one migration
(D6), and ADR-0018 (D11).

**A migration IS expected this time**, unlike Tasks 9 and 10. Exactly one column, for D6. Read §5
before you run Prisma at all — the rules there are not optional and one of them is irreversible.

**Out of scope, and say so if you find yourself drifting into it:** tenant resolution, permissions
and placing any guard in the global pipeline (Task 12); organisations, `switch-org` and
`Organization.requireMfa`'s *enforcement* (Tasks 12–13); WebAuthn (the enum value exists, and that
is the whole of Phase 2's WebAuthn work); anything under `apps/web` (Tasks 16–17); exposing MFA
state on `GET /auth/session` — Task 17's `/settings/security` will need it, it is additive, and it
is not yours.

---

## 3. Decisions already taken — implement these

These are orchestrator decisions. Implement them. If one is **wrong** — not merely
inconvenient — say so in your report with the measurement that shows it, and implement your
alternative rather than the broken instruction. Task 10 measured three orchestrator claims false;
that outcome is a success of the process, not a failure of it. A brief is not evidence.

### D1. The TOTP primitive is hand-rolled, and the RFC's own vectors are what prove it

`apps/api/src/modules/auth/totp.ts`, on `node:crypto` HMAC. No new dependency: the primitive is
~40 lines, and ADR-0013's 1440-minute cooldown makes adding one a gamble against CI for something
this small.

**The vectors are the requirement, not a nice-to-have.** RFC 6238 Appendix B publishes a table of
T0=0, 30-second-step values — and they are **8-digit**, over three HMAC algorithms, with the seed
being the ASCII string `12345678901234567890` *truncated or repeated to the algorithm's key
length*. Two traps follow, and both have sunk hand-rolled TOTP implementations before:

- **If you hardcode 6 digits you cannot run the vectors at all.** `digits` must be a parameter,
  with 6 as the production value and the vector test passing 8. Same for the algorithm.
- **The SHA-256 and SHA-512 rows use longer seeds**, not the same 20 bytes. Get this wrong and
  those rows "fail" for a reason that is not your code. If you implement SHA-1 only, run the
  SHA-1 rows and say in your report that the other two were not run and why — do not quietly drop
  them and do not claim a table you did not execute.

A round-trip test (generate a code, verify it) proves nothing here: it passes for any
self-consistent wrong implementation, which is a coin flip against a real authenticator app.

Production parameters: **SHA-1, 6 digits, 30-second step, ±1 window** (accept steps `t-1`, `t`,
`t+1`). SHA-1 is correct and is what every authenticator app implements; it is not a weakness in
this construction and a comment should say so before somebody "fixes" it.

Base32 (RFC 4648, upper-case, no padding in the `otpauth://` URI) has no implementation in
`node:crypto` and you will write one. **Test it against RFC 4648 §10's own vectors** — the
`""`/`f`/`fo`/`foo`/`foob`/`fooba`/`foobar` table — for the same reason as above.

The URI is `otpauth://totp/Sentinel:{email}?secret={base32}&issuer=Sentinel&algorithm=SHA1&digits=6&period=30`,
with the label and issuer percent-encoded. The QR **image** is the frontend's job (Task 17); you
return the URI.

### D2. The secret is encrypted, the key is new config, and `secretKeyVersion` stops being dead

`MfaFactor.secretEncrypted` is the only field in this phase that is encrypted rather than hashed,
because verifying a code requires recomputing it. The schema docblock at
`packages/db/prisma/schema.prisma` already says all of this — read it.

- **AES-256-GCM**, `node:crypto`, random 12-byte IV per encryption, the auth tag stored with the
  ciphertext. Serialise as a single self-describing string; do not spread it across columns.
- **New environment variable**, API-only, validated in `packages/config/src/env.ts` beside the
  other secrets: a base64 32-byte key. Reject a key of the wrong decoded length **at config load**,
  not at first use — a short key must fail the process, not the first user who enrols. Add it to
  `.env.example` with a comment saying how to generate one, and check whether
  `.claude/development/setup.md` lists variables that now need it.
- **Ruling 8: `secretKeyVersion` exists and nothing writes it.** Task 11 writes it. Every row you
  create carries version `1` explicitly; the decrypt path reads it and treats `NULL` as `1`. That
  turns a documented rotation story into a live code path instead of leaving it a comment forever.
  The schema docblock currently says NULL means "the key current when this row was written" —
  **update that docblock in the same change**, because your change makes it false for every row
  written from now on. A `///` comment in `schema.prisma` is editable; ruling 65's immutability
  applies to *applied migration SQL*, which is a different file.
- **Never log it, never return it after enrolment, never put it in an error.** Critical security
  rule 6. Add a redaction test in the shape of `token.redaction.spec.ts` — that file is the
  precedent and you should read it rather than invent a second style.

### D3. An unconfirmed factor is not MFA, and abandoning enrolment must leave no trace that gates anything

`confirmedAt IS NOT NULL` is the only test for "this user has MFA". Counting rows is the wrong
query, and `login.service.ts:801`'s `confirmedFactor` already does it correctly — read it and match
it, do not write a second predicate that could drift from it.

**Carry-forward ruling 7 is a defect waiting in the schema, and it is yours.** `MfaFactor` has
`@@unique([userId, type])`, so an abandoned unconfirmed factor occupies the slot and the user's
next enrolment attempt dies on P2002 — a user who closes the tab has locked themselves out of ever
enabling MFA. **Upsert, or delete-then-create, inside a transaction.** Starting a second enrolment
must *replace* an unconfirmed factor. It must **never** replace a confirmed one: re-enrolling over
a working factor without proving a code is an account-takeover step. Enrolment when a confirmed
factor already exists is a refusal — 409 with the shared error envelope — not a silent overwrite.

The plan's test, verbatim, and it is the one that matters: *enrolling and abandoning halfway leaves
the account exactly as it was.* No confirmed factor, no recovery codes, login unchanged, and the
next enrolment succeeds.

### D4. `mfa/verify` promotes the pending session, and the promotion is conditional on the credential

The pending token is a `PENDING_MFA` `Session` row (ADR-0018, D11). `mfa/verify` is reached by an
unauthenticated request carrying that token **in the body**, not in a cookie — the login MFA arm
sets no cookie at all and `api/authentication.md` §2 says why. Decide and state in your report how
the route declares its access: it is `@Public()` in the sense that no session cookie authenticates
it, and the pending token is the credential the handler itself resolves. `@AllowPendingMfa()`
currently sits on no shipped handler (`auth.controller.ts:352`) — if it is the right declaration
here, use it and say what made it right; if it is not, say that instead. **The boot assertion
requires every route to declare something**, so this is not a question you can leave open.

On success: `sessions.rotate({ sessionId, status: 'ACTIVE', mfaCompletedAt: <now>, ip, userAgent })`.

- **Ruling 50 and `MFA_EVIDENCE_REQUIRED`** (`session.service.ts:183`): the service *refuses* to
  promote to `ACTIVE` without an `mfaCompletedAt`. Pass it. That refusal exists because a review
  demonstrated a ten-minute pending session becoming a thirty-day privileged one from a call that
  proved nothing.
- `rememberMe` was deliberately discarded on the pending arm (`login.service.ts:678`), so the
  promoted session cannot recover the user's preference. **State in your report what lifetime the
  promoted session gets and whether that is a defect**; do not silently pick one. This is a real
  gap the pending-session design creates and nobody has yet had to answer it.

**Rulings 82 and 83 — the promotion needs login's credential check, and this is the sharpest part
of the task.** Task 10's H1 measured 25 of 25 survivors: a login racing a completed password reset
kept a fully privileged session minted with the *old* password. Writing the hash before revoking
narrows that window and does not close it — that is what corrected ruling 51. Login's answer is
`credentialStillCurrent`, called **after** the session is issued, revoking it and failing if the
credential moved.

MFA verify has no password in hand, so the predicate differs: **the pending session must not be
promoted if the credential was written after the pending session was created.** `Credential.updatedAt`
is a `@updatedAt` column and already exists — no schema change for this. Check it **after** the
rotation, mirroring H1's ordering, and on violation revoke the promoted session and fail with the
same refusal as a bad code.

Two things to be honest about rather than paper over, both of which I expect your report to
address:

1. **A concurrent transparent rehash on another device moves `updatedAt` too**, and would block a
   legitimate promotion. It fails *closed* and costs a re-login, and the rehash is idempotent so
   the retry succeeds. Write the test that documents this, and say whether you think the trade is
   right. If you find a predicate with no false positive and no new column, take it and show the
   measurement.
2. **Prove the control, do not describe it.** Ruling 83 exists because H1's fix was explained with
   the wrong mechanism named and the control doing the real work had no test at all. Disable your
   check, measure survivors, re-enable it, measure again, paste both numbers.

### D5. Five failed attempts lock the pending session, and the counter is durable

`security/authentication.md` §5: *"Failed attempts are rate limited and lock the pending session
after 5."* Both halves, and they are different mechanisms:

- **The lock** is per pending session and must survive a Redis restart, so it is not the Redis
  limiter. The fifth failure **revokes the pending session** — the user starts again from login,
  which is the correct outcome and reuses machinery that already exists. Where the counter lives is
  yours to decide; `Session` has no attempt column and I am not asking you to add one if a
  transaction-safe alternative exists. Whatever you choose, **an increment under concurrency must
  not be lost** — ruling 74's exact shape. Prove it with concurrent requests, not sequential ones.
- **The rate limit** is a new class in `apps/api/src/common/guards/rate-limit.config.ts`. Read that
  file's existing comments first: they are unusually good and they record *why* several classes are
  shaped as they are. Add `mfaVerify` (per-IP, `failMode: 'closed'` with the rest of the
  authentication classes) and a class for the four authenticated management routes, which are a
  password oracle in the same way `passwordChange` is — read `passwordChange`'s comment at
  `rate-limit.config.ts:199` and match its reasoning and its numbers unless you can argue better.
  **Do not declare `perPrincipal: 'authenticated'`**: the limiter runs before authentication by
  design, so it resolves on no request that reaches here, and declaring it would reproduce ruling
  55's defect deliberately — the file already says this in as many words.

Ruling 90 and ruling 55's per-principal limiter stage remain owed and are **not** yours to build.

### D6. Replay: store the last accepted step, and this is the one migration

A TOTP code accepted at step `t` must never be accepted again — the ±1 drift window means a code
stays valid for ~90 seconds, and an attacker who observes one (shoulder-surfing, a phished form, a
proxy) can replay it inside that window. The drift window does not defend against this; nothing in
the current design does.

Add **one column** to `MfaFactor` holding the last accepted step counter, and reject any code whose
step is less than or equal to it. A step counter is a large integer — pick the type deliberately
and say why. The check and the store must be **atomic**: two concurrent requests with the same
valid code must produce exactly one success. Sequential tests cannot see this defect; ruling 74.

`security/authentication.md` §5 does **not** currently mention this control, and the plan is
explicit that it must: *an undocumented control is one a future refactor deletes.*

### D7. Recovery codes: ten, Argon2id, single-use, regenerable

- Ten codes, generated with `node:crypto` randomness, in a format a human can read back off a
  screen and type. State your alphabet and length and the entropy it yields.
- **Argon2id-hashed, not SHA-256.** They are human-typed and low-entropy relative to a 256-bit
  token, so they need the work factor. Use the existing `PasswordService` machinery rather than a
  second Argon2 configuration — read `password.service.ts` and ADR-0014 first.
- **Ten Argon2id verifications per submitted recovery code is a real cost**, and `mfa/verify` takes
  a TOTP code *or* a recovery code without knowing which. Say in your report how you resolved that
  — including whether the resolution creates a timing distinction between the two kinds, which
  would be a new oracle.
- Using one sets `usedAt`. **The same code must fail the second time**, and that test is named in
  the plan. Under concurrency, one success and one failure — not two successes.
- Regeneration deletes the whole set and issues ten new ones, in a transaction.
- Shown once, at confirm and at regeneration. Never retrievable afterwards.

### D8. `requireMfa` is a mechanism this task writes and does not wire

`Organization.requireMfa` exists in the schema. §5 requires that a member without a confirmed
factor be forced into enrolment **on every request, not only at login** — but that check needs
tenant resolution and organisation membership, which is Task 12 and does not exist. The plan is
explicit: *"The guard is written here; Task 12 places it in the pipeline."*

So: write the mechanism with its own unit tests, and **register it nowhere**. It enforces nothing
when you are finished, and every sentence you write about it must say so — the same honesty the
roadmap applies to `@RequirePermission()`, which is metadata no guard enforces until Task 12. A
control that is documented as live and is not is worse than one that is absent.

### D9. The two notices get their first callers, and the MFA arm gets the new-device notice

`mfaEnabled` and `mfaDisabled` exist in `emails/registry.ts` and nothing has ever called them.
Enabling sends the first; disabling sends the second.

**Ruling 85: neither takes a recipient display name, and you must not add one back.** That ruling
cost three tasks and five channels to close — `User.name` is free text an attacker seeds by
registering a victim's address first, and the typecheck is the control that keeps it closed. The
sixth channel, `organizationName`, is characterised and binds Task 13, not you.

**Task 9's debt, and it is explicitly Task 11's**: `login.service.ts:139-142` records that no
new-device notice is sent on the MFA arm, so an MFA-enrolled account currently gets **no**
unfamiliar-session notice at all. Send it on MFA completion, where the sign-in actually completes.
Read how the login path decides familiarity and reuse it; do not write a second definition.

Per-account notice throttling (ruling 79) is still owed and is not yours.

### D10. Audit rows, in the same transaction as the change

`.claude/security/audit.md:80-81` already names `MFA_ENABLED`, `MFA_DISABLED` and
`MFA_CHALLENGE_FAILED` in the taxonomy. Use those spellings — the document is the registry and it
predates you. Add whatever else the flows genuinely need (enrolment started, a successful
challenge, a recovery code used, a pending session locked), and **add them to that document in the
same change**, which is what `platform-audit.actions.ts:12` says the rule is.

`AuditEvent` has a NOT NULL `organizationId`; these are user-scoped events with no organisation, so
they are `PlatformAuditEvent` rows like `LOGIN` and `LOGOUT`. `platform-audit.actions.ts:92` and
`:101` explain the split — read them rather than guessing which table.

The transaction is the control, not a best effort. A `MFA_DISABLED` row that is missing because a
write failed after the factor was deleted is the exact evidence an incident review needs.

### D11. ADR-0018, and it is owed

`.claude/decisions/ADR-0018-*.md` is **reserved and unwritten** — the directory jumps 0017 → 0019.
Task 9 shipped the pending-MFA credential shape provisionally under ruling 81 and left the decision
unrecorded.

Write it: **the pending MFA credential is a `Session` row in `PENDING_MFA` status, not a
Redis-only token.** It reuses revocation, makes "rotate on privilege change" literal rather than
analogous, and survives a Redis restart mid-login. **Name the cost** — a database write per login
attempt that reaches MFA — and name the consequence D4 turned up: the pending arm discards
`rememberMe`, so the promoted session's lifetime is a question the design forces someone to answer.

Match the house format of the existing ADRs, add its row to `.claude/decisions/README.md`, and
**write it before the code it justifies**, not afterwards. The plan's anti-pattern table: an ADR
written to justify what was built records a rationalisation, not a decision.

---

## 4. What the tests must prove

Unit, at the layer the logic can fail:

- RFC 6238 vectors (D1), RFC 4648 base32 vectors (D1).
- ±1 drift accepted, ±2 rejected.
- **Replay**: the same code twice, sequentially *and* concurrently — one success (D6).
- Encrypt/decrypt round-trip; a tampered ciphertext or auth tag **fails** rather than returning
  garbage; a wrong-length key is rejected at config load (D2).
- The secret never appears in a log line or an error body (D2).
- Recovery code single-use, sequentially and concurrently (D7).
- The `requireMfa` mechanism's decisions, in isolation (D8).

Integration, against real Postgres via Testcontainers, in the shape of the existing
`auth.*.integration.spec.ts` files:

- The full journey: enrol → confirm → login → `mfa/verify` → an authenticated request succeeds.
- **Abandon halfway leaves the account exactly as it was**, and re-enrolment then works (D3, ruling 7).
- Enrolment refused when a confirmed factor exists (D3).
- Five failures lock the pending session; the sixth attempt fails even with a correct code (D5).
- A recovery code completes MFA; the same code then fails (D7).
- Disable requires the current password; a wrong password changes nothing and writes the failure
  audit row (D10).
- **The credential race** (D4): promotion refused when the credential moved, with survivors
  measured both with the check disabled and with it enabled.
- An audit row exists for every mutation, and none exists when the transaction rolled back.
- The pending token cannot read anything: `GET /auth/session` with it answers 401 `MFA_REQUIRED`,
  which `api/authentication.md` §2 already promises and nothing has ever tested.

---

## 5. The migration — read this before running Prisma

Plan §5 is binding. D6's column is the only migration expected.

```
pnpm --filter @sentinel/db exec prisma migrate dev --create-only --name <name>
```

**`--create-only`. Do not apply it.** The operator reviews every migration's SQL before it touches
a database, and that review has not happened when you generate the file. This costs you nothing:
`packages/db/src/testing/postgres-harness.ts:40` runs `prisma migrate deploy` against a fresh
container, so your integration tests replay the migration from empty and pass without the local
development database ever being touched. Run `pnpm db:migrate` and you have applied an unreviewed
migration to the operator's database.

Three carry-forward rulings apply and each has already cost this branch something:

- **Ruling 1**: a migration must leave the database sound on its own.
- **Ruling 65 / ruling 2**: an applied migration is immutable, and editing one breaks
  `prisma migrate dev` locally for everybody until a reset.
- **Ruling 3**: you cannot run `prisma migrate reset`. Prisma 6.19.3 detects an AI agent and
  demands a consent string that is the literal text of the operator's own message. **Never
  fabricate that string.** If you reach a state needing a reset, stop and report it.

Match the house style in `packages/db/prisma/migrations/`: the reasoning leads, the SQL follows. In
`20260820142200_membership_user_restrict/migration.sql` the first executable statement is on line
21. Paste the complete generated SQL into your report — the operator reviews it from there.

Run `pnpm check:registry` afterwards. It refuses to answer from a generated client older than
`schema.prisma`, so regenerate; it was caught once passing a schema it had not read.

---

## 6. Documents you update in the same change

Behavioural content only — how the system behaves. Not status prose.

- **`.claude/security/authentication.md` §5, in full.** The plan's wording: *every bullet in it is
  either built or deliberately deferred by this task, and the section must say which.* The replay
  defence (D6) is a control the section does not currently mention and must. `requireMfa` (D8) is
  the deferral that must be labelled as one, in the section's own words, not implied.
- **`.claude/api/authentication.md` §2** — the five routes, their bodies, their errors, and the
  removal of the "`mfa/verify` is Task 11's ... a contract with no handler" note at line 44. The
  §2 promise that `GET /auth/session` with a pending token answers 401 `MFA_REQUIRED` now has a
  test behind it; make sure the sentence and the test agree.
- **`.claude/security/audit.md`** — the new action names (D10).
- **`.claude/decisions/ADR-0018-*.md`** and its row in `.claude/decisions/README.md` (D11).
- **`packages/db/prisma/schema.prisma`** — the `secretKeyVersion` docblock your change falsifies
  (D2), and a docblock on D6's new column.
- **`.env.example`**, and `.claude/development/setup.md` if it enumerates variables (D2).
- Any comment in `login.service.ts` or `auth.controller.ts` that says "Task 11 owns this" and is no
  longer true. `login.service.ts:139-142`, `:792` and `auth.controller.ts:352-357` are four I know
  about; there may be more — `grep -rn "Task 11" apps/api/src packages` and answer every hit.

`.claude/security/abuse-prevention.md` §1 carries the rate-limit table. Check whether your new
classes belong in it; if the table omits MFA entirely, say so rather than assuming it is complete.

---

## 7. Verify, and what to hand back

Run, capturing the exit code **outside a pipe** — `out=$(pnpm <cmd> 2>&1); code=$?` — because `$?`
after a pipe reports the last stage's status and not the command's:

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`docker compose ps`.

`pnpm test:e2e` has no row unless you touched `apps/web` or `packages/ui`, and you should not have.
If `git diff --stat main..HEAD -- apps/web packages/ui` is empty, say that instead of running it.

Hand back a `report.md` in this directory containing:

1. **The evidence table** — one row per command actually run, with its real exit code and what it
   proves and no more. A command you did not run has no row. `pnpm test` and `pnpm test:integration`
   get their file/test counts, so the change in them is visible.
2. **The migration SQL in full** (§5), for the operator's review.
3. **Every decision you made that this brief did not make for you**, with its reasoning — the
   access declaration on `mfa/verify` (D4), the promoted session's lifetime (D4), where the attempt
   counter lives (D5), the step column's type (D6), the recovery-code format and how you told a
   recovery code from a TOTP code (D7).
4. **The measurements**, pasted: RFC vector results, the credential-race survivor counts with the
   check disabled and enabled (D4), the concurrent replay and concurrent recovery-code results, and
   the re-run of any mutation that exposed a defect you then fixed (ruling 66).
5. **Everything you did not do**, plainly. Deferrals, anything you decided was out of scope, and
   anything you believe is a defect you did not fix. An honest gap in this list is worth more than
   a paragraph asserting completeness — a fresh adversarial reviewer reads this report against the
   repository before reading a line of your diff, and every claim in it will be checked.

Commit as you go, conventional commits, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
Never commit to `main`; you are on `feat/phase-2-task-11`. Do not push.
