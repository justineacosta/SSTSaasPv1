# Task 5 Report: `packages/contracts`

## What was implemented

Created `packages/contracts` — the shared Zod-schema package (the "spine") with zero
dependencies besides `zod`, and no imports from any app or from `packages/db`:

- `src/error-codes.ts` — `ERROR_CODES` const object (39 codes, api/errors.md §3),
  `ErrorCode` type, `ERROR_CODE_VALUES` tuple for `z.enum`.
- `src/error-envelope.ts` — `fieldErrorSchema`, `errorEnvelopeSchema`, `FieldError`,
  `ErrorEnvelope` types.
- `src/pagination.ts` — `paginationSchema`, `collectionMetaSchema`,
  `collectionEnvelopeSchema<TItem>()` generic wrapper, `Pagination` type.
- `src/ids.ts` — `idSchema(prefix)` factory (Crockford-base32 26-char body) plus
  `organizationIdSchema`, `userIdSchema`, `membershipIdSchema`, `invitationIdSchema`.
- `src/permissions.ts` — `SYSTEM_ROLES` (7 roles), `PERMISSIONS` (49 permission
  strings), `PROJECT_SCOPED_PERMISSIONS` (9 `P`-cell permissions), `ROLE_PERMISSIONS`
  (the full 7×49 matrix). 191 lines — the longest file in the package, as the brief
  anticipated for a pure data table; flagging per the task's "say so" instruction
  rather than splitting it unilaterally.
- `src/index.ts` — barrel re-exporting everything above, verbatim from the brief.
- `src/error-envelope.spec.ts`, `src/permissions.spec.ts` — transcribed verbatim from
  the brief.
- `package.json`, `tsconfig.json`, `tsconfig.build.json` — copied the
  `packages/observability` shape (which itself matches `packages/config`'s
  tsconfig/tsconfig.build split), since Tasks 1–4 established that split as the
  current convention over what the brief predates.

All export names, error-code strings, and permission strings are verbatim from the
brief — no invention.

## TDD evidence

**RED** — `pnpm vitest run --project unit packages/contracts` after writing only the
two spec files (package.json/tsconfig added first so the workspace package resolves,
but no `src/*.ts` implementation files yet):

```
FAIL  unit  packages/contracts/src/error-envelope.spec.ts
Error: Cannot find module './error-codes.js' imported from
'.../packages/contracts/src/error-envelope.spec.ts'

FAIL  unit  packages/contracts/src/permissions.spec.ts
Error: Cannot find module './permissions.js' imported from
'.../packages/contracts/src/permissions.spec.ts'

Test Files  2 failed (2)
     Tests  no tests
```

Failed for the expected reason: implementation modules did not exist yet, not a schema
or assertion failure.

**GREEN** — after implementing all `src/*.ts` files:

```
✓ unit  packages/contracts/src/permissions.spec.ts (8 tests) 9ms
✓ unit  packages/contracts/src/error-envelope.spec.ts (6 tests) 7ms

Test Files  2 passed (2)
     Tests  14 passed (14)
```

(The brief's step 4 says "12 tests" — the two spec files as given verbatim in the
brief actually contain 14 `it()` blocks: 6 in error-envelope.spec.ts, 8 in
permissions.spec.ts. Reporting the real count rather than the brief's estimate.)

## Flipped-cell mutation transcript

Per the task's required self-check: temporarily added `'finding.accept_risk'` to
`ROLE_PERMISSIONS.MEMBER` (a cell the document marks `-`), re-ran the suite, then
reverted.

**Mutated** (`MEMBER` gains `finding.accept_risk`):
```
❯ unit  packages/contracts/src/permissions.spec.ts (8 tests | 2 failed)
  × permissions.ts agrees with product/permissions.md > grants exactly what each row of the document grants
    → MEMBER / finding.accept_risk (doc cell "-"): expected true to be false
  × invariants from permissions.md > withholds finding.accept_risk and scan.create_aggressive from MEMBER
    → expected [ 'organization.read', …(23) ] to not include 'finding.accept_risk'

Test Files  1 failed | 1 passed (2)
     Tests  2 failed | 12 passed (14)
```

The failure names the exact cell: `MEMBER / finding.accept_risk (doc cell "-")`. The
matrix test can detect a wrong cell — it does not rubber-stamp the 343 cells it
checks.

**Reverted**, re-ran:
```
✓ unit  packages/contracts/src/permissions.spec.ts (8 tests) 12ms
✓ unit  packages/contracts/src/error-envelope.spec.ts (6 tests) 6ms

Test Files  2 passed (2)
     Tests  14 passed (14)
```

Confirmed clean (`git diff packages/contracts/src/permissions.ts` empty after revert).

### What change would make each test fail (traced, not all executed)

- `errorEnvelopeSchema` "accepts a minimal envelope" — fails if `code`/`message`/
  `requestId` were removed, renamed, or mistyped.
- "accepts a validation envelope with per-field errors" — fails if `details` were
  removed or typed as something incompatible with a nested `fields` array.
- "rejects an unknown error code" — fails if `code` used `z.string()` instead of
  `z.enum(ERROR_CODE_VALUES)` (verified this is exactly what makes it meaningful —
  an open string would accept `'MADE_UP'`).
- "rejects an envelope without a requestId" — fails if `requestId` were made
  `.optional()`.
- `collectionEnvelopeSchema` "wraps items with pagination and meta" — fails if
  `data`/`pagination`/`meta` shape changed or `meta` became required.
- "allows a null cursor" — fails if `nextCursor` lost `.nullable()`.
- Permission-matrix tests — executed the actual mutation above for the highest-value
  case (a wrong-but-plausible grant on a role's optional-looking permission).

## Root verification commands (real output)

```
$ pnpm lint
Tasks:    5 successful, 5 total
Cached:    4 cached, 5 total

$ pnpm typecheck
Tasks:    5 successful, 5 total
Cached:    4 cached, 5 total

$ pnpm test
✓ unit  packages/observability/src/redaction.spec.ts (13 tests)
✓ unit  packages/db/src/id.spec.ts (9 tests)
✓ unit  packages/contracts/src/permissions.spec.ts (8 tests)
✓ unit  packages/config/src/env.spec.ts (8 tests)
✓ unit  packages/contracts/src/error-envelope.spec.ts (6 tests)
✓ unit  packages/observability/src/logger.spec.ts (30 tests)
Test Files  6 passed (6)
     Tests  74 passed (74)

$ pnpm build
Tasks:    4 successful, 4 total
Cached:    3 cached, 4 total
```

All four exit 0.

## Files changed

- `packages/contracts/package.json` (new)
- `packages/contracts/tsconfig.json` (new)
- `packages/contracts/tsconfig.build.json` (new)
- `packages/contracts/src/error-codes.ts` (new)
- `packages/contracts/src/error-envelope.ts` (new)
- `packages/contracts/src/error-envelope.spec.ts` (new)
- `packages/contracts/src/pagination.ts` (new)
- `packages/contracts/src/ids.ts` (new)
- `packages/contracts/src/permissions.ts` (new)
- `packages/contracts/src/permissions.spec.ts` (new)
- `packages/contracts/src/index.ts` (new)
- `pnpm-lock.yaml` (updated by `pnpm install` to link the new workspace package)

Commit: `0990cbb feat(contracts): error envelope, pagination, IDs, and the permission
matrix`

## Document vs. brief transcription disagreements

None found. I manually cross-checked the brief's `permissions.ts` transcription
against `.claude/product/permissions.md` cell by cell — all 7 roles × 49 permissions,
plus the 9 `P`-cell permissions for `PROJECT_SCOPED_PERMISSIONS` — before writing the
file, specifically re-verifying the four called-out "deliberate oddities" (bolded
cells in the doc: `AUDITOR` evidence.read `-`, `AUDITOR` audit.read `Y`; plus the
`MEMBER` and `billing.manage` invariants). Every cell matched on first transcription.
The test suite (14/14, including the mutation check) confirms this independently.

## Self-review findings

- No `any`, no `console.*` in `packages/contracts/src` (grepped to confirm).
- Types are all `z.infer`-derived; no hand-written interfaces alongside schemas.
- Package has exactly one dependency (`zod`) and imports nothing from an app or from
  `packages/db`.
- `dist/`, `node_modules/`, `.turbo/` correctly excluded from the commit (workspace
  `.gitignore` already covers these patterns; confirmed via `git status --ignored`).
- `permissions.ts` is 191 lines — under the ~300-line guidance, so no need to flag a
  split, but noting it as the largest file in the package as instructed.

## Concerns

- The brief's Step 4 states "Expected: PASS, 12 tests" but the verbatim spec files it
  supplies contain 14 tests. Not a defect — flagging so it isn't read as a
  discrepancy in my work if the reviewer counts against the brief's stated number.
- None of substance otherwise. Downstream tasks (7, 9, 11) can import `PERMISSIONS`,
  `ROLE_PERMISSIONS`, `SYSTEM_ROLES`, `ERROR_CODES`, `errorEnvelopeSchema`, and
  `Permission` exactly as named in the brief's interface contract.
