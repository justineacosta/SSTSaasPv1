# Phase 2 · Task 2 — implementer's report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. One implementer across three rounds — the build, then two fix rounds driven by
the adversarial review — plus a fresh reviewer between rounds one and two. Commands and exit codes
only; every sentence asserting anything was written by the orchestrator, per the plan's Execution
protocol §3.

## Rounds

| Round | Scope | Commits |
|---|---|---|
| 1 | The contracts themselves: ID prefix map and parity, `Principal`, `TenantContext`, list query, auth/organisation/membership/invitation schemas, the `UNKNOWN_FIELD` pipe branch | `ac67d2c`, `e4ad53a`, `9ed3894`, `3ffbd30`, `1aaa6b8`, `b0d65d9` |
| Review | Fresh adversarial reviewer, citation pass first — 25 claims re-verified, 11 findings | — |
| 2 | Findings F1, F3, F4, F5, F6, F7, F10 | `95c5348`, `92d3180`, `89c239a`, `99bf418` |
| 3 | The orchestrator's UTC-only timestamp ruling (F6 follow-on) | `4788826` |

## Final verification, re-run by the orchestrator rather than taken on report

Every command below was run by the orchestrator on the finished tree at `4788826`, with exit codes
captured via `out=$(pnpm <cmd> 2>&1); code=$?` — **not** through a pipe, because `$?` after a pipe
reports the last stage's status rather than the command's. The first round's own sweep used the
piped form and its exit codes were meaningless; the implementer caught and re-ran that itself.

| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | All matched files use Prettier code style |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm test` | 0 | **43 files / 536 tests** |
| `pnpm check:specs` | 0 | 54 spec files, each claimed by exactly one project |
| `pnpm test:integration` | 0 | 11 files / 148 tests |
| `pnpm build` | 0 | 8 tasks |
| `pnpm test:e2e` | 0 | 5 passed, chromium |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)` |
| `pnpm check:openapi` | 0 | `apps/api/openapi.json` byte-identical; **routes: 4**, unchanged |
| `pnpm check:registry` | 0 | 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global |

Unit tests moved **416 → 536** across 32 → 43 files. Integration is **unchanged at 11 / 148**,
which is correct: this task added no integration spec, and both new parity specs compare
in-process constants.

## Test-first evidence

The plan requires the red state to be reported, not only the green one. The reviewer, working
only from the repository, could not confirm test-first ordering because every round-one commit
carries spec and implementation together — that limitation is recorded in
[`rulings.md`](rulings.md). What follows is the output the implementer captured at the time.

**`ids.spec.ts`**, before the prefix map existed:
```
FAIL packages/contracts/src/ids.spec.ts > ID_SCHEMA_PREFIXES > uses three characters for every prefix
TypeError: Cannot convert undefined or null to object
 Tests  4 failed | 4 passed (8)
```
After: `8 passed (8)`.

**`id-prefix-parity.spec.ts`**, before the four prefixes were added to `packages/db`:
```
AssertionError: expected [ 'mfa', 'vtk', 'rcv', 'idp' ] to deeply equal []
 ❯ packages/db/src/id-prefix-parity.spec.ts:48:21
```
After: green.

**`principal.ts` / `tenant-context.ts`** — runtime red was a missing module; the *typed* red was
the one that mattered:
```
src/principal.spec.ts(71,17): error TS2322: Type 'Principal' is not assignable to type 'never'.
src/tenant-context.spec.ts(26,5): error TS2578: Unused '@ts-expect-error' directive.
Exit status 2
```
The implementer reported, unprompted, that `tenant-context.spec.ts` **ran green at runtime while
its module did not exist**, because both imports were type-only. The reviewer independently
confirmed it (F5) and it was fixed in round 2 by a side-effect import, proven by renaming the
module away:
```
Error: Cannot find module './tenant-context.js' imported from '…/tenant-context.spec.ts'
 Test Files  1 failed (1)  |  Tests  no tests
```

**`ZodValidationPipe`**, before the `UNKNOWN_FIELD` branch:
```
AssertionError: expected 'VALIDATION_ERROR' to be 'UNKNOWN_FIELD'
AssertionError: expected [ 'nested' ] to deeply equal [ 'nested.extar' ]
AssertionError: expected [ '' ] to deeply equal [ 'a', 'b' ]
 Tests  4 failed | 11 passed (15)
```
A **second** red followed the first implementation attempt — the expanded field path echoed the
caller's raw key un-redacted:
```
AssertionError: expected '{"fields":[{"path":"https://user:hunt…' not to contain 'hunter2'
```
After: `15 passed (15)`. The reviewer re-tested this path itself with a credentialed URL used as
an unknown **key name** and confirmed the secret reaches neither `path` nor `message`.

**`enum-parity.spec.ts`** (fix round 1) — the red that matters was produced by mutating the
schema, not the spec. `ARCHIVED` added to `enum OrganizationStatus`, client regenerated:
```
AssertionError: OrganizationStatus differs from its contracts restatement:
  expected [ 'ACTIVE', 'SUSPENDED', 'TERMINATED' ] to deeply equal [ 'ACTIVE', 'ARCHIVED', …(2) ]
 Tests  1 failed | 4 passed (5)
```
Under the same mutated schema the two **contracts-side** specs stayed green — which is the
finding the new spec exists to close. Reverted, regenerated, green, no residue in `schema.prisma`
or `generated/`.

**`paginationSchema`** (fix round 1), before the `limit` field:
```
FAIL paginationSchema > requires the limit — an envelope without one is not the documented shape
  AssertionError: expected true to be false   (pagination.spec.ts:21:86)
 Tests  3 failed | 7 passed (10)
```

**`isoTimestampSchema`** (fix round 3), specs changed first, schema untouched:
```
FAIL timestamps.spec.ts > rejects an explicit non-UTC offset — "always UTC" is enforced, not just documented
FAIL organizations.spec.ts > requires timestamps to be UTC ISO 8601 strings
AssertionError: expected true to be false
 Tests  2 failed | 18 passed (20)
```
After narrowing to `z.string().datetime()`: `20 passed (20)`. That Zod 3's `.datetime()` without
`offset` rejects `+01:00`, `-05:00` and `+00:00` while accepting `…Z` was established by that run,
not from memory.

**`timestamps.spec.ts`** passed on first write, because the schema was already correct in that
respect. The implementer proved it non-vacuous rather than leaving it — weakening the schema to
`z.string()` turned three assertions red — and said so.

## What the implementer declared against itself

Recorded because a self-declared deviation is worth more than one found later.

- Created `timestamps.ts` and `pagination.spec.ts` and modified `pagination.ts`, none of which the
  brief's file tables named. The brief required ISO-8601 timestamps and a bounded `limit` on every
  list query but gave neither a home; the alternative was three copies of each.
- `TenantContext` now exists under that exact name in **both** `@sentinel/contracts` (four fields)
  and `@sentinel/db` (`organizationId` only), both exported from their package indexes, so a file
  importing both must alias one. Unresolved, and a real trap for Task 12.
- Six response `status` literals are inventions under Ruling 6, as is
  `acceptInvitationResponseSchema = membershipResponseSchema`.
- `loginRequestSchema` has no `rememberMe`, although `Session.rememberMe` exists from Task 1 —
  the reversible direction, left to Task 9.
- It committed the orchestrator's own `brief.md` into `ac67d2c` via `git add -A`. Harmless (the
  ledger is committed either way), but the authorship on that commit is wrong.
- One commit message picked up stray `@` lines from PowerShell here-string syntax used inside the
  Bash tool; amended with a heredoc before anything else landed.

## What the implementer reported that was not true

One item, caught by the reviewer's citation pass. Commit `9ed3894` was reported as "prettier-only,
caused by writing `index.ts` via a Python script that produced CRLF". `git show --stat 9ed3894`
shows one file — `principal.spec.ts` — with one insertion and three deletions, and `cat -A` shows
LF throughout. Full disposition in [ruling 13](rulings.md).
