# Task 17 — implementer's report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Branch: `feat/phase-2-task-17-app-shell`. This file is a record of commands run, exit codes, file
paths and measurements. It contains no status prose and asserts nothing the orchestrator has not
been handed the evidence for.

Started 2026-09-07.

```
$ git branch --show-current
feat/phase-2-task-17-app-shell
```

## Step 0 — reading, in the order the brief names

1. `docs/superpowers/ledger/phase-2/task-17/brief.md`
2. `.claude/decisions/ADR-0025-authenticated-calls-are-made-from-the-browser.md`
3. `CLAUDE.md`
4. `.claude/architecture/frontend.md` §§3, 4, 5, 6
5. `.claude/api/authentication.md`, `.claude/api/authorization.md`
6. `docs/superpowers/ledger/phase-2/task-16/report.md`, `.../review.md`

## Step 1 — baselines

Baselines are the brief's measured figures on `5dbab4e` and are **not** recomputed here
(ruling 135): `pnpm test` 109 files / 1882 tests; `check:specs` 137 spec files;
`test:integration` 28 files / 521 tests; `check:openapi` 27 paths; `check:registry` 15 models;
`test:e2e` 22 passed.

(Findings appended below as each step completes.)

## Step 2 — facts the brief asserts, re-verified rather than trusted

| Claim | Command / location | Result |
|---|---|---|
| 27 OpenAPI paths before this task | `node -e "...Object.keys(o.paths).length"` | 27 |
| only one session route existed | same, filtered `/session/i` | `/api/v1/auth/session` and nothing else |
| `Session` carries ip/userAgent/lastSeenAt/createdAt/revokedAt | `schema.prisma:183,184,203,213,214` | all five present |
| the index already exists | `schema.prisma:225` | `@@index([userId, lastSeenAt(sort: Desc)])`, and its comment at `:221` reads "list / revoke a user's sessions for /settings/security" |
| `SessionService` has revoke / revokeAllForUser / revokeAllForUserInOrganization and no list | `session.service.ts:665,725,748` | confirmed |
| `Session` is user-owned, absent from the tenant registry | `session.repository.ts` class docblock | confirmed; `check:registry` still reports 15 models after this task |
| `passwordChange` and `mfaManagement` are perIp-only, fail-closed | `rate-limit.config.ts:208`, `:303` | confirmed |
| `apps/web/app/(app)/layout.tsx` claims a server-side permission fetch | that file, lines 6-7 | confirmed — ADR-0025 makes it false |

**No migration was written.** The model already carried every column the list and the
revocations need.

### A correction to the brief, section 2, on the rate-limit class

The brief says: "These routes are authenticated, so `perPrincipal` does resolve; that is an
argument you must make explicitly rather than inherit."

`perPrincipal` does **not** resolve on these routes. `RATE_LIMIT_SCOPE_PHASES` in
`apps/api/src/common/guards/rate-limit.config.ts` places `perPrincipal` in the edge phase,
which runs before `AuthenticationGuard`, and the docblock above that table says so in terms:
"perPrincipal with principalSource: authenticated stays in edge, where it still resolves
nothing. That is carry-forward rulings 55 and 90 and it remains open."

**Class declared: `generalSession` on all three.** The argument is written on the handlers in
`auth.controller.ts` and in `auth.controller.spec.ts`'s route table, and in summary: the only
scope that would resolve here is perIp; every perIp class in that file is fail-closed; that
would put one corporate egress address on a shared budget for a **defensive** action —
signing a stolen device out — and would fail closed during exactly the incident in which a
user needs it. There is no oracle to protect either: nothing on these routes verifies a
secret, a session id is 26 characters of unguessable base32, and every refusal for an id that
is not the caller's is the same 404.

## Step 3 — files added and changed for the API

| File | What |
|---|---|
| `packages/contracts/src/auth.ts` | `sessionSummarySchema`, `listSessionsQuerySchema`, `sessionCollectionSchema`, `revokeSessionResponseSchema`, `revokeOtherSessionsResponseSchema` and their types |
| `packages/contracts/src/index.ts` | exports for the above |
| `packages/contracts/src/auth.spec.ts` | 15 new tests (46 in the file) |
| `apps/api/src/modules/auth/session.repository.ts` | `listPageForUser`, and a **separate** `SessionPageWhere` type so `OR` never reaches `updateMany`'s predicate |
| `apps/api/src/modules/auth/session.service.ts` | `OwnedSession`, `OwnedSessionPage`, `OwnedRevocation`, `listOwnedPage`, `revokeOwned` |
| `apps/api/src/modules/auth/session.service.spec.ts` | 10 new tests (49 in the file) |
| `apps/api/src/modules/auth/session-management.service.ts` | new — list / revokeOne / revokeOthers, and the audit rows |
| `apps/api/src/modules/audit/platform-audit.actions.ts` | `SESSION_REVOKED` |
| `apps/api/src/modules/auth/auth.controller.ts` | the three routes |
| `apps/api/src/modules/auth/auth.controller.spec.ts` | three rows added to the `ROUTES` table |
| `apps/api/src/modules/auth/auth.module.ts` | registers `SessionManagementService` |
| `apps/api/src/modules/auth/auth.sessions.integration.spec.ts` | new — 23 tests |
| `apps/api/openapi.json` | regenerated |

### `SESSION_REVOKED` required no `.claude/` edit

`platform-audit.service.spec.ts:108` asserts every entry in `PLATFORM_AUDIT_ACTIONS` appears
in `.claude/security/audit.md`. `SESSION_REVOKED` was **already** in that document's section 4
Auth list (`audit.md:85`) and no code wrote it. Adding it to the constant therefore needed no
change to a file this task may not touch. The assertion runs in one direction only, so a
document listing a name nothing writes was never a failure.

### Decisions the brief left open

1. **Revoking the current session is allowed**, and it clears both cookies. Reasoning is in
   `auth.controller.ts`'s `revokeSession` docblock: the list marks the current session, so a
   user pressing "sign out" on the row they are sitting in has said exactly what they mean;
   the end state is one `POST /auth/logout` already produces, so a refusal buys no safety and
   only a second story about what a revocation does; and the cookies must be cleared or the
   browser is left holding a pair that cannot authenticate anything. It writes
   `SESSION_REVOKED`, not `LOGOUT`.
2. **The audit row is NOT in the same transaction as the revocation**, which is a deviation
   from the brief's instruction to follow Task 14's membership shape. `SessionService`'s
   revocation owns an ordering spanning Redis and Postgres (tombstone before write) and takes
   no transaction handle, so one transaction over both is not expressible without reopening
   Task 6. The order is **revoke, then audit** — `logout.service.ts`'s documented compromise,
   in the same module, for the same reason, and `api/authentication.md` section 2 records the
   same for `switch-org`. Neither error is swallowed. It is stricter than `logout` in one
   respect: **a row is written only when a row actually moved**, so a replayed revocation
   cannot grow an append-only table.
3. **The list paginates**, using the shared `listQuerySchema` / `collectionEnvelopeSchema` and
   `list-cursor.ts`'s keyset encoder, because "every list endpoint paginates" is a core rule
   and `session.repository.ts`'s own docblock had already noted that its unbounded read is
   "not an endpoint". The cursor's field is named `createdAt` while this endpoint's sort key
   is `lastSeenAt`; the encoding is opaque to clients by contract, and one shared reviewed
   encoder was preferred to a second copy of its validation logic. Recorded here as a naming
   wart rather than hidden.
4. **`PENDING_MFA` and expired sessions are excluded from the list.** Neither can authenticate
   a request, so listing them under "active sessions" would be a false statement a user might
   act on. Bulk revocation still reaches them: it goes through `revokeAllForUser`, unchanged.

## Step 4 — API verification at this point

| Command | Exit | Numbers |
|---|---|---|
| `pnpm vitest run --project unit packages/contracts/src/auth.spec.ts` | 0 | 46 tests |
| `pnpm vitest run --project unit apps/api/src/modules/auth` | 0 | 33 files, 736 tests |
| `pnpm vitest run --project integration .../auth.sessions.integration.spec.ts` | 0 | **23 tests** |
| `pnpm --filter @sentinel/api exec tsc --noEmit` | 0 | — |
| `pnpm lint` | 0 | — |
| `pnpm format:check` | 1, then `pnpm format`, then 0 | 4 files reformatted |
| `pnpm check:openapi` | 0 | **29 routes**, byte-identical to what the contracts generate |
| `pnpm check:registry` | 0 | **15 models**, 3 tenant-owned, 1 tenant root, 11 global |

One integration test failed on its first run and the failure was the test's, not the code's:
it drove the older session through `GET /auth/session` expecting `lastSeenAt` to move, and it
did not — `isRenewalDue` renews only past the halfway mark of the 24-hour idle window
(`session.service.ts`). Measured: `expected 'device-two/1.0' to be 'device-one/1.0'`. The test
now writes the column directly, which is what actually exercises the `ORDER BY`.
