# Task 10 fixes — what the fix round changed

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-09-01, on `feat/phase-2-task-10`, from `2df56b7`.
Five commits: `e46a865` (H1), `a2d45ef` (M1), `f37a455` (M2), `0028e41` (M3), `63a2bea` (Lows and
prose).

Everything in [`fix-brief.md`](fix-brief.md) is fixed except **L4**, which is recorded as
instructed, and **one half of M1's disposition**, which could not be built as specified and is
reported in full rather than faked.

---

## 1. One row per finding

| | Finding | What changed | What establishes it |
|---|---|---|---|
| **H1** | A completed reset left in-flight old-password logins holding live sessions | Login re-reads the credential after `SessionService.issue` returns; if it has moved, it revokes the session it just issued and answers `INVALID_CREDENTIALS`. The D8 rehash moved to before the issue so the comparison knows the hash in force. | Reviewer's probe kept in the suite: 5 rounds × 5 racing logins, counting live rows **and** driving every returned cookie at `GET /auth/session`. **16 survivors → 0.** Mutation L (disable the check): **14 survivors, RED**. |
| **M1** | The reset's compare-and-swap was asserted only by a fake | A real competing writer now exists (weak-parameter credential → every racing login rehashes). `identity-fakes.ts`'s false claim corrected. | Measured 20 rounds: predicate present **3/20** refusals, predicate deleted **0/20**. Branch reached. **Not a deterministic kill — see §3.** |
| **M2** | `invitation` rendered a stored `User.name` into the text part of a live-link message | `inviterName` removed from `InvitationInput`; copy is now "You have been invited to join <org>". `organizationName` kept and pinned from both sides. | Mutation M (put the field back and render it): **RED in three blocks** — whole-registry ruling 70, the token-link prescribed payload, and the new organisation-name residual. None caught it before. |
| **M3** | `change-password` had no per-account bound, no lockout and no notice | Five **consecutive** refused attempts in 15 minutes send the owner `failedLoginBurst`, once per burst, counted from `PASSWORD_CHANGE_FAILED` audit rows. `User.failedLoginCount` untouched. | Mutation N (suppress the notice): **RED in both lanes** — two unit tests and the integration test. Integration test asserts 5 rows, one notice, counter 0, lock null. |
| **L1** | `ownSessionRotated: true` written before the rotation ran | Field **removed**. Nothing true can be written there; the action name already distinguishes change from reset. | The reviewer's own measurement (`ownSessionRotated: true` with nothing rotated) no longer has a field to be about. |
| **L2** | The unit lane cannot honestly evaluate "delete the predicate" | Recorded in `identity-fakes.ts` with the honest alternative mutation. | Reviewer measured 7 red unit tests, none the concurrency one. |
| **L3** | Breach check + Argon2id paid before the token is validated | Ordering kept (deliberate), consequence written at the site and beside the figure in `abuse-prevention.md` §1. | — |
| **L4** | "No `Credential` row → set a password" is a Phase 11 SSO bypass | **RECORDED, NOT FIXED.** Both halves now written at the site and in `security/authentication.md` §6, named as binding Phase 11. | — |
| **L5** | A completed reset proved mailbox control and did not record it | The reset stamps `emailVerifiedAt` (with the consume instant), never restamps, and records `confirmedAddress` in the audit metadata. | Three unit tests, including one that the already-confirmed instant is not overwritten. |
| **L6** | `audit.md` §4 off by one for the change row | Document corrected: the change row **excludes** the caller's own session. | Code was already right; `counts the OTHER sessions` pins it. |
| **L7** | A completed reset did not clear `lockedUntil` | Reset clears `lockedUntil` and `failedLoginCount`. Administrative locks deliberately untouched — D4 refuses those links. | Unit test: locked account completes reset, lock null, counter 0. |
| **P1** | `password-reset.service.ts` asserted H1's window did not exist | Replaced with what is true: the ordering is **necessary and not sufficient**; it and login's post-issue check are a pair. | — |
| **P2** | `security/authentication.md` §6 under-reported H1 fivefold | §6 rewritten against the fixed code: 25 of 25, up to 30 days, window one Argon2id verification wide and growing with the parameter. | — |
| **P3** | `session.service.ts` carried the original overstatement | Correction carried at the site (ruling 53's precedent), naming the mechanism that keeps the promise and warning Task 14 that its equivalent does not exist. | `git diff` on that file is no longer empty. |
| **P4** | `api/authentication.md` §9 stated the revocation flatly | Now true, and both the document and the controller docblock say which two mechanisms make it true. | OpenAPI `description` unchanged and accurate; `check:openapi` byte-identical at 13 routes. |
| **P5** | "OVER THE WHOLE REGISTRY, WITH NO EXEMPT LIST" | Corrected, and it says which block covers what. | That sentence is why nobody noticed M2. |
| **P6** | `identity-fakes.ts` named a probe that did not cover the reset | Corrected, with what the new probe does and does not establish. | — |
| **P7** | Ruling 70: "the invitation, which already names nobody" | **Reported, not written** — the orchestrator owns the register. | `renderInvitation` named the inviter until `f37a455`. |

---

## 2. Two unpredicted reds, both investigated rather than silenced

The dispositions said to stop and report rather than reason a red into silence. Two occurred.

**1. `writes it under a COMPARE-AND-SWAP on the hash it verified` went red when H1 landed.**
Its scenario is a sibling changing the password mid-flight, which is exactly what H1 now refuses —
so the throw is correct behaviour and the test simply never expected it. Its own assertion still
holds and still discriminates the rehash predicate (with the predicate defeated, the rehash
overwrites the sibling's hash with a digest of the old password and `toBe(changed)` fails). The
test now pins both halves and additionally asserts the session was taken back. **No production
behaviour was changed to make it pass.**

**2. `resets after a SUCCESSFUL change` went red against my own first cut of M3.**
I had counted every failure in a fifteen-minute window. The disposition said **consecutive**, and a
window is not that: a user who mistypes four times, succeeds, then mistypes once more would have
been told somebody was guessing at their account. The test was right and the implementation was
wrong. Failures are now counted from the later of the window start and the last successful change.

That red produced two follow-on corrections in `identity-fakes.ts`, both worth recording because
they are the same class of defect as the ones this ledger keeps naming:

- Every audit row the fake wrote shared one millisecond, so `createdAt` ties erased the ordering
  the production query depends on. The fake now uses a monotonic clock **anchored to real time**.
  A fake that collapses timestamps makes a property false by construction just as surely as one
  that makes it true.
- The boundary comparison is now `gt`, not `gte`, so a successful change's own row cannot drag the
  failures preceding it into the count.

---

## 3. What the dispositions asked for that I could not deliver

**M1's second half: "delete the predicate and paste the red output."**

I built the probe and measured it both ways. The predicate is genuinely reachable — 3 of 20 rounds
with a real competing writer — and deleting it produces 0 of 20. So the mechanism is live and the
branch executes. **But it is a distribution, not a deterministic kill**, because the window between
the reset's in-transaction credential read and its write is one statement wide and whether a
competing commit lands inside it is scheduling.

An assertion on the refusal count would be flaky at roughly one run in twenty-five. Ruling 33 is
this repository's standing position on trading determinism for coverage, and a flaky red is worse
than an honest gap — it trains people to re-run.

What the committed probe asserts instead holds on every round: the account is never left with
neither password working, the reset's status code always agrees with the credential actually in
force, and a refusal leaves the link live so a retry succeeds. **Deleting the predicate does not
turn that red** — it changes which legitimate outcome occurs, not whether the end state is
coherent. The probe's docblock says exactly that rather than implying coverage it does not have.

I also tried to force the harmful interleaving directly (reset against concurrent
`change-password`, several rounds). The change loses on its own predicate every time, because its
pre-transaction phase is a verification *and* a hash where the reset's is a hash alone. The
reviewer reported the same. And the harm the reset's predicate prevents — silently overwriting a
credential write that landed after its read — is **not externally observable**, because a change
that committed *before* the reset's read is legitimately superseded and looks identical from
outside.

So the honest position: the reset's predicate is a defensive consistency measure that is now
exercised by a real second writer and cannot be pinned by a deterministic test. It is stated that
way in the code and here, and not claimed to be more.

---

## 4. What remains open after this round

- **`change-password` has H1's window and is protected only by timing.** Review measured 0
  survivors out of 16 and called it an accident, which it is: the change path pays a verification
  *and* a hash before its transaction, so its revoke lands after racing logins have already
  inserted. The same post-issue check belongs on any path that issues a session after verifying a
  credential. Not applied there this round, and named in `security/authentication.md` §6.
- **Task 14's member removal has the same shape and no equivalent check**, named at
  `session.service.ts`'s site so the next caller sees it.
- **L4 is deliberately unfixed** and binds Phase 11.
- **`organizationName` in the invitation** is caller-influenced text in a link-bearing message. It
  is kept, pinned from both sides, and binds Tasks 13 and 15.
- **A per-account 429 on `change-password`** is the right long-term answer to M3 and needs the
  limiter's per-principal stage that rulings 55 and 59 already owe. Not this task.
- **Ruling 51 carries H1's original overstatement** and should move with the correction. Ruling 70
  says the invitation "already names nobody", which was false (P7). Both are the orchestrator's.

---

## 5. Verification

Every command re-run on the finished tree, exit codes captured outside a pipe.

| Command | Exit | Output |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **83 files, 1362 tests** |
| `pnpm check:specs` | 0 | `102 spec files, each claimed by exactly one` |
| `pnpm test:integration` | 0 | **19 files, 323 tests** |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 13`, byte-identical |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `388 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | four services `Up (healthy)` |

`pnpm test:e2e` has no row: `git diff --stat main..HEAD` is empty for `apps/web` and
`packages/ui`. **No migration was opened** — the migrations diff is empty, and M3's counter reads
the existing audit table rather than adding a column.

### Mutations this round

| | Mutation | Result |
|---|---|---|
| L | Disable login's post-issue credential check | **RED** — 14 survivors across five rounds |
| M | Restore `inviterName` on the invitation and render it | **RED ×3 blocks** |
| N | Suppress the change-password burst notice | **RED** in both lanes |
| C2 | Delete the reset's credential predicate | Reachable (3/20 → 0/20) but **not a deterministic red** — §3 |

All reverted; `git status` clean.
