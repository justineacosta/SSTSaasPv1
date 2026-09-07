# Task 17 — dispositions, and the fix round's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-07 after reading `review.md` in full and re-verifying its
High independently rather than accepting it.

## Dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C-4 | **High** | `queryClient.clear()` empties the store but never notifies mounted observers, so the shell renders the previous organisation indefinitely | **Fix.** Reproduced by the orchestrator at the library level. |
| C-1 | Citation + Medium | `sessionSummarySchema` is not an enforcer; two strippings, not three; the docblock claims the hash is "unrepresentable on the wire" | **Fix both halves** — correct the prose *and* make the schema a real enforcer. |
| C-2 | Medium | Revoking the current session clears the cookies but leaves the browser signed-in-looking | **Fix.** |
| C-5 | Low | `/settings/members` renders a 403 as an error with false advice | **Fix.** It is also a `frontend.md` §6 gap: the Permission state is missing. |
| Rule 10 | — | Audit deviation | **ACCEPTED** — see below. One overstated sentence to correct. |
| C-3 | Low | Timing oracle on session-id probing | **No behaviour change.** Correct the overstated sentence; record the residual. |
| C-7 | Medium | The documentation list is wrong and incomplete | **Orchestrator's**, not yours. Do not touch `.claude/`. |

## C-4 is real. The measurement, not the argument.

Reproduced against `@tanstack/query-core@5.101.4` directly, with no Sentinel code in the frame —
a `QueryObserver` is what `useQuery` builds and subscribes to:

```
--- steady state ---            observer data     : ACME
--- after queryClient.clear() ---
cache getQueryData : undefined
observer notified  : 0 times
observer still shows: ACME
```

**The store is emptied and the mounted component is never told.** `getQueryData` returns
`undefined` while the screen keeps rendering the old organisation's name, its permission set, and
any page data keyed without an organisation id — until a route change or a reload.

This is exactly the property `architecture/frontend.md` §3 states ("switching organisations clears
the cache entirely"), and the switcher's own docblock quotes that rule while not delivering it.
**Stale tenant data rendered under a new organisation is a tenant-isolation failure the user can
see** — the brief said so and it is why this is High rather than a cosmetic bug.

**Why the shipped test cannot see it:** `OrganizationSwitcher.spec.tsx` renders under a *static*
`SessionContextProvider` and asserts `getQueryData` — the half that works. No test in the
repository mounts the shell and switches organisations.

### What to do

Make the switch actually repaint. `clear()` is the wrong primitive on its own; whatever you choose
must **notify mounted observers** and leave the shell showing the new organisation. `resetQueries`
notifies where `clear` does not — verify that rather than trusting this sentence, and if you use
something else, say why.

**The test is the deliverable as much as the fix.** Mount the real `AppShell` with the real
`OrganizationSwitcher`, switch organisation, and assert the rendered output shows the new
organisation and the new permission set. Then **prove it bites**: restore the bare `clear()` and
watch it go red. A test that renders under a static provider cannot catch this class and must not
be what you ship.

## C-1 — make the claim true, do not just soften it

`packages/contracts/src/auth.ts:271-294` says the hash is "unrepresentable on the wire, and
`check:openapi` pins that". Both halves are false: **no response in `apps/api` is ever parsed
against a contract schema** (`app-setup.ts:127` installs one interceptor, the logger), and
`check:openapi` compares a committed document, not a response body.

The reviewer's mutation is why this matters: replacing both hand-written projections with a spread
**typechecks cleanly** — TypeScript does not excess-property-check a spread — and ships the hashed
credential, with exactly one integration assertion standing in the way.

Do both:

1. **Correct the docblock** to say what is actually true.
2. **Make the schema an enforcer on the API side**: parse the response through
   `sessionSummarySchema` (or the collection schema) in `AuthController.listSessions` before
   returning it, so the shape is closed at runtime rather than in prose. Consider `.strict()` and
   say what you chose. Then re-run the reviewer's spread mutation and show it now fails at the
   schema, not only at one integration assertion.

Keep it to the session routes. Do not add a global response interceptor — that is an
architecture change and it is not this fix round's call.

## C-2 — the current-session revocation must sign the user out

`SessionsPanel`'s per-row revoke calls `invalidateQueries` and nothing else. For the current
session the API clears both cookies, so the refetch 401s and the panel shows "Your sessions could
not be loaded" while the shell keeps rendering signed-in chrome.

`AppShell.tsx:151-166` already does the right thing for logout: `queryClient.clear()` then
`router.replace('/login')`. **Take the same path when the revoked row is the current session.**
Add the test that asserts it — the existing `:123` test asserts the *label*, not the outcome.

## C-5 — a 403 is a permission state, not an error state

A member without `organization.manage_members` currently sees "The member list could not be
loaded. Try reloading the page." followed by "You can see who belongs to this organisation." The
first is wrong advice and the second is false.

`architecture/frontend.md` §6 requires a **Permission** state that "explains the missing permission
rather than showing a blank page", and §5 requires the UI to say *why* an action is unavailable and
who can grant it. Render that on 403, distinct from the error state. Do not silently hide the page.

## The rule-10 verdict: ACCEPTED, with one sentence to correct

Revoke-then-audit stands. The `logout.service.ts` precedent is real and transfers, and on process
death between the two the session is dead in both stores and `Session.revokedAt` survives — so the
*fact* and the *when* survive, and what is lost is actor context. A gap in an append-only log is
better than a false row: a missing row makes the log a floor, a false row makes an investigator
stop looking.

**But the justification overstates its own necessity.** The docblock says one transaction over both
"is not expressible without reopening Task 6". That is true of Redis and **false of Postgres**:
`SessionRepository` and `SessionManagementService` inject the same `PRISMA` token, `SessionStore`
declares `$transaction`, and `rotate` already uses it — it is one `tx` parameter on `revokeById`.

**Correct the sentence. Do not change the behaviour in this fix round.** Moving the audit write
inside a Postgres transaction is a real improvement with its own blast radius across a module two
tasks old, and it deserves its own change rather than being smuggled into a fix round. Record it as
owed.

## C-3 — correct the sentence, keep the behaviour

The "no oracle" claim is true of the body and approximately true of the clock: an id naming no row
skips a row fetch that a foreign id performs. It is narrow — `ses_` ids are ULIDs, so it only
*confirms* an id obtained elsewhere — but the report states it more strongly than it holds. Correct
the wording and record the residual. No behaviour change.

## What you must not do

- **Do not edit anything under `.claude/`**, `roadmap.md`, `report.md` or `review.md`. The
  orchestrator owns all of it, including C-7's documentation corrections.
- Do not touch `apps/web/src/api/redirect.ts` or `security-headers.ts`.
- Do not write a migration.
- Do not add a global response interceptor.
- Do not change the audit transactionality.

## Verify

Test-first. Then, exit codes captured outside a pipe (`out=$(pnpm <cmd> 2>&1); code=$?`):

```
pnpm format:check   pnpm lint         pnpm typecheck
pnpm test           pnpm check:specs  pnpm test:integration
pnpm build          pnpm test:e2e     pnpm check:openapi
```

Baselines to compare against, measured — do not derive them: `pnpm test` **115 files / 1970**,
`check:specs` **144**, `test:integration` **29 files / 544**, `check:openapi` **29 paths**,
`test:e2e` **34**.

Write `docs/superpowers/ledger/phase-2/task-17/fixes.md` from your first minutes and commit
incrementally — ruling 131, which is why the reviewer that died on this very task lost nothing.
Report commands, exit codes and numbers. No status prose.

Commit small, on `feat/phase-2-task-17-app-shell`, never `main`, each message ending:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
