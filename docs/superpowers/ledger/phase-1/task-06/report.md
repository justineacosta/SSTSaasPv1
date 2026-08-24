# Task 6 report — Tenant-scoped Prisma client, RLS, resource registry, isolation harness

## What was implemented

- `packages/db/src/tenant-resources.ts` — `TENANT_OWNED_MODELS`, `TenantOwnedModel`, `isTenantOwnedModel`. Verbatim from the brief.
- `packages/db/src/testing/postgres-harness.ts` — `startPostgresHarness()`. Same contract as the brief (`PostgresHarness { ownerUrl, appUrl, stop() }`), with two adaptations forced by this Windows host (details below).
- `packages/db/src/errors.ts` — `MissingTenantContextError`. Verbatim.
- `packages/db/src/tenant-context.ts` — `TenantContext`. Verbatim.
- `packages/db/src/tenant-client.ts` — `createTenantClient`, `TenantPrismaClient`. Same behaviour as the brief plus a hardening fix and two added operations (details below); the file-level `eslint-disable` block from the brief was not needed after typing `modelDelegate` properly (see "Deviations").
- `packages/db/src/tenant-transaction.ts` — `withTenantTransaction`. Same behaviour; the `fn` parameter's `Omit<...>` was widened by two keys to match what Prisma 6.19's actual `$transaction` callback type provides (see "Deviations").
- `packages/db/src/index.ts` — extended with the seven new exports, verbatim from the brief.
- `packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql` — verbatim from the brief.
- `packages/db/src/tenant-client.integration.spec.ts` — the brief's 10 tests, one assertion corrected (see "Deviations"), plus one new test I added.
- `packages/db/src/rls.integration.spec.ts` — verbatim from the brief, 6 tests.
- `packages/db/prisma/schema.prisma` — `AuditEvent`'s docstring updated (append-only controls now implemented, not Phase 3).
- `.claude/security/tenant-isolation.md`, `.claude/security/audit.md` — status banners corrected (see "Documentation").
- `eslint.config.js` — one exemption widened by one glob (see "Deviations").

Final test count: **21 integration tests** across three spec files (4 migration + 11 tenant-client + 6 RLS), not the 16 the brief estimated — the brief's own count was off (11 not 10 in tenant-client after my addition, and migration.integration.spec.ts already had 4, not accounted for in "16").

## TDD evidence

### RED — tenant-client (Step 3)

```
pnpm vitest run --project integration packages/db/src/tenant-client
```
```
FAIL packages/db/src/tenant-client.integration.spec.ts
Error: Cannot find module './tenant-client.js' imported from
'.../tenant-client.integration.spec.ts'
```
Expected failure — matches the brief exactly. No implementation existed yet.

### GREEN — tenant-client (Step 5, before hardening)

```
✓ packages/db/src/tenant-client.integration.spec.ts (10 tests) 5779ms
Tests  10 passed (10)
```
(One assertion needed correcting first — see Deviations §1 — after which all 10 passed cleanly.)

### RED — RLS (Step 7)

```
pnpm vitest run --project integration packages/db/src/rls
```
```
FAIL row-level security > is the backstop: ... expected true, got false
FAIL row-level security > returns nothing when no organisation setting ...
     expected [] to have a length of +0 but got 2   (Tenant B's row visible)
FAIL row-level security > refuses an insert claiming another tenant
     promise resolved "1" instead of rejecting
FAIL row-level security > enables and forces RLS ...
     Membership RLS enabled: expected false to be true
FAIL row-level security > revokes UPDATE and DELETE on AuditEvent ...
     promise resolved "3" instead of rejecting
Tests  5 failed | 1 passed (6)
```
Exactly the expected failure mode: before the migration, Tenant B's row is genuinely visible to Tenant A's raw SQL, tampering succeeds, and RLS is off. The one pass (`does not grant BYPASSRLS`) is inherited from Task 4's role setup and correctly unaffected by this migration.

### GREEN — full db suite (Step 9, after migration applied)

```
✓ packages/db/src/migration.integration.spec.ts (4 tests)
✓ packages/db/src/rls.integration.spec.ts (6 tests)
✓ packages/db/src/tenant-client.integration.spec.ts (11 tests)
Tests  21 passed (21)
```

## The four control-removal transcripts

All four were run against the file(s), observed failing for the right reason, then restored and re-verified green. Markers left in place were grepped for (`CONTROL-REMOVAL`) and confirmed absent from the final state.

### 1. Remove the `findUnique` rewrite

Changed the `findUnique`/`findUniqueOrThrow` branch in `tenant-client.ts` to `return query(args)` (pass straight through, simulating a developer who forgot the rewrite).

```
× rewrites findUnique into a tenant-scoped lookup — the single easiest mistake to make
  AssertionError: expected { …(8) } to be null
  Received: { id: "mbr_...", organizationId: "org_...B", ... }   <- Tenant B's real row
Tests  1 failed | 9 passed (10)
```
Tenant A's `findUnique({ where: { id: membershipB } })` returned Tenant B's actual membership row — the exact leak the rewrite exists to prevent. Restored; re-ran green (10/10, later 11/11).

### 2. Remove the throw-when-no-context guard

Commented out the `if (organizationId === '' ...) throw ...` block.

```
× throws when there is no organisation in context
  AssertionError: promise resolved "[]" instead of rejecting
Tests  1 failed | 9 passed (10)
```
With an empty-string organisation, the query silently ran (returning `[]`) instead of throwing. Restored; re-ran green.

### 3. Drop one table's RLS policy (AuditEvent)

Commented out `CREATE POLICY "tenant_isolation" ON "AuditEvent" ...` in the migration, leaving `ENABLE`/`FORCE` in place.

```
× is the backstop: raw SQL that skips the client extension still sees only one tenant
  AssertionError: expected 0 to be greater than 0
Tests  1 failed | 5 passed (6)
```
With RLS enabled+forced but no policy, Postgres denies all rows by default — even Tenant A's own legitimate audit event vanished. The test catches the missing policy, just via a "deny-all" failure mode rather than a "leak-all" one (there is no policy left to leak through). Restored; re-ran green.

### 4. Remove `FORCE` from one table (Membership) — the subtle one

Commented out `ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;`.

```
× enables and forces RLS on every registered tenant-owned table
  AssertionError: Membership RLS forced: expected false to be true
Tests  1 failed | 5 passed (6)
```
Caught directly via the `pg_class.relforcerowsecurity` metadata assertion. Note on why this is genuinely subtle: in this test setup neither connection actually depends on `FORCE` behaviourally — the owner connection (`harness.ownerUrl`, used by `tenant-client.integration.spec.ts`) is a Postgres **superuser** (the Testcontainers bootstrap role), and superusers bypass RLS unconditionally regardless of `FORCE`; `sentinel_app` (used by `rls.integration.spec.ts`) is neither the table owner nor a superuser, so RLS already applies to it with or without `FORCE`. The property `FORCE` actually protects — a non-superuser table *owner* bypassing its own policy — has no role fixture in this test matrix to exercise it against. The test only catches the regression because it asserts the metadata flag directly, not because it demonstrates the owner-bypass exploit. Worth flagging as a residual gap (see Concerns). Restored; re-ran green.

All four restorations confirmed via `grep -rn "CONTROL-REMOVAL"` (no matches) and a full green re-run of `pnpm test:integration` (21/21) before proceeding.

## Five root commands (final state)

```
$ pnpm lint          -> 5 successful, 5 total (0 errors, 0 warnings)
$ pnpm typecheck     -> 5 successful, 5 total
$ pnpm test          -> 6 files, 74 tests passed
$ pnpm test:integration -> 3 files, 21 tests passed
$ pnpm build         -> 4 successful, 4 total (prisma generate + tsc all packages)
```

## Deviations from the brief's literal code, and why

**1. Fixed a false assertion in the brief's own cross-tenant test.** `tenant-client.integration.spec.ts`'s "gives Tenant A nothing for every registered tenant-owned model" test originally asserted `toHaveLength(0)` on all three query results. That's mathematically impossible given the file's own fixtures: `beforeAll` creates exactly one legitimate `Membership` row for Tenant A, and the preceding "injects organizationId on create" test creates one legitimate `AuditEvent` row for Tenant A — both of which the extension correctly returns when asked (the injected predicate overrides the caller's `organizationId: orgB` with the context's `orgA`, and Tenant A does have rows under `orgA`). Running the brief's code verbatim, this failed with "expected 0 to have a length of +0 but got 1" against Membership's own legitimate row, not against a leak. I corrected the assertion to check what the test's own comment says it's testing — "asking for another tenant's rows never returns rows belonging to that tenant" — i.e. `row.organizationId !== orgB` for every returned row, rather than an absolute empty-array assumption that only happens to hold if the fixture had zero pre-existing rows (which it doesn't).

**2. `postgres-harness.ts`: `execSync` instead of `execFileSync`.** The brief's `execFileSync('pnpm', [...])` fails `ENOENT` on this Windows host — verified directly (`spawnSync pnpm ENOENT`), because `pnpm` resolves to a `.cmd`/`.ps1` shim here and `execFileSync` does not go through a shell. `packages/db/src/migration.integration.spec.ts` (Task 4, unmodified by me) already documents and works around this exact issue with `execSync`. I mirrored that precedent, with the same "fixed literal, no interpolated input, no injection risk" justification comment.

**3. `postgres-harness.ts`: `stop()` wraps `container.stop()`.** `container.stop()` resolves `Promise<StoppedTestContainer>`, not `Promise<void>` as the `PostgresHarness` interface promises — a real type error under this Prisma/Testcontainers version pairing, not present in the brief's assumed environment. Wrapped in an `async () => { await container.stop(); }` to discard the value; behaviour is identical.

**4. `tenant-transaction.ts`: widened the `fn` parameter's `Omit`.** Prisma 6.19's actual interactive-transaction client type additionally omits `$on` and `$extends` (on top of `$transaction`/`$connect`/`$disconnect`), so the brief's 3-key `Omit` didn't typecheck against what `base.$transaction` actually hands back. Widened to 5 keys; behaviour identical, only the type annotation changed.

**5. `tenant-client.ts`: no eslint-disable needed.** After typing `modelDelegate`'s return as `Record<string, DelegateMethod>` (`DelegateMethod = (args: unknown) => unknown`) instead of the brief's bare `Function`, ESLint reported the brief's four-rule `eslint-disable` block as entirely unused — every operation in the file is now fully typed, so there's no `any`-driven unsafe surface left to suppress. Removed the disable block and rewrote the top comment to describe what's actually true now. This is a strictly narrower unsafe surface than the brief specified, not a wider one.

**6. `tenant-client.ts`: hardened `update`/`updateMany`/`upsert` against tenant reassignment (not in the brief).** Reviewing the brief's design, I found that scoping only `where` for `update`/`updateMany` (as specified) leaves `data.organizationId` free for a caller to set. Since `where` only restricts *which* row a caller can touch — never *what value* it's allowed to write — a handler calling `db.membership.update({ where: { id }, data: { organizationId: otherOrg } })` on a row it legitimately owns would successfully re-parent that row to a different tenant. I verified this is real by reverting to the brief's original where-only scoping and re-running my new test — it failed with the row's `organizationId` genuinely changed to `orgB` (transcript below). Fix: added `SCOPED_WHERE_AND_DATA_OPERATIONS = {'update', 'updateMany', 'updateManyAndReturn'}`, which forces (not merges) `organizationId` in `data` the same way `create` already forces it in its own payload; and extended `upsert`'s handling to force `organizationId` in its `update` branch too (previously only `create` was forced there — same gap). Added one new test, `'refuses to move a row to another tenant via update — data cannot override the injected predicate'`, to `tenant-client.integration.spec.ts` proving this.

**7. `tenant-client.ts`: added `createManyAndReturn` and `updateManyAndReturn` to the scoped sets.** Not in the brief's operation list. Confirmed by grepping `packages/db/generated/client/index.d.ts`: Prisma 6.19 exposes both on every model delegate. Before this addition they weren't recognized at all, so they fell through to the catch-all `throw` — safe (fail-closed), but silently broken for any future caller who tries to use them on a tenant-owned model. Per the task brief's explicit instruction ("If you find an operation the brief's list misses, add it to the scoped set... do not silently widen the pass-through"), I added `createManyAndReturn` to `SCOPED_DATA_OPERATIONS` and `updateManyAndReturn` to `SCOPED_WHERE_AND_DATA_OPERATIONS`, rather than leaving them to throw indefinitely or, worse, silently passing them through unscoped.

**8. `eslint.config.js`: widened the test-harness exemption by one glob.** `packages/db/src/testing/postgres-harness.ts` reads `process.env` to build the migration subprocess's environment — exactly the pattern the existing comment on the spec-file exemption already describes ("read process.env directly to build child-process environments for Prisma migrations and Testcontainers — a test harness is not application code"), but the harness itself lives outside the `*.spec.ts`/`*.integration.spec.ts` glob since it's shared infrastructure, not a spec. Added `'packages/db/src/testing/**/*.ts'` to that one exemption's `files` array. This is the one change outside the brief's stated file list; without it, `pnpm lint` fails on the harness the brief itself requires me to create.

### Verification transcript for deviation 6 (the update-reassignment fix)

Reverted `SCOPED_WHERE_AND_DATA_OPERATIONS` to empty and moved `update`/`updateMany` back into where-only scoping (reproducing the brief's literal behaviour), then re-ran:
```
× refuses to move a row to another tenant via update — data cannot override the injected predicate
  AssertionError: expected 'org_...B' to be 'org_...A'
Tests  1 failed | 10 passed (11)
```
The row's `organizationId` was genuinely `orgB` after the update — a real cross-tenant reassignment, not a hypothetical. Restored the fix; re-ran green (11/11).

## AuditEvent append-only controls (REVOKE + trigger)

**Implemented**, per the brief's migration, in this change. `sentinel_app` no longer holds `UPDATE`/`DELETE` on `AuditEvent`; a `BEFORE UPDATE OR DELETE` trigger additionally raises. Both are proven by `rls.integration.spec.ts`'s "revokes UPDATE and DELETE on AuditEvent from the application role" test (both paths verified to reject).

Documentation updated in the same change, per the task brief's explicit instruction:
- `packages/db/prisma/schema.prisma`: `AuditEvent`'s docstring rewritten — no longer says "Phase 3, not yet done"; now states the tamper-resistance controls are live and cites the migration and test.
- `.claude/security/audit.md`: status banner changed from "Designed. Not Implemented. Phase 3." to "Partially Implemented" — the §2 tamper-resistance controls are live; §4–§7 (taxonomy, redaction, read API, retention) remain Phase 3, stated explicitly so the banner doesn't overclaim.
- `.claude/security/tenant-isolation.md`: status banner changed from "Layer 1 in Phase 1, layers 2–3 in Phase 3" (which was already wrong — this task explicitly builds layer 2 in Phase 1) to "Layers 1 and 2 implemented in Phase 1 (Task 6)... Layer 3 (response DTOs) is Not Implemented." §3/§4 (non-REST surfaces, generated test matrix) called out as still Designed/Not Implemented pending the resources they cover.

I did not touch `.claude/development/migrations.md`, `.claude/development/testing.md`, or `.claude/product/roadmap.md` — their status banners are phase-wide, not specific to what this task changed, and roadmap.md is explicitly "updated at the end of every phase," not per-task.

## Self-review findings

- Reviewed the full diff twice: once immediately after GREEN, once after the hardening pass. No leftover debug code, no `console.log`, no stray `as any`.
- Confirmed no `CONTROL-REMOVAL` drill markers remain in any file (`grep -rn` across `packages/db/src` and `packages/db/prisma`, both times, before final commit).
- Confirmed `packages/observability/src/logger.ts` and `redaction.ts` (pre-existing uncommitted changes from before this task started, per the initial git status) were not touched and are not part of this commit.
- All new files are well under the ~300-line constraint (largest is `tenant-client.ts` at 140 lines).
- Verified `raw SQL is always parameterised`: the migration uses no dynamic SQL at all (static DDL); `tenant-transaction.ts`'s `set_config` call and the RLS spec's `$executeRaw`/`$queryRaw` calls all use tagged-template parameter substitution, never string concatenation.

## Concerns

1. **The `FORCE` control-removal drill (§4 above) doesn't exercise the actual property `FORCE` protects.** It's caught only via a direct `pg_class` metadata assertion, not by demonstrating the owner-bypass scenario `FORCE` exists to prevent, because no role fixture in this test suite is a non-superuser table owner. This is adequate as a regression guard (a future accidental removal of `FORCE` is still caught) but does not prove the *mechanism* works end-to-end. A test with a role that owns a tenant table but isn't a superuser would close this gap; out of scope for what the brief asked for here, flagging for Task 7/14 or a follow-up.
2. **`no-restricted-imports`'s `**/unscoped` pattern does not match `.js`-suffixed relative imports** (e.g. `./unscoped.js`), which is the only import style this ESM codebase uses. Verified empirically: a probe file importing `createUnscopedPrismaClient` from `../unscoped.js` outside the allowed-files list produced zero lint errors. This means the stated Layer-1 control "an ESLint rule forbids importing [the unscoped client] outside migrations, seeds, and the platform-admin module, and CI fails on violation" (`tenant-isolation.md` §2) is **not currently enforced anywhere in the codebase**, for any file, not just mine. This predates Task 6 (the rule and its exemption list were already in `eslint.config.js` before I started) and is out of this task's file list, so I did not fix it — flagging it here because it directly undermines a documented, load-bearing Layer-1 control and should be corrected soon, ideally before Task 14's DMMF-driven registry check goes in, since that check's whole value proposition depends on the surrounding lint/CI net actually working.
3. The RLS integration test suite (`rls.integration.spec.ts`) only exercises `AuditEvent` behaviourally (backstop, insert-reject, revoke). `Membership` and `Invitation` are checked only for the `pg_class` enabled/forced flags, not for actual row-visibility behaviour under the `sentinel_app` role. Given `tenant-isolation.md`'s "Two independent mechanisms must both be wrong for a leak to occur" claim rests on RLS actually filtering rows for every tenant table, a same-shaped behavioural test for `Membership`/`Invitation` (analogous to the `AuditEvent` backstop test) would strengthen this further. Did not add it myself since the brief's RLS spec file was to be used verbatim and this is additive scope beyond what was asked; flagging for reviewer judgement.

## Files changed

**Created:**
- `packages/db/src/tenant-resources.ts`
- `packages/db/src/tenant-context.ts`
- `packages/db/src/tenant-client.ts`
- `packages/db/src/tenant-transaction.ts`
- `packages/db/src/errors.ts`
- `packages/db/src/testing/postgres-harness.ts`
- `packages/db/src/tenant-client.integration.spec.ts`
- `packages/db/src/rls.integration.spec.ts`
- `packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql`

**Modified:**
- `packages/db/src/index.ts`
- `packages/db/prisma/schema.prisma`
- `.claude/security/tenant-isolation.md`
- `.claude/security/audit.md`
- `eslint.config.js`

**Not touched (pre-existing uncommitted changes from before this task, left as-is):**
- `packages/observability/src/logger.ts`
- `packages/observability/src/redaction.ts`

---

# Addendum — review remediation round

The first round was reviewed and **not approved**: four Criticals (C1-C4), five Majors
(M1-M5), plus N1, N3, N4, and a ruling on M4. This addendum covers what changed to address
every one of them, in the order the coordinator asked for (C4 first, since it was the
keystone), with before/after evidence for each.

## C4 - layers didn't compose (fixed first, as instructed)

**Root cause confirmed independently**, not just taken on faith: I read Prisma 6.19's actual
minified runtime (`packages/db/generated/client/runtime/library.js`) and its type
declarations before touching code. Two findings:

1. `$transaction<R>(fn: (client: Omit<DynamicClientExtensionThis<...>, ITXClientDenyList>) => ...)`
   the type signature already promised an extended `tx`, and `_createItxClient` in the
   runtime derives the interactive-transaction client from `this` (whatever client
   `$transaction` was called on), preserving `_extensions`. This confirmed the coordinator's
   proposed fix (extend first, then transact) is real, not just typed-but-fictional.
2. Prisma's `$allOperations` extension callback is invoked as a plain function call
   (`t[n]({model, operation, args, query})`), not `.call(client, ...)`. There is no
   reference to the invoking client anywhere in the callback. `Prisma.getExtensionContext`
   is a literal identity function in this version - it does not recover a client reference
   either. This matters for M2 below.

**Fix applied** (`packages/db/src/tenant-transaction.ts`): `withTenantTransaction` now calls
`createTenantClient(base, {organizationId})` first, then `.$transaction(...)` on the scoped
client, not on `base`. `fn` receives the already-extended `tx`.

**Before/after, captured live** (not asserted): I temporarily reverted
`tenant-transaction.ts` to the original transact-then-extend ordering and re-ran the full
`tenant-transaction.integration.spec.ts` suite against it.

Before (3 of 14 tests fail, and the failure modes are the real evidence):
```
x C4: findUnique still sees the same transaction - read-your-own-writes works
  PrismaClientValidationError: Argument organization is missing.
  (layer 1 never ran: nothing injected organizationId into data at all)

x refuses to delete another org rather than silently redirecting onto the caller's own
  expected error to be instance of MissingTenantContextError
  Received: PrismaClientUnknownRequestError - Postgres 42501 "permission denied for table Organization"
  (layer 1's own refusal never fired; only RLS's grant-level denial stopped it)

x refuses to create or upsert an Organization through the tenant client
  expected error to be instance of MissingTenantContextError
  Received: PrismaClientUnknownRequestError - Postgres 42501 "new row violates row-level security policy"
  (same: layer 1 never refused; RLS alone caught it)
```
The 11 other tests, including every C1/C2 nested-operation test, still passed under the
broken ordering, because `SET LOCAL app.organization_id` was unaffected by the bug (only the
client-extension wrapping changed) and RLS alone was already sufficient for those. This is
exactly the coordinator's framing verified empirically: layer 2 was never actually off,
only layer 1 was. Restored the fix; re-ran green (14/14).

**New permanent proof**: `packages/db/src/tenant-transaction.integration.spec.ts` (14 tests)
- the production configuration (scoped client + real `sentinel_app` role +
`withTenantTransaction`) is now its own file, separate from the layer-1-only suite
(superuser connection) and the layer-2-only suite (raw SQL). Includes a direct
read-your-own-writes test: create then `findUnique` inside the same transaction, which would
fail if `findUnique`'s result landed on a different connection.

## M2 - findUnique escaping transactions (fixed as a consequence of C4, differently than proposed)

The coordinator's own C4 code sample kept the original findFirst-rewrite for `findUnique`,
which, given finding 2 above, cannot be fixed by reordering alone: there is no way for
`$allOperations` to obtain a reference to "whichever client this operation came from" in
order to call a different operation (`findFirst`) on it. Any such rewrite necessarily issues
a second, independent client-method call, which Prisma has no mechanism to bind back to the
original connection/transaction.

**Redesign** (`packages/db/src/tenant-scope.ts`): `findUnique`/`findUniqueOrThrow` are no
longer rewritten to a different operation at all. They run unmodified through `query()`,
which is guaranteed to stay on the calling connection/transaction since it's the same
operation Prisma already dispatched, and the scope column is checked on the result
afterward: match returns it; mismatch returns null (or throws, for `...OrThrow`). This is a
fetch-then-authorise pattern, not a SQL-level filter, so a non-matching row does transit
through the Node process momentarily (never returned to the caller) - documented as a known,
accepted tradeoff in `tenant-scope.ts`'s comments, not left implicit.

This also fully resolves M3 (below) as a side effect, since `where` is never touched.

I did not silently substitute this for the coordinator's proposed fix - it's called out
explicitly in `tenant-client.ts`'s file comment, `tenant-scope.ts`'s comment, and an added
Implementation-note section in `.claude/decisions/ADR-0006-multi-tenant-isolation.md`.

**Proof, over the real `sentinel_app` role, inside an active transaction**
(`tenant-transaction.integration.spec.ts`):
```
v C4: findUnique still sees the same transaction - read-your-own-writes works
v C4: findUnique inside a transaction still refuses another tenant's row
```

## M3 - findUnique by compound unique key (fixed as a side effect of M2's redesign)

Since `findUnique`'s `where` is never rewritten or merged with anything now, the
`organizationId_userId`-shaped compound-key input was never at risk in the new design. Added
a dedicated test anyway, because "never at risk" is a claim that deserves its own proof, not
just an inference:
```
v rewrites findUnique by a compound unique key, not just by id
```
(`tenant-client.integration.spec.ts`) - looks up `Membership` by
`{ organizationId_userId: { organizationId, userId } }` as the wrong tenant (denied, null)
and the right tenant (granted, row), unmodified `where` shape throughout.

## C3 - Organization (the tenant root) was completely unscoped

**Fix, three parts, exactly as the coordinator specified:**

1. `packages/db/src/tenant-resources.ts`: added `TENANT_ROOT_MODEL = 'Organization'` and
   `isTenantRootModel`, as a distinct concept from `TENANT_OWNED_MODELS` (not folded in,
   per the instruction), so Task 14's registry check can require every model to be
   accounted for by exactly one of "tenant-owned," "tenant root," or "deliberately global."
2. Migration `20260820132520_tenant_root_and_audit_restrict`: `Organization` gets
   `ENABLE`/`FORCE ROW LEVEL SECURITY` and a policy keyed on
   `"id" = current_setting('app.organization_id', true)`.
3. `REVOKE DELETE ON "Organization" FROM sentinel_app` in the same migration.

**Extra finding, not in the coordinator's brief, that I fixed before it shipped**: a naive
port of the existing `where`-override logic to the tenant root would have been actively
dangerous. Since the scope key for the root is `id`, the same field a caller naturally
targets an org by, overriding `where.id` with the context's own org id would have silently
turned `organization.delete({ where: { id: orgB } })` into a delete of the caller's own org,
not a no-op. I caught this by writing the redirect scenario as a test before wiring up the
root, watched it demonstrate the substitution, and split the `where`-scoping logic into two
paths: `withScopedWhere` (AND-combines safely for general `WhereInput` operations -
`findMany`, `deleteMany`, `updateMany`, ...) and `scopeUniqueWhere` (refuses outright, rather
than either substituting or invalidly AND-wrapping, for `delete`/singular `update`/`upsert`,
which require a flat `WhereUniqueInput`). Both are pure, unit-tested
(`tenant-scope.spec.ts`) independent of the database.

**Proof** (`tenant-transaction.integration.spec.ts`, `C3` describe block, 7 tests): scopes
reads to the caller's own org; `findUnique` refuses another org's id; raw SQL backstop sees
only one org; delete of another org refuses via `MissingTenantContextError` and the caller's
own org is verified untouched afterward (not just "an error was thrown" - the
redirect-safety property itself is asserted); delete of any org (including the caller's own)
fails over `sentinel_app` because `DELETE` is revoked outright; create/upsert refuse via the
extension before ever reaching the database.

## C1/C2 - nested reads and nested writes

Did not attempt recursive injection into `include`/`select`/nested `data`, per the explicit
instruction. Documented the limitation in `tenant-client.ts`'s file-level comment (why:
verified against the actual extension callback signature, not asserted) and proved RLS
catches it, over the real `sentinel_app` role, inside `withTenantTransaction`
(`tenant-transaction.integration.spec.ts`, `C1/C2` describe block, 5 tests):

- Nested write, create: `user.update({ data: { memberships: { create: { organizationId: orgB, ... } } } })`
  under orgA context - model is `User`, invisible to the extension entirely - rejected by
  Membership's RLS `WITH CHECK`.
- Nested write, updateMany: a user who is a legitimate member of both orgs (not a fabricated
  cross-tenant reach) - `memberships.updateMany` under orgA touches only the orgA row; the
  orgB row is verified unchanged afterward by direct read.
- Nested write, deleteMany: same shared-user fixture - only the orgA membership is deleted;
  the orgB one and an unrelated membership both survive, verified by direct read.
- Nested read, the severe one: `Role` is global reference data with no `organizationId` and
  is not the tenant root - the extension does not touch it or its `invitations` relation at
  all. `role.findMany({ include: { invitations: true } })` under orgA context returns only
  orgA's invitations; `tokenHash` for orgB's invitation (`hash_org_b_secret`, planted in the
  fixture specifically to be searched for) is asserted absent from the result. This is
  deliberately the same-shaped leak as "leaked Invitation.tokenHash" - reached through a
  model no per-model scoping could ever cover, which is the whole argument for why RLS is
  mandatory rather than optional.

All five are proven with RLS actively engaged (not merely "would be caught in theory") -
every one runs through `withTenantTransaction(app, orgA, ...)` over the real `sentinel_app`
role.

## Majors

**M1 - fail-closed had no test.** Root cause turned out to be structural: after fully
enumerating Prisma 6.19's real model-delegate operations (`findUnique`, `findUniqueOrThrow`,
`findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `create`,
`createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`,
`delete`, `deleteMany` - verified against the generated client's `.d.ts`, not assumed), every
single one is now explicitly handled. The terminal `refuse` branch is unreachable through the
real Prisma API, which is a good thing, but means an integration test structurally cannot
exercise it (there is no 18th operation to call). Fix: extracted the whole scoping decision
into a pure function, `decideScope` (`packages/db/src/tenant-scope.ts`), with zero
Prisma/network dependency, and unit-tested it directly with a name Prisma will never send:
```
v refuses any operation not explicitly enumerated, rather than passing it through
```
Verified this test actually detects a broken catch-all the same way the other three
control-removal drills were verified - see "Control-removal drills, re-run" below.

**M2 - see above (fixed via the findUnique redesign, not a separate patch).**

**M3 - see above (resolved as a side effect of M2).**

**M4 - coordinator's ruling implemented.** `AuditEvent.organization`'s relation changed from
`onDelete: Cascade` to `onDelete: Restrict` in `schema.prisma`, with the reasoning written
into the model's docstring and into the migration SQL's comments. Implemented in the same
migration as the Organization RLS/REVOKE-DELETE work
(`20260820132520_tenant_root_and_audit_restrict`) since both are schema-level
tenant-isolation fixes. Documented that the purge path belongs to Phase 11, both in the
schema docstring and in `tenant-isolation.md` §1.

One consequence this surfaced: Task 4's pre-existing privilege probe
(`migration.integration.spec.ts`, "sentinel_app can select, insert, update, and delete on a
migrated table") used `Organization` as its "any migrated table" stand-in. Once Organization
carries RLS and has `DELETE` revoked, that test's own premise broke - it started failing for
reasons unrelated to what it was actually testing (raw GRANT-level privileges). Retargeted it
to `User` (global, no RLS, not the tenant root), with a comment explaining why, so the test
goes back to proving what its name says it proves. This is a file outside Task 6's original
list, touched because my C3 fix broke it as a direct, foreseeable consequence - leaving it
broken would have violated `pnpm test:integration` exiting 0.

**M5 - lint pattern fixed, judgement on the type-import trap.** `no-restricted-imports`'s
`group` now includes `'**/unscoped.js'` alongside the original `'**/unscoped'`, with a
comment recording the empirical probe that found the gap (a file importing `../unscoped.js`
outside the exemption list produced zero lint errors under the old pattern - confirmed
before fixing it, not assumed). For `tenant-transaction.ts`'s
`import type { PrismaClient } from './unscoped.js'`: added it to the file-exemption list
(alongside `unscoped.ts`, `seed.ts`, `tenant-client.ts`) rather than adding a rule-level
"allow type-only imports of unscoped" carve-out. Reasoning, recorded in `eslint.config.js`'s
comment: only one file needs it, so a file-scoped exemption is narrower than a rule-level one
that would apply everywhere a type-only import of `unscoped` might ever appear.

**N1 - null missed by the context guard.** `hasOwnScopeContext` in `tenant-scope.ts` now
checks `!== null && !== undefined && !== ''` (previously `!== '' && !== undefined` only).
Direct unit test:
```
v refuses when there is no organisation in context - null
```

## N3 - Membership/Invitation behavioural RLS tests

Added to `rls.integration.spec.ts`: "is the backstop for Membership: ..." and "is the
backstop for Invitation: ...", same shape as the existing `AuditEvent` backstop test - one
shared user with a legitimate row in both orgs (so the fixture cannot pass by accident, the
way it would if Tenant A simply had zero rows of its own), raw SQL under orgA's transaction,
assert only orgA's row comes back. Both pass, confirming what was previously only inferred
from the `pg_class` flag check.

## The FORCE behavioural test the coordinator said the reviewer built

Added "FORCE ROW LEVEL SECURITY is load-bearing: ..." to `rls.integration.spec.ts`. Builds a
purpose-built non-superuser role, makes it the owner of a throwaway table with an RLS policy
but no `FORCE`, inserts a row under a different "tenant," connects as that owner role with no
GUC set, and shows the row is visible (owner bypass, since RLS isn't forced), then applies
`FORCE` and shows the same connection with the same row now sees nothing. This is the test I
flagged as missing in the first round; it now exists permanently, not just as a one-off
drill.

## N4 - documentation status banners

Updated in the same change, not deferred:
- `.claude/security/tenant-isolation.md` - rewrote the status banner and Sections 1/2 to
  describe what's actually true: layer 1 scopes top-level operations only (documented as a
  deliberate limitation, with the `findUnique` mechanism corrected); layer 2 is implemented
  and, since this round, verified to compose with layer 1 via `withTenantTransaction`,
  including that getting the composition order backwards is a real failure mode that shipped
  once (recorded, not hidden); the tenant root concept added to Section 1; not yet wired into
  a request pipeline - that's still Phase 2.
- `.claude/decisions/ADR-0006-multi-tenant-isolation.md` - added an Implementation-note
  section (rather than rewriting the historical Decision text) recording that the
  `findUnique`-rewrite approach the ADR originally decided on turned out not to compose with
  transactions, and what replaced it, plus the tenant-root gap in the original decision.

## Control-removal drills, re-run against the final code

The mechanism for two of the original four drills changed substantially (findUnique's
rewrite no longer exists; the context guard moved into `tenant-scope.ts`), so both were
re-run against the final implementation rather than assumed still valid from the first round.

**1. Disable the findUnique scope check** (`tenant-client.ts`'s `run-and-check` branch,
skipped the `row[plan.checkField] === plan.expected` comparison and returned the raw result):
```
x rewrites findUnique into a tenant-scoped lookup - the single easiest mistake to make
  AssertionError: expected row to be null
  Received: Tenant B's real row
x rewrites findUnique by a compound unique key, not just by id
  AssertionError: expected row to be null
Tests  2 failed | 24 passed (26)   [tenant-client.integration.spec.ts]
```
Notably, `tenant-transaction.integration.spec.ts`'s equivalent findUnique tests stayed green
under this same broken code, because those run over `sentinel_app` with RLS engaged, so
layer 2 caught what layer 1's disabled check no longer did. Restored; re-ran green.

**2. Disable the context guard** (`hasOwnScopeContext` in `tenant-scope.ts`, forced to always
return `true`):
```
x decideScope > refuses when there is no organisation in context - empty string
x decideScope > refuses when there is no organisation in context - undefined
x decideScope > refuses when there is no organisation in context - null
Tests  3 failed | 18 passed (21)   [tenant-scope.spec.ts, unit]

x throws when there is no organisation in context
  AssertionError: promise resolved "[]" instead of rejecting
Tests  1 failed | 11 passed (12)   [tenant-client.integration.spec.ts]
```
Restored; re-ran green.

**3. Drop AuditEvent's RLS policy** (migration SQL, `ENABLE`/`FORCE` left in place, `CREATE
POLICY` commented out) - re-verified against the current two-migration setup, since a second
migration was added this round:
```
x is the backstop: raw SQL that skips the client extension still sees only one tenant
  AssertionError: expected 0 to be greater than 0
Tests  1 failed | 8 passed (9)   [rls.integration.spec.ts]
```
Restored; re-ran green.

**4. Remove FORCE from one table.** Not re-run as a manual migration edit this round - the
new permanent FORCE behavioural test (above) supersedes it: it doesn't just check a
`pg_class` metadata flag, it constructs the actual non-superuser-owner scenario `FORCE`
protects against and demonstrates the real bypass, live, every time the suite runs. Judged
this stronger than repeating the manual drill.

All four restorations confirmed via `grep -rn "CONTROL-REMOVAL"` returning no matches, and a
full green re-run of every command below, after every drill.

## Five root commands (final state, after all fixes)

```
pnpm lint             -> 5 successful, 5 total (0 errors, 0 warnings)
pnpm typecheck        -> 5 successful, 5 total
pnpm test             -> 7 files, 95 tests passed
pnpm test:integration -> 4 files, 39 tests passed
pnpm build            -> 4 successful, 4 total
```

Test count grew from 20 integration tests (no dedicated unit tests in this package) in the
first round to 39 integration + 21 unit (`tenant-scope.spec.ts`) in this round - the unit
tests are new and load-bearing (M1's fail-closed proof structurally cannot live in an
integration test, as explained above).

## Files changed or added this round

**Added:**
- `packages/db/src/tenant-scope.ts` - pure scoping decision logic (`decideScope`,
  `withScopedWhere`, `scopeUniqueWhere`, `withScopedData`), no Prisma/network dependency.
- `packages/db/src/tenant-scope.spec.ts` - 21 unit tests, no database.
- `packages/db/src/tenant-transaction.integration.spec.ts` - 14 integration tests: both
  layers composed over the real `sentinel_app` role, the tenant root, and the C1/C2 nested
  probes.
- `packages/db/prisma/migrations/20260820132520_tenant_root_and_audit_restrict/migration.sql`
  - AuditEvent's FK to Restrict, Organization's RLS policy, REVOKE DELETE ON Organization.

**Rewritten:**
- `packages/db/src/tenant-client.ts` - now a thin Prisma-extension adapter around
  `tenant-scope.ts`; the `modelDelegate`/`DelegateMethod` mechanism from the first round is
  gone entirely (no longer needed, since nothing dispatches to a different operation
  anymore).
- `packages/db/src/tenant-transaction.ts` - extend-then-transact ordering (C4).

**Modified:**
- `packages/db/src/tenant-resources.ts` - added `TENANT_ROOT_MODEL`/`isTenantRootModel`.
- `packages/db/src/index.ts` - exports the two new symbols.
- `packages/db/prisma/schema.prisma` - `AuditEvent`'s FK changed to Restrict, docstring
  updated.
- `packages/db/src/tenant-client.integration.spec.ts` - added the compound-unique findUnique
  test (M3).
- `packages/db/src/rls.integration.spec.ts` - added Membership/Invitation behavioural tests
  (N3) and the FORCE behavioural test.
- `packages/db/src/migration.integration.spec.ts` - retargeted the generic privilege probe
  from Organization to User (see M4 above).
- `eslint.config.js` - widened the `no-restricted-imports` pattern; added
  `tenant-transaction.ts` to the file exemption.
- `.claude/security/tenant-isolation.md`, `.claude/decisions/ADR-0006-multi-tenant-isolation.md`
  - corrected to describe what's actually implemented (N4).

## Deferred, per the coordinator's explicit instruction

- N2 - cross-tenant `upsert` silently becoming a create in the caller's own tenant. Not
  fixed; coordinator judged this surprising-but-not-a-leak and asked it be left alone.
- N5 - Task 14's registry check needs a tenant-root concept. `TENANT_ROOT_MODEL`/
  `isTenantRootModel` are exported and ready for it; the coordinator said they'd carry the
  rest into Task 14's dispatch, so no further action taken here.

## Self-review (this round)

- Read the full diff twice: once after C4/M2/M3/C3's redesign, once after the Major/N-item
  pass. No leftover console.log, no stray `as any`, no debug code.
- Confirmed no `CONTROL-REMOVAL` drill markers remain, twice (once mid-round, once
  immediately before this report).
- Verified empirically, not assumed: the Prisma extension callback's actual `this`-binding
  and the `$transaction`-on-extended-client propagation, both by reading the generated
  client's minified runtime directly, before writing any fix code.
- Found and fixed one bug in my own first-draft fix before it ever ran green: the naive
  AND-wrap approach to the tenant-root redirect problem would have broken `WhereUniqueInput`
  validation for every `delete`/`update`/`upsert` on `Organization`, including the ordinary
  same-org case. Caught by trying it, watching `pnpm typecheck`/the test suite object, and
  redesigning before it was ever a committed version of the fix.

## Concerns carried forward

1. The `run-and-check` design for `findUnique` momentarily materialises a row that may
   belong to another tenant, inside the Node process, before deciding whether to return it -
   never returned to the caller, never logged, but a stricter defence-in-depth read would
   prefer the row never leave the database at all. Judged an acceptable, standard
   fetch-then-authorise tradeoff given Prisma's actual API surface offers no alternative that
   also fixes M2; flagging for awareness, not as an open defect.
2. `scopeUniqueWhere`'s collision check compares the caller's `where[keyField]` value with
   strict inequality; it does not attempt to parse an adversarially-constructed Prisma filter
   operator (e.g. `{ organizationId: { not: 'evil' } }`) placed in that same auxiliary
   position on a `WhereUniqueInput`. This is a narrow, deliberately-crafted pattern no
   legitimate caller would write; documented as a known limitation in `tenant-scope.ts`
   rather than silently assumed handled.
3. Per N5, `TENANT_ROOT_MODEL` is exported but Task 14's actual DMMF-driven completeness
   check (does every model with `organizationId`, or every model that "is" a tenant, appear
   in exactly one bucket) is not built here - only the concept it will need.


---

# Addendum — round 3 (all round-2 findings confirmed addressed)

Round 2 re-review confirmed all twelve findings and the FORCE test addressed, behaviourally
verified over sentinel_app, including 12 GUC iterations and concurrent-transaction isolation.
C4's fix and the findUnique redesign were both singled out as correct. Three items remained,
with an approved plan. This addendum covers all three plus the documentation fixes.

## Critical — FK cascade destroyed another tenant's Membership

`Membership.userId` was the one FK into a tenant-owned table still `Cascade`. Deleting a
`User` who belonged to two organisations, from either tenant's `withTenantTransaction`
context, cascaded through and destroyed the OTHER organisation's Membership row too — RI
cascades run inside Postgres's constraint machinery, below both isolation layers.

**Before (captured live, prior to creating the fix migration):**
```
x deleting a User does not destroy another tenant's Membership through the FK cascade
  AssertionError: promise resolved "{ ...(7) }" instead of rejecting
```
`tx.user.delete({ where: { id: sharedUser } })` succeeded silently over sentinel_app inside
`withTenantTransaction(orgA)`, for a user who also had a legitimate membership in orgB.

**Fix:** `Membership.userId` -> `onDelete: Restrict` in `schema.prisma`, migration
`20260820142200_membership_user_restrict`. `DELETE` on `User` deliberately stays granted to
`sentinel_app` — account deletion is a legitimate Phase 2 flow; the schema comment records
that it must remove memberships per-organisation first, through the normal tenant-scoped
path, before the `User` row itself can go.

**After:**
```
v deleting a User does not destroy another tenant's Membership through the FK cascade
Tests  1 passed | 14 skipped (15)
```
The delete now fails on the FK, and both organisations' membership rows survive — verified
by reading both directly afterward, not just by the delete throwing.

## Important — select/omit defeated the scope check

`findUnique`'s fetch-then-check design (round 2) reads the scope column off whatever the
query returned. A caller's own `select`/`omit` — exactly what CLAUDE.md's N+1/DTO discipline
pushes toward — could exclude that column, making an owned row's scope field read as
`undefined`, never match, and the row get discarded as if it belonged to another tenant.
Fail-closed, but wrong for the caller who owns the row.

**Fix**, threading through the existing design rather than replacing it:
- `ScopePlan`'s `run-and-check` variant gained `stripCheckField: boolean`.
- New pure helper `adjustProjectionForCheck` (`tenant-scope.ts`): widens `select` to include
  the scope column if absent, or drops it from `omit` if excluded, and flags which happened.
  `select`/`omit` are mutually exclusive at the same level in Prisma, so at most one branch
  ever fires. 6 new unit tests, no database.
- `tenant-client.ts`'s `run-and-check` case: after the check passes, `delete row[plan.checkField]`
  when the flag is set, so the caller gets exactly the shape it asked for.
- `keyField` is `'id'` for the tenant root, so `Organization` is covered by the same code path
  with no special-casing.

Proven on **both** connections (superuser, `tenant-client.integration.spec.ts`; and
`sentinel_app` + RLS, `tenant-transaction.integration.spec.ts`): owned-row `findUnique` with
`select: { id: true, status: true }`, with `omit: { organizationId: true }`, and
`organization.findUnique` with `select: { name: true }` all return the row without the
scope field the caller didn't ask for; a `select`-narrowed cross-tenant `findUnique` is
still `null` — the fix doesn't open a second bypass route.

## Important — findUniqueOrThrow was a cross-tenant existence oracle

A cross-tenant `findUniqueOrThrow` threw `MissingTenantContextError`; a genuine miss threw
Prisma's own `P2025`. Distinguishable by class, so catching the error told a caller whether
another tenant's row existed, even though its contents never leaked.

**Fix (as of round 3's initial pass, since superseded — see the round-4 addendum below for
the final design):** `unscoped.ts` was changed to export `Prisma` as a value (previously
`export type { Prisma }` only). `tenant-client.ts` raised a hand-constructed
`Prisma.PrismaClientKnownRequestError` with a bespoke message. **Correction**: this produced
the same class and code, but not the same message or `meta` — round 3 re-review caught that
the wording only matched by coincidence on the RLS-engaged path, where RLS removes the row
and Prisma's own P2025 fires before the check ever runs; on every connection without RLS
(the unscoped client, migrations, seeds, the platform-admin module) the hand-built message
was distinguishable from a genuine miss's. Superseded — see the round-4 addendum for what
actually ships.

Proven on both connections that a cross-tenant miss and a genuine miss raise the same error
class (`Prisma.PrismaClientKnownRequestError`) and code (`P2025`) — `tenant-client.integration.spec.ts`
(superuser) and `tenant-transaction.integration.spec.ts` (sentinel_app + RLS, where the two
cases would otherwise look identical for a *different* reason — RLS silently returning
nothing and Prisma raising its own P2025 first — so proving it here confirms layer 1's own
guarantee holds independently of whether RLS happens to be engaged).

## Documentation

- **`.claude/product/roadmap.md`**: Phase 1 changed from "Not Implemented" to "Partially
  Implemented"; the "no application code exists" claim replaced with an accurate accounting
  of the four packages that exist and are verified working (`config`, `observability`,
  `contracts`, `db`), explicit that there is no `apps/web`/`apps/api` yet and nothing is
  deployed, so the phase itself is still not complete.
- **`.claude/security/tenant-isolation.md` §2**: the layer-1 caveat widened from "relation
  traversal" to "relation traversal and referential-integrity cascades", with the
  `Membership.userId` finding cited as the concrete example; states explicitly that layer 2
  does not run at all for migrations, seeds, and the platform-admin module. Also documented
  the `select`/`omit` handling and the `findUniqueOrThrow` P2025 fix as new layer-1 bullets.
- **`.claude/development/coding-standards.md` §7**: added the house rule — scalar foreign
  key in `data`, never Prisma's relation-connect form, on tenant-owned models — with the
  reasoning (the extension forces the scalar column; `connect` has no such key to force) and
  the decision not to teach the extension to normalise it. Mirrored in `tenant-client.ts`'s
  docblock.
- **`rls.integration.spec.ts`**: the `pg_class` flag assertion now includes `Organization`
  alongside the three `TENANT_OWNED_MODELS` — its flags were correct but untested.

## Verification

1. **FK cascade** — before/after transcripts above, both real (not asserted).
2. **select/omit** — 5 tests across both connections, all passing (see above).
3. **The oracle** — 2 tests (superuser and sentinel_app), both confirming identical error
   class and code for cross-tenant vs. genuine-miss.
4. **Regression**:
   - The four round-1 Critical probes (C1-C4) remain permanent tests in
     `tenant-transaction.integration.spec.ts` and all pass in the final run below.
   - Both control-removal drills re-run against the final code:
     - Disabled the `run-and-check` scope comparison entirely (`return result` before the
       check) — **8 tests failed** across both integration files: the original findUnique
       leak test, all select/omit tests, and both oracle tests. Restored; re-ran green.
     - Disabled `hasOwnScopeContext` (forced `true`) — **3 unit tests failed**
       (`tenant-scope.spec.ts`, empty/undefined/null) and **1 integration test failed**
       (`throws when there is no organisation in context`, resolved `[]` instead of
       rejecting). Restored; re-ran green.
   - `grep -rn "CONTROL-REMOVAL"` returns no matches after both restorations.
5. All five root commands, final state:
```
pnpm lint             -> 5 successful, 5 total (0 errors, 0 warnings)
pnpm typecheck        -> 5 successful, 5 total
pnpm test             -> 7 files, 100 tests passed
pnpm test:integration -> 4 files, 48 tests passed
pnpm build            -> 4 successful, 4 total
```

## Files changed this round

**Added:**
- `packages/db/prisma/migrations/20260820142200_membership_user_restrict/migration.sql`

**Modified:**
- `packages/db/prisma/schema.prisma` — `Membership.userId` FK to `Restrict`, with reasoning
  in the relation comment.
- `packages/db/src/tenant-scope.ts` — `adjustProjectionForCheck`, `stripCheckField` on
  `ScopePlan`'s `run-and-check` variant.
- `packages/db/src/tenant-scope.spec.ts` — 6 new unit tests for select/omit handling; the
  existing `toEqual` assertions updated for the new `stripCheckField` field.
- `packages/db/src/unscoped.ts` — `Prisma` exported as a value, not type-only.
- `packages/db/src/tenant-client.ts` — value-imports `Prisma`; strips the scope column when
  flagged; raises `Prisma.PrismaClientKnownRequestError` (P2025) for the cross-tenant
  `findUniqueOrThrow` case; house-rule docblock addition.
- `packages/db/src/tenant-client.integration.spec.ts` — `membershipA` captured by id (was
  previously anonymous); 5 select/omit tests; 1 oracle test.
- `packages/db/src/tenant-transaction.integration.spec.ts` — 1 FK-cascade test
  (`referential-integrity cascades run below both layers`); 1 select/omit test; 1 oracle
  test, both over `sentinel_app`.
- `packages/db/src/rls.integration.spec.ts` — `Organization` added to the `pg_class` flag
  assertion.
- `.claude/product/roadmap.md`, `.claude/security/tenant-isolation.md`,
  `.claude/development/coding-standards.md` — corrected per above.

## Self-review, this round

- Confirmed `Prisma.PrismaClientKnownRequestError` is a genuine runtime value in the
  generated client (`Prisma.PrismaClientKnownRequestError = PrismaClientKnownRequestError`
  in `generated/client/index.js`) before changing `unscoped.ts`'s export, rather than
  assuming the type-level namespace re-export implied a value existed.
- Re-ran the full regression suite (not just the new tests) after every change, three times
  total this round (after the FK fix, after the select/omit+oracle fix, after the drills).
- One deviation I'm flagging rather than hiding: `tenant-transaction.integration.spec.ts` is
  now 360 lines, `tenant-scope.ts` is 308 — both over the ~300-line guidance from the
  original brief. Splitting the test file cleanly would mean duplicating the harness/fixture
  setup (a second Testcontainers Postgres instance) across files; judged the duplication cost
  higher than the benefit for a well-organised file with five clearly delineated `describe`
  blocks, but did not silently let this slide — recording it here for the coordinator's call
  if it should still be split.

## Concerns carried forward (unchanged from round 2, still applicable)

1. `findUnique`'s fetch-then-check momentarily materialises a row that may belong to another
   tenant in-process before deciding whether to return it — accepted tradeoff, no alternative
   given Prisma's actual API.
2. `scopeUniqueWhere`'s collision check uses strict inequality; does not parse an
   adversarially-constructed filter-operator object in the same auxiliary position.
3. `TENANT_ROOT_MODEL` is exported but Task 14's completeness check is not built here.


---

# Addendum — round 4 (final)

Round 3 re-review confirmed the Critical closed (reviewer reverted the FK on a live database,
reproduced the destruction, restored, watched the probe go green — and independently swept
`pg_constraint` for siblings) and the select/omit fix solid (21 projection cases, two
control-removal drills, confirmed no new cross-tenant hole). Three small items remained.

## 1. The oracle — now genuinely closed, not just class/code

Round 3's fix matched class (`PrismaClientKnownRequestError`) and code (`P2025`) but not
message or `meta` off the RLS-engaged path — a hand-built string, byte-identical to a
genuine miss only by coincidence where RLS masks the difference.

**Fix, replacing the hand-built error entirely:** rather than constructing our own
`PrismaClientKnownRequestError`, the `notFoundIsThrow` branch now re-runs the *same*
operation via `query()` (still on the caller's own connection/transaction) with
`where: { id: NEVER_MATCHES_ID }` — a sentinel guaranteed not to exist. Every tenant-owned
model and the tenant root carries a plain `id String @id`, so this is always a structurally
valid `WhereUniqueInput` regardless of the caller's original `where` shape (compound unique
key included). Prisma's own engine then raises its own, genuine not-found error — nothing
hand-built to drift when Prisma's wording changes across versions.

**Test changed from asserting class+code to deep-equalling message and `meta` against a
genuine miss captured live in the same run** (not a hardcoded string, so it also catches
drift). First attempt at this failed in an instructive way:

```
x raises byte-identical message and meta for a cross-tenant row as for one that does not exist
  AssertionError: expected '...findUniqueOrThrow() invocation in
  ...tenant-client.integration.spec.ts:265:27...' to be '...tenant-client.integration.spec.ts:258:27...'
```

Prisma's "Invalid `...` invocation" message embeds the **caller's own file/line/column**,
captured at the point `findUniqueOrThrow` was invoked — not anything about the target row.
My two probe calls were written on different lines in the test, so the messages differed by
that location text alone. That is not the oracle the fix is checking for: a single real call
site in application code always reports its own location, whichever outcome it hits. Fixed
by funnelling both attempts through one shared helper function so they share a call site —
after that, message and `meta` are genuinely byte-identical. Documented in both tests'
comments so this isn't rediscovered as a flake. Re-run, both connections:

```
v raises byte-identical message and meta for a cross-tenant row as for one that does not exist
  [tenant-client.integration.spec.ts, superuser -- no RLS]
v findUniqueOrThrow raises byte-identical message and meta on the sentinel_app connection too
  [tenant-transaction.integration.spec.ts, sentinel_app + RLS]
```

Since production code no longer hand-constructs the error, `unscoped.ts`'s value-export of
`Prisma` is now used only by the tests (`instanceof`/error-shape assertions), not by
`tenant-client.ts` itself — the import was removed from there.

## 2. The false invariant in tenant-isolation.md

Corrected the claim from "every FK into a tenant-owned table is `RESTRICT`" (false —
`Membership.organizationId` and `Invitation.organizationId` are both `CASCADE`, and
correctly so) to the actual, checked invariant: **no FK into a tenant-owned table from a
non-tenant-scoped parent is `CASCADE`**. Added the one-clause reason the `Organization`-origin
cascades are safe: they originate at the tenant root, so the cascade can only ever stay
inside the one tenant being deleted, layer 1 already scopes `organization.delete` to the
caller's own `id`, and `sentinel_app` holds no `DELETE` on `Organization` at all.

## 3. Report overclaim

Corrected `task-6-report.md`'s round-3 addendum: the "same class, code, and message shape"
claim described the round-3 *initial* fix, which round 3 re-review then found incomplete.
Replaced with an accurate account of what that pass actually produced and a pointer to this
addendum for what ships.

## Coordinator's two rulings, applied

- **File lengths**: accepted as-is, no change. `tenant-transaction.integration.spec.ts`
  (now ~370 lines) and `tenant-scope.ts` (~325 lines) both stay over the ~300-line guidance —
  splitting the spec would mean duplicating the Testcontainers harness, judged worse than the
  length; ~300 is a guideline, not a hard gate, and this is not the file to churn for it.
  Recorded here so it isn't re-litigated by a future reader.
- **Client-level `omit`**: documented, not fixed. Added a comment to
  `adjustProjectionForCheck` in `tenant-scope.ts` recording that a client-level `omit`
  (`new PrismaClient({ omit: { membership: { organizationId: true } } })`, as opposed to a
  per-call `omit` in `args`) reaches this function with `args.omit` still `undefined` —
  Prisma applies client-level omit after the extension pipeline — so the widening never
  fires and affected `findUnique` calls fail closed (every owned row reads as not found,
  no leak, just a false negative). Not fixable from inside `$allOperations`: a per-call
  `omit` and a client-level one are indistinguishable from the arguments available there.
  Nothing in this codebase constructs a client this way; Task 14 carries a guard against it.

## Verification

All five root commands, final state:
```
pnpm lint             -> 5 successful, 5 total (0 errors, 0 warnings)
pnpm typecheck        -> 5 successful, 5 total
pnpm test             -> 7 files, 100 tests passed
pnpm test:integration -> 4 files, 48 tests passed
pnpm build            -> 4 successful, 4 total
```
The oracle probe re-run individually on both connections, both green (transcripts above).

## Files changed this round

- `packages/db/src/tenant-client.ts` — oracle fix replaced (re-query instead of hand-built
  error); `Prisma` value import removed (no longer needed in production code); added
  `NEVER_MATCHES_ID` sentinel constant with its rationale.
- `packages/db/src/tenant-scope.ts` — client-level `omit` note added to
  `adjustProjectionForCheck`'s docblock.
- `packages/db/src/tenant-client.integration.spec.ts`,
  `packages/db/src/tenant-transaction.integration.spec.ts` — oracle tests changed from
  class/code assertions to message/meta deep-equality against a live genuine miss; both
  refactored to route their two probe calls through a shared call site once the first attempt
  showed why that matters.
- `.claude/security/tenant-isolation.md` — FK invariant corrected.
- `.superpowers/sdd/2026-08-20-phase-1-foundation/task-6-report.md` — round-3 addendum's
  overclaiming sentence corrected.

## Self-review, this round

- The shared-call-site requirement wasn't something I anticipated — found it by running the
  test and reading the actual failure, not by reasoning about Prisma's internals in advance.
  Verified the fix by re-running immediately after, on both connections, rather than assuming
  the same reasoning would transfer.
- Confirmed `tenant-client.ts` no longer imports `Prisma` as a value (grepped for it) once the
  hand-built error was removed, so the file doesn't carry an unused/vestigial import.
- Re-ran the full suite (not just the changed tests) before concluding, per the coordinator's
  explicit ask.


---

# Addendum — round 5 (final; task closed by coordinator)

Final re-review: items 1-3 from round 4 confirmed addressed by live reproduction, including
two properties not explicitly claimed — the re-query design generalises to compound unique
keys, and query-count instrumentation confirmed the extra round trip fires only on the
cross-tenant path (1 query on success or a genuine miss, 2 only when a row exists in the
wrong tenant). Two one-liners remained.

## 1. NEVER_MATCHES_ID collision returned wrong data

The reviewer planted a row whose `id` was literally the sentinel string, on the unscoped
connection, then ran a cross-tenant `findUniqueOrThrow` for an unrelated org's row. The
fallback query's plain equality lookup (`{ id: NEVER_MATCHES_ID }`) matched that planted row
and returned its full, unrelated content instead of throwing — worse than the oracle
problem this branch exists to fix, since it hands back real data rather than merely a
distinguishable error shape.

**Fix**: the fallback `where` is now self-contradictory —
`{ id: NEVER_MATCHES_ID, NOT: { id: NEVER_MATCHES_ID } }` — rather than a plain equality.
No row can ever satisfy "id equals X and id does not equal X" simultaneously, regardless of
what is planted in the table. This closes the vulnerability class outright (logically
impossible, not merely unreachable through normal application code) while still routing
through `query()`, so Prisma's own engine still raises the authentic not-found error — the
whole point of the round-4 design is preserved, nothing hand-built was reintroduced.

Confirmed `MembershipWhereUniqueInput` (and, by the same generated-type pattern, every other
tenant-owned model's and the tenant root's `WhereUniqueInput`) supports `NOT` alongside the
required unique field before relying on it, rather than assuming.

**Verified the fix is real, not just present**: reverted to the plain-equality where, re-ran
the new test, watched it reproduce the reviewer's exact finding, restored, re-ran green.
```
x still throws not-found even when a row id literally collides with the fallback sentinel
  AssertionError: promise resolved "{ ...(8) }" instead of rejecting
  Received: { id: "00000000000000000000000000-tenant-scope-miss", organizationId: "org_...",
              status: "ACTIVE", ... }        <- the planted row's real content
```
Restored; re-ran green (19/19 in `tenant-client.integration.spec.ts`).

**New permanent test** (`tenant-client.integration.spec.ts`): plants a `Membership` row with
`id: NEVER_MATCHES_ID` (exported from `tenant-client.ts` so the test can't drift from the
real constant) on the owner/unscoped connection — exactly the privileged connection this
vulnerability was reachable from — then asserts a cross-tenant `findUniqueOrThrow` still
throws `{ code: 'P2025' }` rather than returning the planted row.

## 2. Stale comment in unscoped.ts

This round's own earlier pass (round 4) removed `tenant-client.ts`'s value-import of
`Prisma` (production code no longer hand-constructs the error; it re-runs the query instead)
but left `unscoped.ts`'s comment claiming `tenant-client.ts` still needed
`Prisma.PrismaClientKnownRequestError` at runtime. Corrected: the comment now says the value
export exists for the integration tests' `instanceof`/shape assertions, and that
`tenant-client.ts` itself only needs `Prisma`'s types now, via the `PrismaClient` type
import — with a pointer to where the real error comes from (the re-run, not a construction).

## Verification

All five root commands, final state:
```
pnpm lint             -> 5 successful, 5 total (0 errors, 0 warnings)
pnpm typecheck        -> 5 successful, 5 total
pnpm test             -> 7 files, 100 tests passed
pnpm test:integration -> 4 files, 49 tests passed
pnpm build            -> 4 successful, 4 total
```

## Files changed this round

- `packages/db/src/tenant-client.ts` — fallback `where` made self-contradictory
  (`NOT: { id: NEVER_MATCHES_ID }` added); `NEVER_MATCHES_ID` exported for the new test;
  comments updated to record the finding and the reasoning for the self-contradiction over a
  plain equality lookup.
- `packages/db/src/tenant-client.integration.spec.ts` — new test planting a sentinel-id row
  and asserting the cross-tenant call still throws not-found; imports `NEVER_MATCHES_ID`
  rather than duplicating the literal.
- `packages/db/src/unscoped.ts` — comment corrected to describe the actual current use of
  the `Prisma` value export (tests only, not production code).

## Residuals for the whole-branch review (per the coordinator, not fixed here)

- `findUnique`'s fetch-then-check momentarily materialises a row that may belong to another
  tenant in-process before deciding whether to return it.
- `scopeUniqueWhere`'s collision check (for `delete`/singular `update`/`upsert`'s `where`,
  distinct from the `findUniqueOrThrow` fallback fixed this round) uses strict inequality
  and does not parse an adversarially-constructed filter-operator object in the same
  auxiliary position.
- The client-level `omit` fail-closed gap in `adjustProjectionForCheck` — documented, not
  fixed; Task 14 carries a guard against constructing a client that way.
- `TENANT_ROOT_MODEL` completeness — exported and ready; Task 14 builds the actual
  DMMF-driven check.

## Self-review, this round

- Verified `NOT` is genuinely supported on `MembershipWhereUniqueInput` by reading the
  generated client's `.d.ts` directly before relying on it, rather than assuming Prisma's
  general documentation applied unchanged to this generated version.
- Reproduced the reviewer's exact finding via a control-removal drill (revert, watch it
  fail with the same symptom, restore, re-verify green) before trusting the fix, matching
  the standard this task has held throughout every round.
- Kept the diff to what was asked: two files' worth of one-liners plus the requested test,
  no unrelated changes.
