# Task 11 fix round — what changed, and what was measured

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02, over [`review.md`](review.md)'s 1 High, 6 Medium and 8
Low, with dispositions in [`fix-brief.md`](fix-brief.md).

## H1 and M1 — a per-user advisory lock, and the mutation in both directions

Both defects are one shape: a read-check-write across two statements at Postgres READ COMMITTED, in
the two write paths the brief did not name and nobody raced. `MfaEnrolmentService.lockUser` takes
`pg_advisory_xact_lock(hashtext('mfa:user:<id>'))` as the first statement inside all four
transactions — the same device `mfa-verification.service.ts` already used one file over, keyed on
the pending session instead of the user. `enroll` also re-reads the confirmed-factor check **inside**
the lock, because the pre-transaction read is advisory and a sibling can confirm between the two.

Two new integration tests, both concurrent (`Promise.all`), and `mfa.store.ts`'s narrow port was
widened deliberately rather than bypassed — the `orderBy` is now **required** by the type, so L6
cannot be reintroduced by omission.

**Ruling 66, both states, pasted.** Mutation: all four `await this.lockUser(...)` calls removed.

```
MUTATION(lock removed), both tests:
  × two concurrent enrolments never answer 500, and leave exactly one factor
    → expected 500 to be less than 500
  ✓ two concurrent regenerations …                     ← PASSED under mutation
```

**The H1 test as first written was not good enough, and measuring it is what showed that.** Run in
isolation against the unlocked code it reproduced the defect in only **two runs out of three**:

```
run 1 EXIT=1  → expected 20 to be 10
run 2 EXIT=1  → expected 20 to be 10
run 3 EXIT=0                                            ← missed it
```

That is carry-forward ruling 88 again: over HTTP the destructive interleaving is a distribution, not
a determinism. A guard that misses a High one time in three goes green on the regression that
reintroduces it. The test was rewritten to run **five rounds**, asserting the invariant after every
round — ruling 88's approved shape, assert what must hold every time rather than what happened once.
Re-measured under the same mutation:

```
MUTATED run 1 EXIT=1  → expected 20 to be 10
MUTATED run 2 EXIT=1  → expected 20 to be 10
MUTATED run 3 EXIT=1  → expected 20 to be 10
```

Mutation reverted (`git diff` confirms the four lock calls are back), and green three times running:

```
REVERTED run 1 EXIT=0
REVERTED run 2 EXIT=0
REVERTED run 3 EXIT=0
```

## M4 — the eighth notice template

`mfaRecoveryCodesRegenerated`, wired into `regenerateRecoveryCodes` after the commit (ruling 44) and
carrying no display name (ruling 85). This reverses the implementer's deferral and my own brief's
silence: the reviewer sized it correctly. Regeneration was the only MFA state change that told the
owner nothing, and the only one an attacker holding a stolen session and the password would prefer
*because* it is silent.

`registry.ts`'s docblock claims a template is added by writing one line there and one in
`registry.spec.ts`'s `CASES` table, inheriting every assertion in that file by existing. **That
claim is now tested rather than asserted**: adding the entry turned 16 tests red until the four
lists were updated, and unit tests went 1501 → **1513** — twelve assertions the new template
inherited without one being written for it.

## M5 — the arithmetic

A million codes, three live per ±1 window, is 333,333 expected guesses; at 60/hour that is 5,556
hours, **0.63 years**, not 630. Corrected in `rate-limit.config.ts` and `abuse-prevention.md` §1,
and both now name the control that actually bounds this: reaching the route costs a `PENDING_MFA`
session, minting one costs a login, and login is 5 per 15 minutes per address — about 4.6 months per
account however many IP addresses the attacker owns, with an `MFA_CHALLENGE_FAILED` row for every
attempt. The document keeps a block quote recording that it said 630, because a security document's
arithmetic is what a future reader tunes the limit against.

## M6 — the rotation claim

`security/authentication.md` §5's bullet was labelled **Built** and is now **Partly built**. The
column is the *precondition* for an incremental rotation; the rotation is not built, the process
holds one key, and rotating today makes every enrolled factor undecryptable **silently** —
`mfa/verify` answers the ordinary `MFA_INVALID`, indistinguishable by design from a wrong code,
while recovery codes keep working. `.env.example` now leads with **DO NOT ROTATE THIS VALUE YET**
instead of advertising a capability.

## M3 — the refusal is byte-identical and not time-identical

The comment claimed four refusal modes were "indistinguishable to the caller". Byte-identical, yes,
across eight modes. Not time-identical: `resolve()` fails before any Argon2 work, so a dead token
costs ~3 ms and a live one presented with a recovery-shaped code costs ten Argon2id verifications —
370 ms at harness parameters, ~2.5 s at production. The comment now states the residual precisely:
it is "is this token live" (and therefore "has the five-attempt lock fired"), and it is **not**
"which account", "does this address exist", or "how many codes remain" — the last is what D7's
padding closes. Not fixed by padding `resolve()`: that would hand an unauthenticated caller ~2.5 s
of CPU per request, a worse defect than the one it closes.

## M2 — the D4 sentence, not a probe

No 25-round probe was committed. The reviewer proved both stages of the predicate load-bearing by
mutating the shipped code in both directions, which is reproducible from the tree and a stronger
artefact than a survivor count from a probe nobody can re-run. The report's D4 paragraph is
corrected below instead.

## The Lows

- **L1** — "nothing has ever tested" `GET /auth/session` with a pending token. False: Task 9's
  `auth.login.integration.spec.ts` tests it in the strongest form, presenting the token *as* a
  session cookie. Corrected in the spec docblock and in `api/authentication.md`; the claim
  originated in my brief, which is a dated record and is corrected here rather than edited.
- **L2** — the spec docblock said the replay probes use **one** pending session; they use two, and
  the docblock's own reason argues for two. Corrected to match the code.
- **L4** — the flaky replay test recomputed the confirming code after `enableMfa` returned, so a
  step rollover in between made a legitimate 200 look like a failure. `enableMfa` now returns the
  code it actually confirmed with.
- **L5** — three selects read `emailVerifiedAt` and discarded it. Decided rather than deleted: these
  routes are reachable only behind an `ACTIVE` session for the account being mailed and the notice
  **is** the detection control, so they send ungated, matching `password-change.service.ts`. Ruling
  71's gate stays on the new-device notice, which an unauthenticated caller can provoke. The port
  now offers a recipient delegate that cannot select the column, so the ambiguity cannot return.
- **L6** — `orderBy: { createdAt: 'asc' }` on the recovery-code read, required by the port type.
- **L7** — ADR-0018 cited `security/authentication.md` §5 for the `rememberMe` gap;
  `awk`-ing that section returns nothing. Corrected to `api/authentication.md` §2, which is where
  it is.
- **L3, L8** — corrections to `report.md`, appended there as dated notes rather than silent edits.

## Verification after the fix round, 2026-09-02

Every command re-run on the finished tree, exit codes captured outside a pipe.

| Command | Exit | What it proves |
|---|---|---|
| `pnpm format:check` | 0 | Prettier style across the workspace. |
| `pnpm lint` | 0 | 14 tasks; 13 cached, 1 executed. |
| `pnpm typecheck` | 0 | 14 tasks. The widened `MfaStore` port compiles and the three narrowed selects satisfy it. |
| `pnpm test` | 0 | **88 files / 1513 tests**, up from 1501 — the twelve the new template inherited. |
| `pnpm check:specs` | 0 | 108 spec files, each claimed by exactly one project. |
| `pnpm check:secrets` | 0 | 404 tracked files, no credential-shaped literals. |
| `pnpm test:integration` | 0 | **20 files / 354 tests**, up from 352 — H1's and M1's races. 139s. |
| `pnpm build` | 0 | 8 tasks. |
| `pnpm check:openapi` | 0 | Byte-identical, **18 routes** — the fix round added no route. |
| `pnpm check:registry` | 0 | 15 models. No table and no column added by the fix round. |
| `docker compose ps` | 0 | All four services `Up (healthy)`. |

No `pnpm test:e2e` row: `git diff --stat main..HEAD -- apps/web packages/ui` is still empty.

**The migration is still unapplied.** The fix round opened none and touched no migration file.

## Not fixed, and carried

Unchanged from [`fix-brief.md`](fix-brief.md): the promoted session's 7-day lifetime (gap 1, needs a
`Session` column or a `rotate` parameter), disable not revoking sessions (gap 3, reviewer agrees
with the decision), the recovery path's sequential-Argon2 wall clock (gap 4, reviewer's explicit
verdict is *acceptable as shipped*), and incremental key rotation itself (M6 is the wording; the
key-map lookup is an ADR nobody owns yet).

**This fix round has not itself been reviewed.** Same status Task 10's last three commits carried:
each change was measured with the mutation re-run and pasted, but that is the author checking their
own work.
