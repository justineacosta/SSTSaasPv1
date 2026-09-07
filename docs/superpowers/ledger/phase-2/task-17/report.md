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

## Step 5 — the frontend

Files added under `apps/web`:

| File | What |
|---|---|
| `src/api/auth-endpoints.ts` | extended: `logout`, `switchOrganization`, `listSessions`, `revokeSession`, `revokeOtherSessions`, `changePassword`, `enrollMfa`, `confirmMfa`, `disableMfa`, `regenerateRecoveryCodes` |
| `src/api/organization-endpoints.ts` | new: organisations, roles, members, invitations |
| `src/app/session-context.tsx` | `SESSION_QUERY_KEY`, `useSessionQuery`, `SessionContextProvider`, `useSession`, `usePermission`, `Can` |
| `src/app/AppShell.tsx` | the shell, the skeleton, the 401 redirect, the sign-out |
| `src/app/OrganizationSwitcher.tsx` | `POST /auth/switch-org` then `queryClient.clear()` |
| `src/app/render-helpers.tsx` | test-only: `stubClient`, `pendingClient`, `testQueryClient`, `renderApp` |
| `src/settings/SecurityScreen.tsx` | the three panels |
| `src/settings/SessionsPanel.tsx` | the session list and both revocations |
| `src/settings/MfaPanel.tsx` | enrol, confirm, reissue, disable |
| `src/settings/QrCode.tsx` | the enrolment QR code |
| `src/settings/RecoveryCodes.tsx` | the once-only display, `RECOVERY_CODES_WARNING` |
| `src/settings/PasswordPanel.tsx` | `POST /auth/change-password` |
| `src/settings/MembersScreen.tsx` | members, roles, removal, invitations, invite form |
| `app/(app)/settings/security/page.tsx`, `app/(app)/settings/members/page.tsx` | thin route files |
| `app/(app)/layout.tsx` | rewritten docblock, renders `<AppShell>` |
| `app/(app)/dashboard/page.tsx` | copy changed only as far as became true |
| six `*.spec.tsx` and `e2e/app-shell.spec.ts` | tests |

### The `(app)` layout docblock the brief named

The old text read: "The real shell resolves the active organisation, **fetches the effective
permission set server-side** and provides it through context (architecture/frontend.md §5) —
none of which exists, because there is no authentication and no organisation."

Both halves were false after this task and both are replaced. The new docblock states that this
layout does not fetch the session, names ADR-0025 and quotes the measurement
(`rate-limit.config.ts:208` and `:303`).

### Documentation this change makes false — reported, NOT edited

Per the brief, nothing under `.claude/` was touched. What the orchestrator now owns:

1. **`.claude/architecture/frontend.md` §2's rendering table**, row "App shell, navigation |
   Server component | Permissions resolved server-side; no flash of forbidden UI". ADR-0025
   makes it false and the ADR's own Consequences section says it "is corrected in the same
   change".
2. **`.claude/architecture/frontend.md`'s status banner**, which says "**§5 (permissions) and §7
   (performance budgets) remain Not Implemented**" and "**§3 is still unexercised** — TanStack
   Query is wired and these screens issue no query". §5 and §3 are both exercised now. §7 is
   still not implemented and that sentence remains true.
3. **`.claude/api/authentication.md` §2** says `GET /auth/session` and the session flow are the
   session routes; three more now exist. Its §7 rate-limit table lists fourteen routes and is
   now seventeen. Its §2 note that `permissions` "is always `[]`" is unchanged by this task.
4. **`.claude/api/authorization.md`'s status banner** counts "Ten shipped endpoints declare a
   permission" and names the eleventh that declares `@AuthenticatedOnly()` on purpose. This task
   adds **three more `@AuthenticatedOnly()` routes**, so that banner's count of deliberate
   non-permission routes is now four rather than one.
5. **`.claude/security/audit.md` §4** already lists `SESSION_REVOKED`, so nothing is owed there —
   but the note in the surrounding prose that some names are written by no code is now one name
   shorter.
6. **`.claude/ui-ux/page-map.md`** — `/settings/security` and `/settings/members` now exist. Not
   read in detail by this implementer beyond what Task 16's report records about it.

## Step 6 — proving the tests bite

Every mutation below was applied to the working tree, the named suite was run, and the file was
reverted with `git checkout --`. `git diff --stat` was printed before each run where the patch
could plausibly have failed to apply.

| # | Mutation | Suite | Exit | Failures |
|---|---|---|---|---|
| 1 | `revokeOwned`: `if (row.userId !== …)` → `if (false)` — the ownership check gone | `session.service.spec.ts` | 1 | 1: "answers NOT_FOUND for another user's session, having written nothing" (`expected 'REVOKED' to be 'NOT_FOUND'`) |
| 1 | same mutation | `auth.sessions.integration.spec.ts` | 1 | 2: the cross-user 404 (`expected 200 to be 404`) and "leaves the other user's session working" |
| 2 | the 404 becomes `403 PERMISSION_DENIED` | `auth.sessions.integration.spec.ts` | 1 | 2: `expected 403 to be 404`, and `expected 404 "Not Found", got 403 "Forbidden"` |
| 3 | `listOwnedPage` drops the `userId` scope | `session.service.spec.ts` | 1 | 2 |
| 3 | same mutation | `auth.sessions.integration.spec.ts` | 1 | 3: including "never lists another user's sessions" — `expected [ …(6) ] to not include 'ses_01M1XEFG…'` |
| 4a | `OrganizationSwitcher`: `queryClient.clear()` removed | `OrganizationSwitcher.spec.tsx` | 1 | 2: `expected [ { id: 'fnd_a', … } ] to be undefined` |
| 4b | replaced with `invalidateQueries({ queryKey: ['org'] })` — a selective invalidation | `OrganizationSwitcher.spec.tsx` | 1 | 2: the same two. A prefix invalidation does not clear the cache |
| 5a | `MembersScreen`: both permission booleans forced to `true` | `MembersScreen.spec.tsx` | 1 | 3 |
| 5b | `<Can>` renders its children unconditionally | `MembersScreen.spec.tsx` | 1 | 2 |
| 6a | `AppShell`: the skeleton branch removed, the shell rendered with an empty permission set | `AppShell.spec.tsx` | 1 | 3 |
| 6b | the 401 redirect drops the destination (`router.replace('/login')`) | `AppShell.spec.tsx` | 1 | 2 |
| 7 | `listOwnedPage` spreads the whole `SessionRow`, so `tokenHash` is on the object | `session.service.spec.ts` | 1 | 1: `expected [ 'absoluteExpiresAt', …(14) ] to deeply equal [ 'createdAt', 'id', 'ip', …(2) ]` |
| 7 | **same mutation** | `auth.sessions.integration.spec.ts` | **0** | **none — see below** |
| 7b | the service **and** the controller both widened | `auth.sessions.integration.spec.ts` | 1 | 1: `expected '{"data":[{"id":"ses_…' not to contain 'tokenHash'` |
| 8 | `revokeOthers` drops `exceptSessionId` | `auth.sessions.integration.spec.ts` | 1 | 3: including `expected { scope: 'others', revoked: 3 } to match object { revoked: 2, scope: 'others' }` |
| 9 | an audit row is written for `NOTHING_TO_REVOKE` as well | `auth.sessions.integration.spec.ts` | 1 | 1: `expected [ …(3) ] to have a length of 1 but got 3` |
| 10 | `RecoveryCodes` loses the once-only warning | `apps/web/src/settings` | 1 | **3** — the component spec and both `MfaPanel` paths that produce codes |
| 11 | the per-row revoke calls the bulk endpoint instead | `SessionsPanel.spec.tsx` | 1 | 1 |

After every revert `git status --short` was empty and the suites returned to green.

### The one survivor, explained rather than explained away

**Mutation 7 survived the integration lane and was killed by the unit lane.** The cause is
defence in depth working, not a gap: `tokenHash` is stripped **three** times on the way out —
`SessionService.listOwnedPage` projects to `OwnedSession`, `AuthController.listSessions` builds
each row field by field, and `sessionSummarySchema` closes the shape. Widening any one of them
leaves the other two intact, so a black-box test through HTTP cannot see it. Mutation 7b widened
two of the three and the integration test failed immediately.

The lesson is the one Task 16's review drew about its own two survivors, applied correctly this
time: a surviving mutant means the property is asserted at a different layer, and the honest move
is to say which layer rather than to call the layers redundant.

## Step 7 — the brief's verification list, run in full

Every command run at the repository root on 2026-09-07 with the compose stack up
(`sentinel-postgres-1`, `sentinel-redis-1`, `sentinel-minio-1`, `sentinel-mailpit-1`, all
`Up (healthy)`). Exit codes captured outside a pipe.

| Command | Exit | Numbers | Baseline (brief, on `5dbab4e`) |
|---|---|---|---|
| `pnpm format:check` | **0** | "All matched files use Prettier code style!" | — |
| `pnpm lint` | **0** | 14 of 14 turbo tasks | — |
| `pnpm typecheck` | **0** | 14 of 14 turbo tasks | — |
| `pnpm test` | **0** | **115 files, 1970 tests passed** | 109 files / 1882 tests |
| `pnpm check:specs` | **0** | **144 spec files**, each claimed by exactly one of unit / integration / ui | 137 |
| `pnpm test:integration` | **0** | **29 files, 544 tests passed** | 28 files / 521 tests |
| `pnpm build` | **0** | 8 of 8 turbo tasks; `apps/web` emits **13 routes, all `ƒ (Dynamic)`** | 11 routes |
| `pnpm test:e2e` | **0** | **34 passed** | 22 |
| `pnpm check:openapi` | **0** | **29 routes**, byte-identical to what the contracts generate | 27 |
| `pnpm check:registry` | **0** | **15 models**, 3 tenant-owned, 1 tenant root, 11 global — unchanged | 15 |
| `pnpm check:secrets` | **0** | 520 tracked files, no credential-shaped literals | — |

`check:openapi` reads 29 and `check:registry` still reads 15, which is what the brief predicted.

### Two failures found by the full run and fixed

Both were in code this task added and neither reached a commit that claimed to be green:

1. `pnpm typecheck` **exit 2** — `auth.controller.spec.ts`'s `HandlerName` union did not include
   the three new handlers, so `TS2322` × 3. The union is a hand-maintained list; the three names
   were added. Vitest does not typecheck, which is why the earlier per-suite runs were green.
2. `pnpm lint` **exit 1** — `@typescript-eslint/require-await` on one `MfaPanel.spec.tsx` test
   that was `async` with no `await`. Made synchronous.

## What is NOT done, and is not claimed

1. **The human-in-a-browser pass is outstanding and cannot be performed here.** Playwright
   renders these routes in a real Chromium and asserts structure, headers, console errors and the
   absence of horizontal scroll at 375px — it does not look at them. **Nothing in this task has
   been seen by a person.** Contrast, spacing, focus-ring visibility, dark mode, and whether the
   QR code actually scans with a real authenticator app are all in the class no test here covers.
   The QR code in particular has never been photographed by a phone.

2. **No screen in this task has talked to a running API.** There is no API server behind the
   component specs or the E2E suite; the request paths, methods and bodies are asserted against
   `apps/api/openapi.json`'s published surface and against the contract schemas. **The three
   session routes themselves are exercised end to end** by `auth.sessions.integration.spec.ts`
   against real Postgres and real Redis, but the browser half of every call is stubbed. The live
   authenticated journey is Task 18's.

3. **`/settings/security` cannot say whether MFA is currently on.** No published endpoint reports
   it — `sessionResponseSchema` carries `userId`, `activeOrganization`, `permissions` and
   `entitlements` and nothing else. The panel therefore offers all three MFA operations and
   surfaces the API's 409 / 422 refusals. Reasoning in `MfaPanel.tsx`'s docblock. A future task
   that adds `mfaEnabled` to the session document would remove this.

4. **The audit row for a revocation is not in the same transaction as the revocation.** Deviation
   from the brief, argued in Step 3 and in `session-management.service.ts`'s docblock, following
   `logout.service.ts`'s shipped compromise.

5. **`qrcode@1.5.4` and `@types/qrcode@1.5.6` were added to `apps/web`.** Justification in
   `QrCode.tsx`'s docblock: the library is used for **encoding only**, and the SVG is rendered as
   React `<rect>` elements so no library output reaches an HTML parser (the input contains the
   user's own email address). `pnpm-workspace.yaml` is **unchanged** — no `minimumReleaseAgeExclude`
   entry appeared — so ADR-0013's 1440-minute floor applied and passed.
   **One install detail worth recording:** `pnpm --filter @sentinel/web add qrcode` failed at
   `postinstall` with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node`
   — a Windows file lock on the Prisma engine, unrelated to the package. `--ignore-scripts`
   completed it; the generated Prisma client already existed and was not regenerated.

6. **`axe-core` is still not run**, as in Task 16. Accessibility here is asserted by hand:
   labelled controls, `aria-describedby` on errors, `aria-busy` and an `sr-only` message on each
   loading state, `aria-current` on the active navigation item, `role="alert"` on refusals, an
   accessible name on the QR image, and no horizontal scroll at 375px.

7. **The `apps/web` bundle-size budget** (`frontend.md` §7) still does not exist and this task did
   not add one. `qrcode` is a new runtime dependency and nothing measured its cost.

8. **The session list's cursor field is named `createdAt` while the sort key is `lastSeenAt`.**
   The encoding is opaque to clients by contract, and one shared reviewed encoder was preferred
   to a second copy of `list-cursor.ts`'s validation. Recorded as a wart.

9. **Not built:** `/invitations/[token]` (the accept screen), `/onboarding`, and the separate
   `/recovery` page `page-map.md` lists. None is in this brief.

10. **`safeRedirectPath` and `buildSecurityHeaders` were not modified.** The shell consumes
    `loginHrefForDestination`, which calls `safeRedirectPath` internally; nothing in this task
    changed either function or the CSP.
