# Task 9 fix round — one row per finding

> **A dated record of what was changed and measured at the time. Not a description of current
> state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-08-31, on `feat/phase-2-task-09`, from `629f28d` to the head
recorded below. Dispositions are the orchestrator's, in [`fix-brief.md`](fix-brief.md); findings
are the reviewer's, in [`review.md`](review.md).

**Eleven fixed, one accepted and named (M3), and one finding the dispositions did not predict —
reported in §3 rather than reasoned into silence.**

---

## 1. One row per finding

| # | Sev | Disposition | What changed | What establishes it |
|---|---|---|---|---|
| **H1** | High | Fix | The failure counter is now an atomic `{ increment: 1 }` under a not-locked predicate, evaluated by Postgres while it holds the row lock; the ladder is computed from the value the database returns, read back inside the same transaction. `IdentityUserUpdateData` loses the arm that carried an absolute count and gains `{ lockedUntil }`. | Five new integration tests, written first and seen red with the review's own numbers (§2.1). Green after: `auth.login.integration.spec.ts` 52 tests, exit 0. |
| **H2** | High | Fix, wider than the instance | `userAgent` removed from `whereAndWhen` in `notice.templates.ts` — so **all five** notices lose it — and from `AuthMailer.sendNewDeviceSignIn`'s signature, so no caller can supply one. Supersedes ruling 63's carve-out. | `registry.spec.ts` 116 tests green; the characterisation test asserting the opposite went red on all four notices and was deleted (§2.2). Two new caller-level assertions in `login.service.spec.ts`. |
| **M1** | Med | Fix | Two tests now drive `activeOrganizationLookup` itself over `appPrisma` (`sentinel_app`), both arms. | **Mutation B re-run**: previously green in both lanes, now fails one test with `expected null to deeply equal { …(3) }` (§2.3). |
| **M2** | Med | Fix | A denial on a non-`ACTIVE` account writes one `LOGIN_FAILED` row carrying `userStatus` and `passwordAccepted: true`, in a transaction carrying the event alone. No state change. | Unit test written first, red with `expected [] to deeply equal [ 'LOGIN_FAILED' ]`. Four integration tests hold the wire and table halves together. |
| **M3** | Med | **Accepted — named, not fixed** | No code change. Named in `security/authentication.md` §2's residual list (which said "two residuals" and now says three) and in §7's burst-notice paragraph, with both bounds recorded. | §4 below. The disposition is explicit: naming it is the deliverable. |
| **L1** | Low | Fix | `active-organization.store.ts` cited `auth.session.integration.spec.ts`, which does not exist, and claimed it drove the lookup over `appUrl`, which nothing did. Both corrected; the paragraph now records the measurement instead of asserting the protection. | `grep -rn "auth.session.integration.spec" apps/api/src` returns only the line that names it as the former error. |
| **L2** | Low | Fix | `cross-site.guard.ts` quoted `typeof origin === 'string'`, which the file never contained. Rewritten to describe the line that exists, keeping the repeated-header reasoning that was the point. | The comment and `if (origin !== undefined && origin !== this.webOrigin)` now agree. |
| **L3** | Low | Fix | `TASK_8_RATE_LIMIT_CLASSES` was kept "so its two specs still read" and was referenced by zero specs. Deleted. | `grep -rn "TASK_8_RATE_LIMIT_CLASSES" apps/api/src` returns nothing. |
| **L4** | Low | Fix | Report §2.2's two citations corrected: the enumeration spec never sets `User.status`, and ruling 37 is about `TokenService.consume` and binds Tasks 8, 10 and 15. | The corrected paragraph in [`report.md`](report.md), which also records that the fix round found M2 on that same path. |
| **L5** | Low | Fix | `AccountLockedError`'s message no longer says "temporarily locked", "try again later" or "reset your password" — all three false for an administratively disabled account. One code and one message still, but true of both kinds of lock and distinguishing neither. | `pnpm check:openapi` exit 0 at 10 routes after regenerating; the route description is aligned. |
| **L6** | Low | Fix | "THE SIX ROUTES THIS PRODUCT PUBLISHES" contradicted the sentence four lines below it. Six is the count on this controller; ten is the product's. | The docblock now says both and distinguishes them. |
| **L7** | Low | **Document, do not fix** | `authentication.md` §7 gains the arithmetic — 20 attempts per 15 min per IP at 5 per lock is four locks per window, roughly eight accounts held at the 30-minute cap from one address — and `abuse-prevention.md` §1 no longer presents the windows' independence as settling §7's sentence. | §5 below. |

---

## 2. The measurements the disposition required

### 2.1 H1 — the test written first, seen to fail

Five tests added to `auth.login.integration.spec.ts` before any code changed, with the reviewer's
probe as their specification. Run against the unfixed code:

```
× the ladder counts CONCURRENT attempts > counts five parallel wrong passwords as five, and locks
  → expected 1 to be 5
× ... > refuses a CORRECT password afterwards, because the lock actually engaged
  → expected 200 to be 403
× ... > writes exactly one ACCOUNT_LOCKED row and sends exactly one burst notice
  → expected [] to have a length of 1 but got +0
× ... > gives every LOGIN_FAILED row a DIFFERENT consecutiveFailures, 1 through 5
  → expected [ 1, 1, 1, 1, 1 ] to deeply equal [ 1, 2, 3, 4, 5 ]
× ... > does not count attempts that arrive in parallel WITH the locking one
  → expected [ 'failedLoginBurst', …(4) ] to deeply equal [ 'failedLoginBurst' ]

Tests  5 failed | 41 skipped (46)
```

Every line reproduces the review's own probe: counter at 1, no lock, zero `ACCOUNT_LOCKED` rows,
zero burst notices, correct password answering 200, and all five audit rows carrying
`consecutiveFailures: 1`.

**The fifth failure is the one that shaped the fix.** It seeds the account at four failures and
fires five in parallel, and it produced **five** burst notices — so an atomic increment alone is
not sufficient. Four siblings all read count 4, all wrote 5, all locked and all sent. The predicate
`WHERE id = $1 AND (lockedUntil IS NULL OR lockedUntil <= $now)` is what makes "once per lock" true
under concurrency: a racing attempt blocks on the row lock, re-evaluates against the committed row,
gets `count: 0` and changes nothing. That is D2's rule enforced where it can hold rather than from
a read that is stale by construction.

After the fix: `auth.login.integration.spec.ts` 52 tests, exit 0.

### 2.2 H2 — the characterisation test deleted, and ruling 70 applied to every notice

The block asserting that four notices **do** render the user agent went red on all four the moment
`whereAndWhen` stopped rendering it:

```
× context-rendering notice passwordChanged  > DOES reflect the user agent it is given …
× context-rendering notice mfaEnabled       > DOES reflect the user agent it is given …
× context-rendering notice mfaDisabled      > DOES reflect the user agent it is given …
× context-rendering notice newDeviceSignIn  > DOES reflect the user agent it is given …
  → expected '…' to contain 'FIXTURE-agent-Chameleon/1.0'
```

That is the deliberate deletion its own comment said it existed to force: *"the day somebody closes
it this test goes red and has to be deleted deliberately."* Its risk acceptance is void with it,
and its stated grounds — *"none of the four has a caller yet (Tasks 9 and 11 add them)"* — were
what made H2 a finding rather than an inherited residual: Task 9 shipped the caller, edited that
file in the same commit, and left the sentence.

Ruling 70's prescribed test now runs over every notice instead of two. The block it replaces passed
BENIGN values for `ipAddress` and `userAgent` and hostile text only for the name, which is how H2
stayed green here while live in production — carry-forward ruling 58's family again.

### 2.3 M1 — mutation B, re-run

The reviewer's mutation B replaces `withTenantTransaction(base, organizationId, …)` with a direct
`base.organization.findUnique(…)` — the exact code `active-organization.store.ts` says returns
`null` in production. Applied to the fixed tree and run in both lanes, directly comparable to the
review's figures:

| | Integration | Unit |
|---|---|---|
| **Review, before the fix** | `EXIT=0` — 18 files, 275 tests passed | `EXIT=0` — 81 files, 1252 tests passed |
| **This round, after the fix** | `EXIT=1` — **1 failed** \| 17 passed; **1 failed** \| 281 passed | `EXIT=0` — 81 files, 1265 tests passed |

```
× GET /auth/session > resolves through activeOrganizationLookup OVER THE LEAST-PRIVILEGED ROLE — M1
  → expected null to deeply equal { …(3) }
```

Exactly the `null` the docblock predicted, from exactly the mutation that previously survived both
lanes. The mutation was then reverted; `git diff` on that file is empty.

**The unit lane stays green under it, correctly.** This is a row-level-security property and there
is no database in that lane to enforce one. Recorded so a later reader does not treat the green
unit run as a gap.

---

## 3. A finding the dispositions did not predict

**Reported rather than reasoned into silence, per the fix brief's last instruction.**

H2's disposition removed the user agent and kept the IP address, on these grounds: *"a socket peer
address is not free text, cannot carry a URL, and is bounded and validated already."*

The first half is true of `request.ip` with `trust proxy` disabled. **The second half was not true
anywhere between that read and the rendered line.** `AuthMailer.sendNewDeviceSignIn` accepted
`ip: string | null` and `whereAndWhen` rendered whatever it was handed. Measured against the built
module, *after* the user agent had been removed:

```
newDeviceSignIn  ip=BENIGN                     link: false
newDeviceSignIn  ip=URL                        link: true
passwordChanged  name=URL ip=BENIGN            link: true
passwordChanged  name=BENIGN ip=URL            link: true
passwordChanged  both BENIGN                   link: false
```

So ruling 70's newly-widened test went red on four notices, and `ipAddress` — not the display name
— was the carrier on all four, `newDeviceSignIn` included. **H2 would have been only half closed.**

This is carry-forward ruling 22's shape: a right decision with a false reason written beside it.
It is also the same shape as the carve-out being withdrawn — a property of today's caller, treated
as a property of the code.

**Fixed, in-subject, by enforcing the claim rather than asserting it.** `renderableIpAddress`
renders the value only when it matches an address literal (`^[0-9a-fA-F.:]{3,45}$`) and `not
recorded` otherwise — the same answer an absent one gets. It is deliberately a shape check and not
a parser: it does not need to accept every legal address, only to make it impossible for that line
to carry a sentence, a URL or markup. Re-measured:

```
newDeviceSignIn  ip=URL                        link: false
passwordChanged  name=BENIGN ip=URL            link: false
```

**What remains open, asserted from both sides rather than described.** `passwordChanged`,
`mfaEnabled` and `mfaDisabled` still greet by display name, which is free text. That is ruling 70's
existing open item, which the ruling assigns to Task 10 and whose reasoning reaches Task 11's two
MFA notices. **None of the three has a shipped caller** — and because that is the exact sentence
which was false about `newDeviceSignIn`, the docblock states it as a checkable fact
(`grep -rn "sendPasswordChanged\|sendMfaEnabled\|sendMfaDisabled" apps/api/src` returns nothing)
rather than as reassurance. The new block asserts that every *other* field is clean **and** that
the name is not, so it cannot go vacuous and closing it turns a test red.

I did not widen scope to remove `recipientName`: it binds two later tasks, and the disposition did
not authorise it. **This is the item I would most want a second opinion on.**

---

## 4. M3 — accepted, and where it is now named

No code changed. The disposition is explicit that naming it is the deliverable, and that it is not
closable without the Phase 4 queue: the difference is a real SMTP send happening on the response
path, which is the same disposition the resend endpoint's equivalent residual already carries.

Named in three places, none of which mentioned it before:

- `security/authentication.md` §2 — the residual list, which read "Two residuals, both measured and
  both open" and now reads "Three residuals, all open".
- `security/authentication.md` §7 — the burst-notice paragraph, which now says outright that the
  byte-comparison apparatus around this endpoint cannot see this distinction because it is in the
  wall clock rather than the response.
- This file.

Both bounds are recorded rather than used as an argument to ignore it: reaching it costs five
failed attempts against one address where the resend's costs a single request, and the per-account
window is 5 per 15 minutes. It is structural and no test here can see it — the harness substitutes
an in-memory mailer.

---

## 5. L7 — documented, not fixed

The arithmetic, in `security/authentication.md` §7 and referenced from `abuse-prevention.md` §1:
20 attempts per 15 minutes per IP, 5 attempts per lock, so four locks per window; holding an
account at the 30-minute cap costs 5 attempts per account per 30 minutes, so roughly **eight
accounts held permanently locked from a single address**.

Both documents previously presented the two windows' independence as though it satisfied §7's
"one attacker cannot lock out a whole tenant". Independence bounds the damage; it does not prevent
it, and what actually prevents it is the cost of acquiring addresses, which is outside this
control. A control described as stronger than it is will not be re-examined by the person who most
needs to.

---

## 6. Verification, re-run on the finished tree

All eleven, exit codes captured outside a pipe (`out=$(pnpm <cmd> 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **81 test files, 1268 tests** |
| `pnpm check:specs` | 0 | `99 spec files, each claimed by exactly one of: unit, integration, ui. No banned .test.* spellings.` |
| `pnpm test:integration` | 0 | **18 test files, 286 tests** |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 10`; byte-identical |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `383 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | four services `Up (healthy)` |

`pnpm test:e2e` still has no row: no `apps/web` path is touched.

### Movement across the fix round

| | Before (`629f28d`) | After | Delta |
|---|---|---|---|
| Unit files / tests | 81 / 1252 | 81 / 1268 | +0 / +16 |
| Integration files / tests | 18 / 275 | 18 / 286 | +0 / +11 |
| `check:openapi` routes | 10 | 10 | 0 |
| `check:registry` models | 15 | 15 | 0 — **no migration** |

The atomic increment needed no schema change: `failedLoginCount` and `lockedUntil` already exist,
and what changed is the statement that writes them.

### Commits

| Commit | Findings |
|---|---|
| `048dfc5` | H1 |
| `9d281da` | H2 |
| `da19bb5` | lint and format follow-up to H2 |
| `e06ef2b` | M1, L1 |
| `aa142ca` | M2 |
| `d145eca` | M3, L2, L3, L4, L5, L6, L7 |

---

## 7. For the second reviewer

Where I would push hardest, in order:

1. **§3 — the IP-address carrier.** A finding the dispositions did not predict, fixed in-subject
   with a shape check. Is `renderableIpAddress` the right layer, and is refusing to render an
   unparseable address the right failure? The alternative — validating at
   `requestContextOf` — would bound every consumer rather than this one.
2. **The three notices that still greet by display name.** I left them and asserted the residual
   from both sides rather than widening scope into Tasks 10 and 11. That is a judgement call about
   scope, and the reviewer who disagrees should say so now.
3. **H1's remaining race**, recorded in the H1 commit message and in `login.service.ts`: a
   **correct** password fired in parallel with the burst that locks the account can still be
   admitted, because the success path checks `isLocked` from the same pre-hash read and does not
   take the row lock. Bounded — reaching it requires the password, and with the password an
   attacker can simply wait the lock out — but it is a real window and nothing tests it.
4. **The fake in `identity-fakes.ts`** now applies the increment and evaluates the predicate. Its
   comment says it models neither the row lock nor the re-evaluation, and that the integration lane
   owns that property. Check that the unit assertions do not quietly depend on the fake's version
   of the semantics.
