# Phase 2 · Task 6 — fix round

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Branch `feat/phase-2-task-06`, on top of the review at `57e1529`. Fixes committed
as `660f835`. Not pushed, no PR. Task 7 still not started.

Six findings from [`review.md`](review.md) were routed for fix. All six are addressed. One of them
turned out to be true in a **different way** than the review described, and that difference is
recorded in §1 rather than smoothed over.

## 1. K1 — the absolute-clock invariant was undefended

**What the review found.** `session.service.spec.ts`'s
`rotate > inherits the absolute clock rather than restarting it` built its predecessor from `row()`,
whose `absoluteExpiresAt` is `new Date()` plus the same seven-day lifetime `rotate` computes
microseconds later. The reviewer set `startsRealSession = true` at `session.service.ts:569` and
watched the whole suite stay green, with `PROBEDELTA 0` on that test.

**What I changed.**

- `session.service.spec.ts`: the predecessor's cap is now **two hours away** — a value no restart
  can coincidentally reproduce — and the test asserts both exact equality with it and that the
  granted window is under three hours, so a future edit cannot make the equality vacuous again.
- A new unit test, `does not extend a remember-me session on an ordinary rotation`, plants a 40-hour
  cap on a `rememberMe` session. This is the path where the reviewer's mutant silently added 23 days
  while the test that ran it asserted `rememberMe`, `ip`, `userAgent` and `userId` and never looked
  at a clock.
- `session.service.integration.spec.ts`: a new test,
  `rotation > carries the absolute cap forward into the successor row`, asserting against the row
  Postgres holds rather than the value the service returned, plus that the idle clock is clamped to
  it. The review is exactly right that the integration suite had **no** rotation-inheritance
  assertion at all.

**Mutation kill.** The reviewer's literal mutation (`startsRealSession = true`) now dies — but on
the K2 guard, because making every rotation a promotion trips the new `mfaCompletedAt` requirement.
That is the wrong reason for this finding, so I isolated the clock with a mutation the K2 guard
cannot catch: leave `startsRealSession` correct and make the ternary restart unconditionally
(`const absoluteExpiresAt = true ? new Date(...) : predecessor.absoluteExpiresAt`).

Against the fixed spec, exit **1**:

```
   × rotate > inherits the absolute clock rather than restarting it 7ms
     → expected '2026-09-02T12:18:01.687Z' to be '2026-08-26T14:18:01.687Z'
   × rotate > does not extend a remember-me session on an ordinary rotation 2ms
     → expected '2026-09-25T12:18:01.695Z' to be '2026-08-28T04:18:01.694Z'
      Tests  2 failed | 37 passed (39)
```

The second line is a 28-day cap where 40 hours was granted. Both die on the clock assertion itself.

**Where I measured something different from the review, and it matters.** I ran the same clock-only
mutant against the **pre-fix** tree — `git show HEAD:` for both `session.service.ts` and
`session.service.spec.ts`, mutant applied, nothing else changed:

```
=== HEAD spec + HEAD service + clock-only mutant ===
   × rotate > inherits the absolute clock rather than restarting it 11ms
      Tests  1 failed | 34 passed (35)
UNIT_EXIT=1

=== integration, same mutant ===
      Tests  20 passed (20)
INT_EXIT=0
```

The old unit test **did** catch it on that run. The reason is the one the review's own `PROBEDELTA 0`
records: `row()`'s `new Date()` and `rotate`'s `new Date()` are usually a millisecond or more apart,
and the assertion compares ISO strings at millisecond precision — so the old test was **flaky, not
uniformly blind**. It caught a restart when the two readings straddled a millisecond boundary and
missed it when they did not. The reviewer measured the miss; I measured the catch. The finding is
real either way and the fix is the same: a deterministic two-hour cap replaces a coin flip against
the clock. The integration result needs no such qualification — `INT_EXIT=0` confirms that suite was
blind, exactly as reported.

Mutants reverted. `grep -c "MUTANT ONLY" apps/api/src/modules/auth/session.service.ts` returns `0`.

## 2. K2 — `rotate` promoted `PENDING_MFA` to `ACTIVE` on default arguments

**What the review found.** `rotateSessionInputSchema` defaulted `status` to `'ACTIVE'`, and the
`startsRealSession` exception never inspected `mfaCompletedAt`. `rotate({ sessionId })` on a
ten-minute pending session returned a thirty-day `ACTIVE` credential with `mfaCompletedAt: null`.

**What I changed, in `session.service.ts`.**

1. **The default is gone.** `status: z.enum(SESSION_STATUSES)` — required, as it already was on
   `issueSessionInputSchema` twelve lines above for exactly this reason (carry-forward ruling 6).
   Every call site in both specs now names it.
2. **The promotion must carry its evidence.** A `PENDING_MFA` -> `ACTIVE` rotation with no
   `mfaCompletedAt` **throws** `MFA_EVIDENCE_REQUIRED`, before any row is written and before the
   cache is poisoned, so a refused promotion leaves the predecessor exactly as it found it.
3. The docblock's rationale now describes what the code does: the sentence about MFA *succeeding*
   used to justify a condition that only compared two status values.

**Why it throws rather than returning `null`.** `null` is this method's word for "there was nothing
to rotate". A caller that got the promotion wrong would read a `null` as a lost race and never find
the bug. The precedent is `assertUserPrincipal` in `packages/contracts/src/principal.ts`: a
privileged path reachable by omission is only safe if reaching it is loud. `MFA_EVIDENCE_REQUIRED` is
exported so a spec asserts the wording without duplicating it, the same device that file uses.

**Tests added**, all in `session.service.spec.ts`:

- `REFUSES to promote a pending session to ACTIVE with no proof a factor was used` — names the
  bypass, and asserts no row was created.
- `lets a pending session rotate while staying pending` — the negative control, so refusing *every*
  rotation of a pending session cannot pass for a fix.
- `requires the caller to state the successor status — ruling 6, one layer up` — carries a
  `@ts-expect-error`, so the omission is a compile error and a runtime refusal both.
- `starts a fresh absolute clock when MFA completes` now also asserts `mfaCompletedAt` is recorded
  on the successor.

**Watched failing first**, before the implementation existed, exit **1**:

```
   × rotate > REFUSES to promote a pending session to ACTIVE with no proof a factor was used 8ms
     → promise resolved "{ session: { …(9) }, …(2) }" instead of rejecting
   × rotate > requires the caller to state the successor status — ruling 6, one layer up 1ms
     → promise resolved "{ session: { …(9) }, …(2) }" instead of rejecting
      Tests  2 failed | 37 passed (39)
```

**Mutation kill.** Removing the guard is the fix's own inverse; the two tests above are its kill
evidence. The reviewer's `startsRealSession = true` mutation now also dies here, on five tests at
once, all reporting `Refusing to promote a PENDING_MFA session to ACTIVE without an mfaCompletedAt`.

## 3. K3 — the undisclosed revocation-immediacy residual in `revokeMany`

**What the review found.** With Redis healthy, a session created between `listLiveForUser` and
`revokeLiveForUser` is revoked in Postgres but never tombstoned, because `poison` only ever received
the hashes the enumeration returned. Its warm entry served it for up to `SESSION_CACHE_TTL_SECONDS`.
Revocation immediacy is a Phase 2 exit criterion; this was it failing with no outage.

**What I changed.**

- `session.repository.ts`: `revokeLiveForUser` now returns `{ count, tokenHashes }` instead of a
  number. It runs the `updateMany`, then reads back the rows carrying **its own `revokedAt` stamp** —
  this call's `new Date()`, written by the update and then used as the predicate — so the second
  query returns precisely the rows the first one changed. Two concurrent bulk revocations carry
  different stamps and cannot claim each other's rows; a collision would only poison a key for a
  session that is revoked anyway.
- `session.service.ts`: `revokeMany` poisons twice. The first pass is unchanged and still runs before
  the write, which is what keeps the enumerated sessions fail-closed from the moment the call starts.
  The second poisons the hashes actually revoked. A stale live write landing between the passes
  loses — `writeLive` is a Lua compare-and-set that refuses to run over a tombstone, and the second
  pass puts one down after the row is committed.
- `SessionWhere.revokedAt` widened from `null` to `null | Date` for the read-back predicate.

**Test added**, reproducing the reviewer's PROBE_A as a committed test:
`bulk revocation > tombstones a session created INSIDE the enumerate-then-revoke window` in
`session.service.integration.spec.ts`. The interleaving is forced rather than raced: the enumeration
is proxied so the interloper is created and resolved (warming its entry) before the revocation
continues. It asserts the count is **2** where **1** was enumerated — the Postgres half was always
fine — and then that the interloper's next resolve is refused and its key holds `revoked`.

**Watched failing first**, exit **1**:

```
   × bulk revocation > tombstones a session created INSIDE the enumerate-then-revoke window 34ms
     → expected { outcome: 'resolved', …(1) } to deeply equal { outcome: 'revoked' }
      Tests  1 failed | 21 skipped (22)
```

A session the system considered revoked resolved as valid — the review's finding, reproduced.

The unit test `poisons every affected session before revoking any row` was replaced by
`poisons twice: every enumerated session before the write, and every revoked one after`, which
asserts two tombstones on each side of the `updateMany` rather than two in total.

## 4. C1 — the "is not revoked" sentence

`revokeAllForUser`'s docblock said a login landing in the window "creates a session this call never
saw", implying it survives. It does not: `revokeLiveForUser` is one `updateMany` whose predicate is
evaluated at execution time, and the review measured the count coming back as **2** where **1** was
enumerated. What that session was not was **tombstoned**.

The docblock now says exactly that, records that `revokeMany` poisons twice and that the second pass
covers it, and states what genuinely remains the caller's ordering problem: **a session created
after the write** is not revoked and nothing here could revoke it, so a password change must write
the new hash before calling. Task 10 owns that ordering; Task 14 owns the equivalent for member
removal.

**`report.md` was not edited.** It is a dated record of what was said at the time and its own banner
says so; this file and the rulings carry the correction.

## 5. C2, C3, C4 — three false sentences

**C2 — `packages/config/src/env.ts`.** The comment attributed its rationale to `checkArgon2Cost`,
which has no docblock (the sentence it paraphrased is on `checkMailCredentialPair`), claimed
`describeIssue` renders a `custom` issue as "failed validation (custom)", and said "`too_big`" of a
function whose first issue is `too_small`. I re-read `load-env.ts:72-80` and the review is right —
that branch reads `issue.params.rule` and returns it, and `git show 2fceaaa:packages/config/src/load-env.ts`
contains it, so it predates this branch. The comment now records the real reason for the typed
codes: they carry the **boundary as structured data**, so `describeIssue` renders "must be at least
`<minimum>`" / "must be at most `<maximum>`" (`load-env.ts:52-55`) and the operator is told the
number their other variable has forced, rather than having it restated in prose that could drift.
The wrong attribution and the wrong issue-code name are corrected, and the correction states what
was wrong rather than quietly replacing it.

**C3 — `apps/api/src/modules/auth/cookies.ts`.** The comment claimed `Max-Age` is digits only while
the guard emitted `Max-Age=NaN`. Measured before the fix, exit **1**:

```
   × serialiseSessionCookie > emits digits for a non-finite Max-Age rather than the word NaN 5ms
     → expected '__Host-session=abc123; HttpOnly; Secu…' to contain '; Max-Age=0'
Received: "__Host-session=abc123; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=NaN"
   × serialiseSessionCookie > emits only digits for every Max-Age it will accept 1ms
     → expected '…' to match /; Max-Age=\d+$/
      Tests  2 failed | 14 passed (16)
```

`deltaSeconds` now returns `'0'` for any non-finite input. It floors rather than throwing: `0` is a
cookie the browser discards immediately, which is the fail-closed direction, and a serialiser is the
wrong layer to abort a response over arithmetic it was handed. Two tests keep it — one on the
specific values, one asserting the general form `/; Max-Age=\d+$/` for every value the function
accepts. The comment now records that the guard did not deliver what it claimed and why a `NaN`
arrives.

**C4 — `.claude/security/authentication.md`.** "Every bullet in §3 below has a test" was false by one
bullet: `Session.createdAt` had no assertion in either suite. I both narrowed the sentence and closed
the gap. The banner now says which bullet was short and that it no longer is; the integration test
`the stored row > holds only a hash` asserts `createdAt` and `lastSeenAt` alongside `ip` and
`userAgent`, and a new test,
`the stored row > gives a rotated successor its own createdAt, not the predecessor's`, asserts the
distinction the `/settings/security` list depends on.

Two further sentences in the same banner became false through this fix round and were corrected in
the same change: the twenty-integration-test count is now twenty-three, and "**`PENDING_MFA` is
enforced by nothing yet**" is now "only half enforced" — the promotion guard is enforcement, while
the rule that a pending session authenticates nothing except the MFA endpoint remains Task 7's.

## 6. ADR-0005 stays unedited

Confirmed and left alone. `git diff 57e1529..660f835 -- .claude/decisions/` is empty.
`.claude/security/authentication.md` §3's banner gains one paragraph recording that ADR-0005's
mechanism sentence predates this measurement, that an accepted ADR is superseded rather than
rewritten, and that no superseding ADR is owed because the decision it records — opaque server-side
sessions, a cached lookup, immediate revocation — is unchanged and correct. The tombstone is how its
promise is kept. Nothing else in `.claude/decisions/` was touched.

## 7. Verification after the fixes

Run on the finished tree at `660f835`, working directory clean, compose stack up. Each code captured
outside a pipe (`out=$(cmd 2>&1); code=$?`).

| Command | Exit | What it printed |
|---|---|---|
| `pnpm format:check` | **0** | `All matched files use Prettier code style!` |
| `pnpm lint` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | **0** | `Tasks: 14 successful, 14 total` |
| `pnpm test` | **0** | `Test Files 63 passed (63)` · `Tests 917 passed (917)` |
| `pnpm check:specs` | **0** | `77 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | **0** | `Test Files 14 passed (14)` · `Tests 192 passed (192)` |
| `pnpm build` | **0** | `Tasks: 8 successful, 8 total` |
| `pnpm check:openapi` | **0** | `"routes":4` · byte-identical |
| `pnpm check:registry` | **0** | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `pnpm check:secrets` | **0** | `332 tracked files, no credential-shaped literals` |
| `docker compose ps` | **0** | four containers, all `Up 22 hours (healthy)` |

`pnpm test:e2e` still not run and still not expected: no `apps/web` path was touched by this round
either.

### Counts across the fix round

| Suite | Before review (`c471498`) | After fixes (`660f835`) | Delta |
|---|---|---|---|
| `pnpm test` | 63 files / 911 tests | 63 files / **917** | **+6** |
| `pnpm test:integration` | 14 files / 189 tests | 14 files / **192** | **+3** |

The +6 unit tests: two cookie `Max-Age` tests, and four on rotation (remember-me cap, the MFA-bypass
refusal, the pending-stays-pending control, the required-status refusal). One existing unit test was
rewritten rather than added (`poisons twice: …`). The +3 integration tests: the absolute-cap
inheritance, the enumerate-then-revoke window, and the successor's own `createdAt`.

### Redis hygiene, ruling 33

No `DEL`, `FLUSHDB` or `FLUSHALL` was issued against the compose instance by me. After the full
integration suite, `redis-cli --scan --pattern 'session:v1:*'` returns **0** keys.

## 8. What I disagree with, and what I could not close

**Nothing in the six findings is disputed.** All six reproduce.

**One correction to the review's account, in the review's own favour on the finding and against it on
the mechanism.** K1's claim that the old test could not see a restart is right about the outcome and
imprecise about the cause: the assertion was flaky, not blind — it compares two `new Date()` readings
at millisecond precision, so it catches a restart whenever they straddle a millisecond boundary. The
reviewer's `PROBEDELTA 0` is a measurement of the miss; my `HEAD spec + HEAD service + clock-only
mutant` run at §1 is a measurement of the catch. A test that passes or fails on a millisecond
boundary is worse than one that always fails, not better, so the finding stands and the fix is
unchanged — but "the assertion is vacuous" would be the wrong sentence to carry forward, and this is
the one I am carrying forward instead.

**Still open, unchanged from `report.md` §10, and not made worse by this round.**

- The Redis-unreachable revocation residual. If Redis is down when a revocation runs, the row is
  revoked and no tombstone can be written, so an entry cached before the outage serves until it
  expires — at most `SESSION_CACHE_TTL_SECONDS`, default 60. K3's second poison pass does not touch
  this: it needs the same Redis.
- A session created **after** `revokeLiveForUser`'s write is genuinely not revoked. That is the
  caller's ordering problem and now says so accurately (§4). Task 10 and Task 14.
- `PENDING_MFA` is only half enforced. The promotion now needs evidence; the rule that such a
  session authenticates nothing except the MFA verification endpoint is Task 7's and does not exist.
- Nothing calls any of this. `check:openapi` reports four routes and `AuthModule` registers no
  controller.

## 9. Rulings this round adds

9. **`rotate` requires an explicit successor `status`, and refuses a `PENDING_MFA` -> `ACTIVE`
   promotion with no `mfaCompletedAt`.** Binds Task 10 (password change), Task 11 (MFA completion —
   it must pass the completion instant, not merely name `ACTIVE`), Task 13 (organisation switch) and
   Task 17. A rotation that raises privilege carries the evidence; every other rotation names the
   status it is keeping.
10. **Bulk revocation poisons twice, and the second pass is keyed on the write's own `revokedAt`
    stamp.** Any later change to `revokeLiveForUser` that stops returning the hashes it revoked
    reopens a measured revocation-immediacy hole with Redis healthy.
11. **An assertion built from two `new Date()` readings taken microseconds apart is a coin flip, not
    a test.** K1's fix is to plant a value the code under test cannot coincidentally produce. The
    same shape exists anywhere a fixture and the code both read the clock — worth checking in Task 7
    and Task 9, which will both assert on session timestamps.
