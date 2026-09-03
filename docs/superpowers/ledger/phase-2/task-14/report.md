# Task 14 implementer's report — Memberships, roles, and the last-owner invariant

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-09-03, on branch `feat/phase-2-task-14-memberships`, starting
from `01dfe99`. Commands and exit codes; no status prose. Six code commits, `1f2239e` through
`7ef117b`.

---

## 1. Evidence table

Every command was run from the repository root with `out=$(pnpm <cmd> 2>&1); code=$?`, so the exit
code is the command's own and not a pipe's last stage.

### Baselines, re-measured on this branch before any code was written

| Command | Exit | Measured | Brief said | Agrees? |
|---|---|---|---|---|
| `pnpm test` | 0 | 95 files / 1628 tests | 95 / 1628 | yes |
| `pnpm check:specs` | 0 | 120 spec files | 120 | yes |
| `pnpm test:integration` | 0 | 25 files / 443 tests | 25 / 443 | yes |
| `pnpm check:openapi` | 0 | `"routes":21` | 21 paths | yes (see §5) |
| `pnpm check:registry` | 0 | 15 models | 15 | yes |
| `pnpm check:secrets` | 0 | 434 tracked files | 434 | yes |
| `docker compose ps` | 0 | 4 services, all `healthy` | up and healthy | yes |

### Final verification, at `7ef117b`

| Command | Exit | Output | What it proves |
|---|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | Nothing added is unformatted; CI's format gate would pass. |
| `pnpm lint` | 0 | (silent) | No ESLint error, including the `no-restricted-imports` fence around the unscoped db client and the cross-module import-boundary rule. |
| `pnpm typecheck` | 0 | (silent) | `tsc --noEmit` across the workspace under strict mode. No `any` and no type assertion was added. |
| `pnpm test` | 0 | 98 files / **1668** tests (+3 files, +40) | Unit lane green, including the 49-pair exhaustive D5 spec and the two new controller metadata tables. |
| `pnpm check:specs` | 0 | **125** spec files (+5) | Each of the five new spec files is claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | 27 files / **479** tests (+2 files, +36) | Integration lane green **as a lane**, not per file — ruling 92. The known `auth.mfa` flake did not appear. |
| `pnpm build` | 0 | 8 tasks successful | The API and web builds compile with the new module. |
| `pnpm check:openapi` | 0 | `"routes":24`, byte-identical | The committed `openapi.json` matches what the contracts generate: 21 to **24 paths**, 28 operations. |
| `pnpm check:registry` | 0 | **15 models**, 3 tenant-owned, 1 root, 11 global | Unchanged, as the brief required. This task adds no table and no column. |
| `pnpm check:secrets` | 0 | **445** tracked files | No credential-shaped literal in anything added. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit — all `Up 35 hours (healthy)` | The stack the integration lane needs was live throughout. |

**No migration was written, and none was needed.** Every column this task reads and writes already
exists: `Membership.status`, `Membership.deletedAt`, the partial unique index and the CHECK
constraint all shipped in Task 1. `check:registry` reporting 15 models is the check on that claim.

---

## 2. Files created and modified, with commit SHAs

Branch base `01dfe99`. `git diff --stat 01dfe99..7ef117b`: **26 files, 3966 insertions, 101
deletions.**

| Commit | Subject |
|---|---|
| `1f2239e` | `feat(api): membership list, role change and removal, and GET /roles` |
| `778fe14` | `test(api): unit specs for the new routes, and the contracts docblock the plan falsifies` |
| `cb4b391` | `test(api): an INVITED owner is not an owner, which is what makes the count's status predicate load-bearing` |
| `9032e8a` | `test(api): the lock detector was measuring the foreign key, not the lock` |
| `81d7574` | `test(api): assertPathIsActiveTenant per route, not only through the matrix` |
| `7ef117b` | `docs: the five .claude documents Task 14's behaviour makes false` |

### Created

| Path | Lines |
|---|---|
| `apps/api/src/modules/memberships/membership.service.ts` | 629 |
| `apps/api/src/modules/memberships/memberships.controller.ts` | 260 |
| `apps/api/src/modules/memberships/memberships.module.ts` | 52 |
| `apps/api/src/modules/memberships/memberships.tokens.ts` | 35 |
| `apps/api/src/modules/memberships/membership.service.spec.ts` | 138 |
| `apps/api/src/modules/memberships/memberships.controller.spec.ts` | 204 |
| `apps/api/src/modules/memberships/memberships.integration.spec.ts` | 883 |
| `apps/api/src/modules/memberships/last-owner.integration.spec.ts` | 419 |
| `apps/api/src/modules/roles/role-catalog.store.ts` | 104 |
| `apps/api/src/modules/roles/roles.controller.ts` | 71 |
| `apps/api/src/modules/roles/roles.controller.spec.ts` | 85 |

### Modified

| Path | What changed |
|---|---|
| `apps/api/src/app.module.ts` | Registers `MembershipsModule`. |
| `apps/api/src/modules/roles/roles.module.ts` | Registers `RolesController` and the `ROLE_CATALOG` provider. |
| `apps/api/src/modules/roles/roles.tokens.ts` | Adds `ROLE_CATALOG`. |
| `apps/api/src/modules/audit/audit.actions.ts` | `AUDIT_ACTIONS` gains `ROLE_CHANGED` and `MEMBER_REMOVED`; `AUDIT_RESOURCE_TYPES` gains `Membership`; the miscounted sentence beside them recomputed. |
| `apps/api/src/modules/organizations/organization.service.ts` | `notFound()` exported so the membership 404s are the same object, not a fourth copy. |
| `apps/api/src/common/authorization-matrix.integration.spec.ts` | Four new routes in `EXPECTED_GUARDED_ROUTES`; `:membershipId` substitution; a body for the membership `PATCH`; `crossTenantProbeFor`. |
| `apps/api/src/common/guards/email-verified.guard.spec.ts` | Controller-count sentinel 4 to 6, and a note on why the membership routes are deliberately not gated. |
| `apps/api/src/modules/auth/require-mfa.spec.ts` | Same sentinel 4 to 6, now naming the three files that declare `@RequirePermission()` instead of counting them. |
| `packages/contracts/src/memberships.ts` | The false docblock sentence corrected (§5). |
| `apps/api/openapi.json` | Regenerated. |
| `.claude/api/authorization.md`, `.claude/security/authorization.md`, `.claude/security/audit.md`, `.claude/product/permissions.md`, `.claude/architecture/backend.md` | §6 of the brief. |

---

## 3. Mutation testing — every security claim, and the survivors

Method: apply the mutation to the shipped source, run the target lane, record what went red,
`git checkout --` the file. Fourteen mutations. **One survivor, named in §3.1.**

| # | Mutation | Target | Exit | Went red |
|---|---|---|---|---|
| M1 | Delete `FOR UPDATE` from `lockOrganization` | memberships lane | 1 | **3 tests** (after M1's own finding was fixed — see §3.2) |
| M2 | Delete `deletedAt: null` from `liveMembership` | memberships lane | 1 | 1: *answers 404 for a membership that has already been removed* |
| M3 | Delete `deletedAt: null` from the list query | memberships lane | 1 | 2: *does not list a removed member...*, *completes the add / remove / re-add round trip...* |
| M4 | Remove both `assertOrganizationKeepsAnOwner` calls | memberships lane | 1 | 6, including both concurrency tests and all four last-owner arms |
| M5 | Delete `status: ACTIVE` from the owner count | memberships lane | 1 | 1: *does not count an INVITED owner towards the invariant either* |
| **M6** | Delete `deletedAt: null` from the owner count | memberships lane | **0** | **nothing — SURVIVOR, see §3.1** |
| M7 | Remove the D5 `assertActorMayGrant` call | memberships lane | 1 | 1: *refuses a role the actor does not themselves hold the permissions for* |
| M8 | Remove `assertPathIsActiveTenant` from all three methods | memberships + matrix | 1 | 2, then **4 after §3.3** |
| M9 | Remove the session revocation entirely | memberships lane | 1 | 2: *revokes ... IMMEDIATELY*, *does not brick the removed member* |
| M10 | Widen revocation to `revokeAllForUser` (drop the org filter) | memberships lane | 1 | 1: *does not brick the removed member...* |
| M11 | D3: write `deletedAt` without `status` | memberships lane | 1 | 7 |
| M11b | D3: write `status` without `deletedAt` | memberships lane | 1 | 7 |
| M12 | Downgrade the membership DELETE to `@AuthenticatedOnly()` | unit + matrix | 1 | 3: the controller access table, the matrix's downgrade pin, and the scoped 403 arm |
| M13 | Remove both `audit.record` calls | memberships lane | 1 | 2: the `ROLE_CHANGED` and `MEMBER_REMOVED` assertions |
| M14 | `GET /roles` reports no permissions | memberships lane | 1 | 1: *returns every seeded system role with the permissions the seeded rows grant* |

### 3.1 The survivor: M6

Deleting `deletedAt: null` from `assertOrganizationKeepsAnOwner`'s count turns **nothing** red —
`pnpm vitest run --project integration apps/api/src/modules/memberships` exits **0**, 34/34 passing.

The reason is a database constraint, not a coverage hole.
`Membership_status_deletedAt_agree_check` makes the two columns one fact, so `status: ACTIVE`
already implies `deletedAt IS NULL`; the two predicates select the same rows and no test can
distinguish them while the constraint holds. A test written to try would be a test of the
constraint, which `packages/db/src/membership-soft-delete.integration.spec.ts` already owns.

The predicate stays, and the survival is recorded in the function's own docblock rather than
papered over: every other `Membership` read in the file carries it (ruling 99), a count that did
not would read as an oversight, and the day somebody relaxes the constraint it is the difference
between an owner count and a guess.

### 3.2 M1 found a defect in my own test, and it is the important finding of this section

The first version of *a membership write waits for a lock held on the organisation row*
**passed under M1**, taking 1325ms to do so. Only one test went red. The test was measuring
something real and not the thing it was named after — ruling 109's shape exactly.

What it was measuring is the foreign key. `withScopedData` in `packages/db/src/tenant-scope.ts`
forces the scope column into the payload of every `updateMany`, so the removal's
`UPDATE "Membership"` writes `organizationId` even though the value is unchanged. Postgres
therefore re-checks `Membership_organizationId_fkey` and takes `FOR KEY SHARE` on the parent
`Organization` row. `FOR KEY SHARE` conflicts with `FOR UPDATE`, so a blocker holding `FOR UPDATE`
stalls the handler whether or not the handler asked for a lock of its own.

The fix is the one lock mode that tells them apart. From Postgres's row-lock conflict table,
`FOR NO KEY UPDATE` conflicts with `FOR UPDATE` and **not** with `FOR KEY SHARE`. With the blocker
changed to `FOR NO KEY UPDATE` (commit `9032e8a`):

```
unmutated : EXIT=0, 5 passed
mutated   : EXIT=1, 3 failed | 2 passed
            FAIL a membership write waits for a lock held on the organisation row
            FAIL two concurrent demotions of the two remaining owners leave the organisation with one
            FAIL two concurrent removals of the two remaining owners leave the organisation with one
```

### 3.3 M8 found a second weak claim

Deleting `assertPathIsActiveTenant` from all three membership methods turned only **two** tests
red: the matrix's arm 3 and the list's own 404 arm. The PATCH and DELETE cross-tenant tests kept
passing, because the tenant-scoped membership lookup answers 404 for a foreign membership id
anyway — ruling 97's fail-closed direction, where a removed control leaves the 404 assertions
green.

Two arms were added (`81d7574`) that use a **real, live membership in the caller's own
organisation** reached through a path naming a different organisation, so the only thing that can
refuse them is the path check. Re-run: **4 tests red**, one per route plus the matrix.

### 3.4 The honest pre-implementation baseline

Before any handler existed, the two new spec files reported **25 failed / 8 passed**. The eight
that passed with no code at all were the six 404 assertions (Express answers 404 for an
unregistered route — ruling 97 again) and the two raw-Postgres race tests, which touch no
application code. That is recorded because it is the number a green tick has to be read against.

---

## 4. The D1/D2 concurrency transcript

D2: *"If you cannot make the unlocked version fail, you have not tested the race."* It fails.

### The unlocked version, arranged to lose

`last-owner.integration.spec.ts`, first block. Two `sentinel_app` connections
(`createUnscopedPrismaClient(harness.postgres.appUrl)` twice), two interactive transactions, and a
deferred-promise gate forcing both to count before either writes. The two arms differ in **one
statement** and in nothing else.

```
PASS  WITHOUT the row lock, two concurrent demotions both commit and the organisation is left
      with ZERO owners                                                                     77ms

    seenByAlice = 2      // both counted two owners under their own snapshots
    seenByBob   = 2
    liveOwnerCount(org) = 0
```

Both transactions committed. The organisation has no owner. That is the anomaly a CHECK constraint
cannot express and a trigger cannot close, because the problem is the snapshot rather than where
the check is written.

### The locked version, same interleaving

```
PASS  WITH the row lock, the second transaction waits and then sees ONE owner, so it refuses 48ms

    seenByAlice = 2      // Alice takes FOR UPDATE, counts 2, demotes, commits
    seenByBob   = 1      // Bob's FOR UPDATE blocked on Alice's; his count runs after her commit
    liveOwnerCount(org) = 1
```

Bob's write never happens. One statement — `FOR UPDATE` — is the entire difference.

### Through the shipped endpoints

```
PASS  a membership write waits for a lock held on the organisation row                   1357ms
PASS  two concurrent demotions of the two remaining owners leave the organisation with one 116ms
PASS  two concurrent removals of the two remaining owners leave the organisation with one   94ms
```

**One of these three is deterministic and two are not, and that distinction matters.** The two
`Promise.all` tests assert the status pair and a surviving owner, but nothing forces the two
requests to overlap — measured directly: under M1 the demotion pair passed on one run and failed on
the next. They are end-to-end sanity checks, not the proof.

The proof is the first one. The test holds `SELECT ... FOR NO KEY UPDATE` on the organisation row
on its own connection, waits 250ms, issues the removal, and asserts at 1000ms that the request has
**not answered**; then releases the lock and asserts the request completes 204 with one owner left.
A handler that does not take the lock answers immediately, so the mutation turns it red every time.
See §3.2 for why the lock mode is `FOR NO KEY UPDATE` and not `FOR UPDATE`.

---

## 5. Things in the brief I found to be wrong or incomplete

**Nothing in the brief was wrong in a way that changed what I built.** Four smaller notes, in
descending order of how much they matter:

1. **The brief's own baseline caveat is itself slightly off.** §7 says `check:openapi` "logs
   *paths* — it does not print an operation count". The count is right and the field name is not:
   the command logs `"routes":21`, and 21 is a count of paths. At `7ef117b` it logs `"routes":24`,
   which is 24 paths carrying **28 operations**. A reader diffing the number needs to know it does
   not move by one per endpoint: this task added four routes and three paths.

2. **`packages/db/src/tenant-scope.ts` line 118 assigns work to "Task 14" that is not this Task
   14.** It reads *"Task 14 is carrying a guard against ever constructing a client with a global
   `omit` on a scope column."* `git log -S` dates that line to `d282998`, **2026-08-20** — Phase 1.
   It refers to Phase 1's Task 14, the one that added `check:registry` and `check:specs`, and the
   same is true of `packages/db/src/tenant-resources.ts:28` ("Task 14's DMMF-driven coverage
   check"), which is `check:registry` and already exists. I did not build a global-`omit` guard, and
   I do not believe this task owes one. The genuinely Phase-2-Task-14 references are in
   `session.service.ts` (695, 711, 736), `session.repository.ts:121`, `tenant-resolver.store.ts`
   (30, 86), `authorization.integration.spec.ts` (340, 445), `product/permissions.md:104`,
   `security/authentication.md:537` and `security/authorization.md:262`. **A cross-phase
   task-number collision is a trap for whoever greps next**, and it will recur at Phase 2's Tasks
   15 to 18.

3. **§5's "the answer is 404, not 403, on all three membership routes" needed splitting to be
   testable.** Two different checks produce that 404 and only one of them is what the authorization
   matrix's arm 3 can reach. See §3.3 and §6's note on `crossTenantProbeFor`.

4. **D6's route needed a new kind of matrix arm, which the brief did not anticipate.**
   `GET /roles` is the first guarded route in this API with **no tenant-owned resource in its
   path**, so arm 3's Task 13 probe — point a real member of another organisation at their own
   organisation id — cannot be run against it. Resolved by declaring the probe per route rather
   than deriving it; the alternative, letting it fall through to a session pointed nowhere, is the
   silent pass ruling 109 is about.

5. **The brief's §7 correction about `check:secrets` is itself wrong, and it is wrong in exactly
   the way ruling 108 is about.** §7 says the first draft "said ... 433 tracked files where this
   branch has 434 — 433 was measured on `main`, and the difference is this file". The 434 is right;
   the explanation is not. `scripts/check-secret-shaped-literals.ts` excludes `^docs/superpowers/`
   by path — the comment beside the rule says why, ledgers are dated records that are never
   rewritten — so `task-14/brief.md` cannot move the count at all. Measured, with the script's own
   glob and exclusion list applied to three trees:

   ```
   count () { git ls-tree -r --name-only "$1" | grep -E '\.(ts|tsx|md|json|yaml)$'      | grep -vE '^docs/superpowers/ledger/phase-1/review-diffs/|^pnpm-lock\.yaml$|(^|/)package-lock\.json$|^docs/superpowers/'      | wc -l; }
   origin/main       434
   branch base 01dfe99  434
   HEAD              445
   ```

   `origin/main` reports **434**, not 433, and `git diff --name-only origin/main 01dfe99` returns
   two files, both under `docs/superpowers/` and both excluded. So whatever produced 433 was
   measured against a different tree, and the sentence explaining the discrepancy invented a cause.
   The +11 from 434 to 445 is exactly the eleven new source files this task adds; the report you are
   reading adds none, because it is a ledger file.

### The contracts docblock: the brief was right, and I checked before agreeing

The brief instructed me to implement the plan (`organization.manage_members`) and correct
`membershipUserSchema`'s docblock. I did both. Two things worth recording:

- The docblock's claim was not merely superseded, it was **never true of any shipped route** — no
  endpoint read memberships before this task. The correction says so.
- The docblock's *argument* (a colleague's `lastLoginAt` and `lockedUntil` are not their team's
  business) is untouched and the narrow projection is unchanged, because that argument is stronger
  under the narrower permission, not weaker.

---

## 6. Decisions I took inside the brief's decisions

Recorded because they are places a reviewer could reasonably want a different answer.

- **The owner count excludes the row being written, so one statement gives both the before and the
  after count.** The refusal fires only when the write is what breaks the invariant. An
  organisation that somehow already has no live owner is not made worse by removing a `VIEWER`, and
  refusing that would be a lock-out with no recovery path. An `INVITED` membership holding `OWNER`
  does not count (M5 is what makes that predicate load-bearing).
- **The lock is taken on every role change and every removal, including ones that cannot reduce the
  owner count** (a promotion to `OWNER`, a `VIEWER` to `MEMBER` change). A branch deciding when to
  lock is a branch that can be wrong.
- **A role change to the role the member already holds is applied and audited rather than refused.**
  It is satisfiable, the end state is the one asked for, and the event's before/after show it
  changed nothing. Refusing it would give a client retrying after a dropped response an error for a
  request that succeeded. This is also what lets the matrix's arm 4 reach a real 200.
- **An already-removed membership is 404, not an idempotent 204.** A second removal would write a
  second `MEMBER_REMOVED` event for one departure.
- **The D5 refusal reuses `permissionDenied()` from `authorization.guard.ts`**, so a client sees one
  `PERMISSION_DENIED` shape whether the refusal came from the guard or from the handler. The
  permission named is the first missing one **in `PERMISSIONS` order**, because the seeded rows come
  back in whatever order Postgres returns them and a message that varied run to run is untestable.
- **Session revocation runs after the transaction commits.** Revoking inside it would sign out a
  member whose removal then rolled back — the direction with no compensating layer. The reverse risk
  is covered: with no permission cache, `TenantContextGuard` answers 404 on the next request whether
  or not the revocation ran.
- **`GET /roles` lives in `RolesModule`** rather than a module of its own, because it answers from
  the same seeded reference data `TENANT_RESOLVER` expands a membership through. Its `pagination`
  block reports `limit: LIST_LIMIT_MAX` with `hasMore: false` — the bound that was applied, not the
  seven rows returned, which is what `paginationSchema`'s docblock asks for.
- **`MembershipsModule` imports `AuthModule` for one method**, provided as the one-function port
  `MEMBER_SESSION_REVOKER`. This is the first consumption of `SessionService` from outside
  `AuthModule` since Task 6 exported it. The narrowing is not cosmetic: `revokeAllForUser` and
  `revokeAllForUserInOrganization` differ by one argument and by whether a removal locks somebody
  out of their own account (M10).
- **`notFound()` is now exported from `organization.service.ts`** rather than copied. Three
  membership 404s must be byte-identical to the organisation ones; two constructors with the same
  arguments is how they drift.
- **The matrix's arm-3 probe is a per-route registry with a loud default**, matching `bodyFor` and
  `substitutePathParameters`. A guarded route missing from it throws with a message naming the map.

---

## 7. Residuals — things I did not do, named plainly

1. **`organization.manage_members` lets an `ADMIN` remove an `OWNER`.** D5's no-minting rule is
   written for role *changes* and I did not extend it to removals, because extending it would be
   inventing a rule the brief did not give me. The last-owner invariant bounds the damage — an
   `ADMIN` can remove every owner but the last — but "you may not remove somebody whose authority
   exceeds yours" is a defensible rule that this API does not have. **A decision for the
   orchestrator, not a defect I hid.**
2. **Self-removal is permitted.** A member holding `organization.manage_members` can remove their
   own membership, subject to the last-owner invariant, and their own session for that organisation
   is revoked by the same call. Nothing in the plan or the brief speaks to it; I allowed it because
   it is the natural reading of the endpoint and the invariant protects the organisation.
3. **The two `Promise.all` concurrency tests are not deterministic.** Stated in §4 rather than
   presented as proof. The deterministic detector is the lock-blocking test.
4. **M6 survives and cannot be killed while the CHECK constraint stands** (§3.1).
5. **No trigger was added as D1's optional second layer.** The brief offered it "if it is cheap" and
   required that a trigger catching only the single-transaction case be documented as exactly that.
   It is not cheap in the sense that matters: it would need `SECURITY DEFINER` to read `Role` under
   row-level security, which drags in rulings 106 and 107 (`pg_temp` last in `search_path`, and a
   security sentence is a hypothesis until somebody attacks it) for a layer that does not close the
   race the lock closes. Recorded as a deliberate omission rather than an oversight.
6. **`apps/web` is untouched.** Task 14 is API-only; the members screen is Task 17.
7. **Nothing was merged, pushed, or branched.** Six code commits on
   `feat/phase-2-task-14-memberships`; `git status` was clean before this report was written.
