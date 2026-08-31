# Task 10 brief — password reset, and closing ruling 70

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-08-31, at `main` = `cfc0cb7`, branch `feat/phase-2-task-10`.
Task 9 was re-verified on this tree **after** its rebase onto `main`, not merely on its own branch:
`pnpm lint`, `typecheck`, `check:specs`, `check:openapi` all exit 0; `pnpm test` 81 files / **1279**
tests; `pnpm test:integration` 18 / **286**; `check:openapi` byte-identical at **10 routes**.

You are the implementer. You built Task 9, so you know this module — **and that is the risk this
brief is written against.** Task 9's two Highs were both things its author believed were already
handled. Re-read what you wrote before you extend it.

---

## 1. The two rules that outrank everything below

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   `roadmap.md` edits, no `.claude/` narrative asserting a state. You *do* update the behavioural
   content of the documents in §5. The orchestrator writes every sentence that asserts anything.
2. **Test-first, and a test about two requests must be two requests.** Carry-forward ruling 74:
   Task 9's lockout ladder never engaged under concurrency and 1,120 unit plus 230 integration tests
   were green over it, because every test was sequential. Ruling 66: when you fix a defect, re-run
   the exact mutation that exposed it.

---

## 2. What Task 10 ships

- `POST /api/v1/auth/forgot-password` — identical response whether or not the address exists.
- `POST /api/v1/auth/reset-password` — consumes the token, breach-checks and hashes the new
  password, revokes **every** session for that user, sends the notice.
- `POST /api/v1/auth/change-password` — authenticated; requires the **current** password, revokes
  every **other** session while rotating the one in hand, sends the notice.
- Audit events for all three, plus the ADR-0014 debt in §3's D8.

`check:openapi` must report **13** routes when you are done, with `apps/api/openapi.json`
regenerated in the same commit as the controller change.

**No migration is expected.** `VERIFICATION_PURPOSES` already carries `PASSWORD_RESET`
(`token.service.ts:17`), so Task 4's token machinery covers this without a schema change — the same
way Task 9 needed none. If you reach for `prisma migrate dev`, stop and say why in your report
instead: ruling 65 records that an applied migration's comment is immutable and ruling 3 that an
agent cannot run the reset that would fix a bad one.

**Out of scope:** MFA (Task 11), tenant resolution and permissions (Task 12), organisations (13),
anything under `apps/web` (16–17).

---

## 3. Decisions already taken — implement these

### D1. Close ruling 70 completely: **no security notice renders a stored display name**

This is the task ruling 70 named, and `passwordReset` is its sharpest instance in the codebase: the
template renders `recipientName`, the endpoint is unauthenticated, and the message carries a **live
reset link**. `User.name` is free text an attacker seeds by registering a victim's address first.

Do it the way ruling 71 did the user agent — **to the class, not the instance**. Remove
`recipientName` from every notice and token-link template that still takes one:
`passwordReset`, `passwordChanged`, `mfaEnabled`, `mfaDisabled`. The greeting becomes the
unaddressed form the other templates already use.

- `mfaEnabled` and `mfaDisabled` have no caller until Task 11. Change them anyway. Task 9 is the
  case study: `newDeviceSignIn` was "safe because it has no caller yet" right up to the commit that
  gave it one, in the same task, and the sentence recording that safety was left behind.
- `registry.spec.ts` currently asserts the residual **from both sides** — that the display name
  *does* still carry a link. That test is now false and must be **deleted, not adjusted**; its own
  docblock says closing the residual should turn it red and force a deliberate deletion. Replace it
  by extending the ruling-70 prescribed test (`no link when EVERY caller-supplied field is a URL`)
  across the whole registry with no exempt list at all.
- When this lands, **ruling 70 is closed** and the register should say so. Report it; the
  orchestrator writes the ruling.

### D2. Write the new hash BEFORE revoking sessions

`SessionService.revokeAllForUser`'s own docblock names this and says Task 10 owns it: *"A password
change must write the new hash **before** calling this, so that a racing login cannot mint a session
with the old credential once this call has finished."* A revoke-then-write ordering leaves a window
in which the old password still mints sessions that the revocation has already passed over.

- **Reset** revokes every session, with no exception: the user completing a reset holds none, and if
  an attacker holds one, that is the session being taken away.
- **Change** revokes every *other* session and **rotates** the one in hand (`SessionService.rotate`,
  status stated explicitly — ruling 6). Losing your own session on a password change is a usability
  bug; keeping every other one is a security bug. `security/authentication.md` §3 lists a password
  change as a privilege change, so the rotation is required, not cosmetic.

### D3. Compare-and-swap the credential, because ruling 73 applies here too

Both endpoints read the credential, spend ~40 ms verifying or hashing, then write — which is exactly
the shape that made Task 9's H1. Two concurrent change-password requests both verifying against the
same old hash must not both commit.

Write the new hash with a **conditional update predicated on the hash you verified**
(`where: { userId, passwordHash: <the value read> }`) and treat `count: 0` as a refusal rather than
a success. Same discipline as `login.service.ts`'s not-locked predicate, and the same reason: the
value is not stale, the **decision to write it** is.

### D4. A reset token is not permission to sign in a non-ACTIVE account

Carry-forward ruling 37: `TokenService.consume` asserts nothing about the user it returns, so a
`LOCKED` or `DISABLED` account's link would otherwise redeem. Task 8 hit this for email
verification and its answer is the pattern to copy: refuse with the **same** `TOKEN_INVALID` as
every other refusal, and **roll back** rather than burning the token, so a link refused because an
account was locked still works once an administrator unlocks it.

### D5. Enumeration: one response, and the residual named rather than implied

`forgot-password` answers `{ status: 'RESET_REQUESTED' }` for an address with no account, one
awaiting verification, and one fully active. Prove it by **byte comparison** in
`auth.enumeration.integration.spec.ts`, extending the file rather than writing a new one — and note
ruling 77: these are 200s with a constant body, so unlike login's refusals they need no `requestId`
substitution. Check that before assuming either way.

**The timing residual is real and is accepted, not fixed.** A send that happens costs an SMTP round
trip and a send that does not costs nothing, which is rulings 68 and 78 on a third endpoint. It is
not closable before the Phase 4 queue. **Measure it** — 25 samples per case, as Task 8 did for the
resend — and report the numbers. A named, measured oracle is a decision; an unmeasured one is the
finding Task 9 collected as M3.

### D6. The cross-site guard covers the two public routes

`forgot-password` and `reset-password` are public and state-changing, so `CsrfGuard` skips them and
`@RefuseCrossSite` is what covers them — the mechanism Task 9 built for exactly this (ruling 56).
`change-password` is authenticated, so `CsrfGuard` governs it; assert that on the shipped route, as
Task 9's logout test does.

### D7. Rate limits: one class exists, two do not

- `forgot-password` → the existing `passwordReset` class (3/hour per address by the body's `email`,
  10/hour per IP, fail closed).
- `reset-password` → **a new class**. Its body is `{ token, password }` and carries no account, so
  it is per-IP only, exactly as `emailVerificationConsume` is and for the same written reason.
  Defaulting it is not available: `generalSession` is fail-open with an unresolvable scope and
  nothing reports that at the default log level (ruling 55).
- `change-password` → **a new class**, and this one is a security control rather than bookkeeping.
  The endpoint verifies a password, so it is a credential-guessing oracle for anyone holding a
  stolen session. Per-IP, fail closed. Note in the code that the per-principal half would be the
  right key and resolves nothing today because the limiter runs before the authentication guard.

Both new classes are **decisions, not transcriptions** — write them into
`security/abuse-prevention.md` §1 with their reasoning in the same change, the way Task 8 recorded
`emailVerificationConsume`. Assert the class on each shipped handler (ruling 64).

### D8. Pay Task 9's debt: the transparent rehash on successful login

ADR-0014 §48 says a credential stored at weaker parameters is rehashed transparently *"on next
successful login"*. `PasswordService.verify` returns `needsRehash`, and **nothing acts on it** —
`login.service.ts:138` is a comment saying so. Task 9 shipped the endpoint without the clause.

Implement it: on a successful login with `needsRehash`, write the re-hashed credential. This is
Task 10's because it already owns credential writes. Two constraints:

- It must not change the login response, and a failure to rehash must not fail the login. The user
  authenticated successfully; a maintenance write is not permission to refuse them.
- It **partially closes carry-forward ruling 24** — the timing oracle that opens when an operator
  raises the Argon2 parameters, because old hashes then verify at a measurably different cost.
  Rehash-on-login is the mechanism that drains the old population. Say clearly in your report what
  it does and does not close: accounts that never log in keep their old hash indefinitely, which
  ADR-0014 §116 already acknowledges.

### D9. Audit events, and the failure half

`security/audit.md` §4 already names `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED` and
`PASSWORD_CHANGED`; add them to `PLATFORM_AUDIT_ACTIONS` (ruling 62 — all three are
`PlatformAuditEvent`, since none has an organisation).

- A reset requested for an address with **no account** still writes a row, with a null `resourceId`
  and no address in the metadata — the same reasoning as Task 9's `LOGIN_FAILED`, and for the same
  purpose: a distributed sweep across addresses that are not customers must leave a trace when the
  wire response deliberately does not.
- A `change-password` refused for a wrong current password is a **denial** and `audit.md` §3
  requires it. Task 9's M2 was exactly this gap one endpoint over.
- Record the number of sessions revoked in the metadata of the reset and change rows. One row per
  revoked session would let an unauthenticated caller size the table.

---

## 4. What the tests must prove

Beyond the obvious happy paths:

- **Concurrency (ruling 74).** Two change-password requests in one `Promise.all` against the same
  account: exactly one commits. Two reset redemptions of the same token: exactly one succeeds.
- **Ordering (D2).** A login racing a completed reset must not mint a session with the old
  password. Assert the hash is written before the revoke — and prove the assertion can fail by
  reversing the two statements and watching a test go red.
- **Revocation scope.** Reset kills every session including the one an attacker holds; change kills
  every other session and leaves the caller's own working, rotated to a new token.
- **RLS, if you touch anything RLS-dependent (ruling 75).** The integration harness connects as the
  schema owner and bypasses row-level security; a spec asserting an RLS property must drive the
  least-privileged client or it proves nothing.
- **The notices (D1).** Ruling 70's prescribed payload across the whole registry, with no exempt
  list. Every caller-supplied field a URL; no link in either part.
- Cross-tenant isolation: nothing here is tenant-owned, so there is no row to write. Say so in the
  report rather than omitting it silently.

---

## 5. Documents you update in the same change

- `.claude/api/authentication.md` — the three new routes, their refusals, their rate-limit classes.
- `.claude/security/authentication.md` §6 — the reset token row and the revoke-all rule, both of
  which stop being aspirational here; §2's residual list if D8 changes what is true there.
- `.claude/security/abuse-prevention.md` §1 — the two new classes, as decisions with reasoning.
- `.claude/security/audit.md` §4 — if the taxonomy gains a row.
- `.claude/decisions/` — an ADR only if you take a decision expensive to reverse. **0018 is
  reserved for Task 11** and is not yours.

---

## 6. Verify, and what to hand back

Run every command on the finished tree, exit codes captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`): `format:check`, `lint`, `typecheck`, `test`, `check:specs`,
`test:integration`, `build`, `check:openapi`, `check:registry`, `check:secrets`,
`docker compose ps`. `test:e2e` gets **no row** unless you touch `apps/web` or `packages/ui`.

Hand back `docs/superpowers/ledger/phase-2/task-10/report.md`: the evidence table, every decision
this brief left to you with its cost if wrong, every mutation you applied and what it did, what you
did **not** do and what remains open, and **anything in this brief you found to be false**. Two of
Task 9's most useful findings were exactly that, and both were mine.

Commit small and often on `feat/phase-2-task-10`; never commit to `main`. These commits will be
read by a fresh adversarial reviewer who has not seen this conversation.
