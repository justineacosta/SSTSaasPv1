# Task 10 implementer's report — password reset, change, and ruling 70 closed

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-08-31 at the head of `feat/phase-2-task-10`. **Committed by the
orchestrator on the implementer's behalf**: the harness refused the agent's write to this path, and
the agent reported that rather than routing around it with a shell heredoc. The content below is
the implementer's, transcribed verbatim from its hand-back; the orchestrator has verified none of it
in this file — that is the reviewer's first pass and the orchestrator's own verification run.

## Evidence, re-run on the finished tree with exit codes captured outside a pipe

| Command | Exit | Output |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **83 files, 1348 tests** |
| `pnpm check:specs` | 0 | 102 spec files, each claimed by exactly one project |
| `pnpm test:integration` | 0 | **19 files, 317 tests** |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | **`routes: 13`**, byte-identical |
| `pnpm check:registry` | 0 | 15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm check:secrets` | 0 | 388 tracked files, no credential-shaped literals |
| `docker compose ps` | 0 | four services `Up (healthy)` |

`pnpm test:e2e` has **no row** — the `apps/web` and `packages/ui` diffs are empty. **No migration
opened**, as the brief predicted. **No cross-tenant row to write**: nothing here is tenant-owned and
every audit row is a `PlatformAuditEvent`. **No RLS-dependent assertion** (ruling 75), so no spec
drives `appPrisma`.

## Two findings

**1. A concurrency probe that was green for the wrong reason.** The first version of
`LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT` used two sessions. Removing the compare-and-swap
entirely left it **green**: the winner revokes the loser's session, so the loser was refused 401 by
the authentication guard and never reached the predicate under test. That is ruling 74's trap walked
into again. Both requests now share one session, and the same mutation re-run is **RED**.

**The lesson is narrower than ruling 74 as written**: making a test concurrent is not enough — the
two requests must differ *only* in the property under test.

**2. D2's ordering narrows the racing-login window; it does not close it.** The brief and
`SessionService.revokeAllForUser`'s docblock both say that writing the hash first means a racing
login "cannot mint a session with the old credential once this call has finished". Measured: five
old-password logins fired alongside a reset left **one live session**. A login that had already read
the old credential inserts its `Session` row *after* `revokeLiveForUser` ran, and an `updateMany`
cannot revoke a row that does not exist yet — ruling 51's boundary approached from the other side.

What does hold: the credential really changes, and every session existing at commit time is revoked.
The ordering is still correct — revoke-then-write would expose *every* in-flight login rather than
only those straddling commit→revoke. The fix belongs on the login path and is **owed and not
built**; named in `security/authentication.md` §6.

## Things in the brief I found false or incomplete

1. **D2's racing-login claim** — above. Measured false as written.
2. **D9's "record the number of sessions revoked" is not implementable atomically.** The revocation
   runs after the transaction the audit row must live in, by D2's own ordering. The field is
   `liveSessionsAtWrite`, counted inside that transaction and named for what it measures — a tidier
   name would be a false statement in an append-only table.
3. **D5's ruling-77 note is right about `forgot-password` and incomplete about the task.** Those are
   200s with a constant body and need no `requestId` substitution — but `reset-password`'s refusals
   *are* error envelopes and do. Both kinds are in the file.
4. **"The prescribed test across the whole registry with no exempt list" is not literally
   satisfiable in one shape.** Notices must carry no link; token-link templates exist to carry one.
   Implemented as two blocks over the two exported lists, plus a whole-registry block on the display
   name. That third block is **structural** — the typecheck is the real control — and its docblock
   says so rather than implying it bites.
5. **`login.service.ts:138`** no longer names the rehash gap: it was replaced by the implementation.

## Mutations applied, run, and reverted

| | Mutation | Result |
|---|---|---|
| A | render `ipAddress` raw | RED on 12 registry tests, including the three the old carve-out exempted |
| B | remove the reset's revocation | RED ×4 |
| C | defeat the reset compare-and-swap | RED |
| D | drop `exceptSessionId` on change | RED |
| E | remove the denial audit row | RED |
| F | defeat the rehash compare-and-swap | RED — that test was vacuous before D8 |
| G | make the rehash rethrow | RED ×2 |
| **H** | **defeat the change compare-and-swap** | **GREEN — SURVIVED.** Finding 1; fixed, then RED |

## Decisions the brief left to me, with the cost if wrong

- **Unverified accounts still receive a reset link.** An attacker only resets the account they
  created; the victim's real account still requires their mailbox.
- **`LOCKED`/`DISABLED` accounts get no link but do get an audit row.** D4 would refuse the
  redemption anyway.
- **A reset for a user with no `Credential` row SETS a password** rather than refusing — otherwise
  SSO-only accounts (Phase 11) are stranded permanently. One branch to reverse.
- **`change-password` is not wired into the lockout ladder**, because `ACCOUNT_LOCKED` would then be
  a distinguishable outcome on an authenticated route. The bound is the rate limit; the signal is
  `PASSWORD_CHANGE_FAILED`.
- **Breach check after verification on change, before the token on reset.** Opposite orderings for
  different reasons: do not hand an oracle to a session thief; do not cost a user their link.
- **`reset-password` sets no cookie.** Issuing one would sign in whoever redeemed the link.
- **20/hour and 10/hour per IP** for the two new classes. 20 is below verify-email's 30 because the
  unit of work includes a full Argon2id hash; 10 because a password change has no legitimate
  high-volume case.
- **The rehash is a compare-and-swap and runs on the MFA arm too.** Without the predicate it
  silently undoes a concurrent password change — mutation F.

## Open, and not done

- **No ADR.** 0018 is Task 11's, and nothing here was expensive to reverse.
- **The racing-login residual is open** (finding 2).
- **`forgot-password`'s timing residual is accepted and measured**: 25 samples per case — no account
  11.4 ms p50 (9.4–16.4), non-`ACTIVE` 11.7 (8.3–20.0), active 14.1 (10.9–20.9). **The ranges
  overlap, unlike the resend's** — and these figures understate production, because the harness
  mailer is in-memory and pays no SMTP round trip. A lower bound, not the residual.
- **Ruling 24 is now partially closed**: the rehash drains weak hashes on login, and dormant
  accounts keep theirs indefinitely (ADR-0014 §116).
- **Ruling 55's per-principal limiter stage is still owed**, and `passwordChange` is a new reason to
  want it.
- **Ruling 70 is closed** — no template renders the recipient's stored display name, and the
  residual test was deleted rather than adjusted. The register should say so; I have not written it.
