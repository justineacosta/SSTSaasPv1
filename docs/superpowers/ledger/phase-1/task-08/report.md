# Task 8 report — `packages/storage`: S3-compatible object storage adapter

## What was implemented

A new workspace package `@sentinel/storage` at `packages/storage`, providing:

- `packages/storage/src/keys.ts` — `tenantPrefix`, `evidenceKeyForFinding`, `evidenceKeyForScan`,
  `reportKey`. All key builders route through `tenantPrefix`, which throws on an empty
  organisation id rather than returning a prefix-less key. Original filenames are never used to
  build a key (only accepted as an unused-for-keys optional field, kept for interface parity with
  the brief). Extensions are validated against `^[a-z0-9]{1,10}$/i` before use. Keys embed a fresh
  `randomUUID()` per call, so they are not enumerable.
- `packages/storage/src/adapter.ts` — the `StorageAdapter` interface (`put`, `get`, `head`,
  `delete`, `presignGet`, `presignPut`, `list`) plus `StoredObjectMetadata`, `PutOptions`,
  `PresignGetOptions`, `KeyPage`. No AWS SDK type appears in this file.
- `packages/storage/src/s3-adapter.ts` — `createS3StorageAdapter(options: S3StorageOptions)`,
  the only file that imports `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner`. SHA-256 is
  computed at `put()` time and stored as object metadata; `head()` returns `null` only for a
  404 and rethrows everything else (403 included); `presignGet` always sets
  `ResponseContentDisposition: attachment` and both presign methods clamp `ttlSeconds` to
  `MAX_PRESIGN_TTL_SECONDS = 300` via `Math.min`.
- `packages/storage/src/index.ts` — barrel export, following `packages/contracts`'s style
  (named type-only exports split from value exports).
- `packages/storage/package.json`, `tsconfig.json`, `tsconfig.build.json` — built from the
  `packages/contracts` template (spec-inclusive `tsconfig.json` for typecheck/ESLint's project
  service, spec-excluding `tsconfig.build.json` as the sole emitter). Dependencies:
  `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (runtime); `testcontainers`,
  `typescript` (dev — `testcontainers` was previously only a transitive dependency via
  `@testcontainers/postgresql`, so it's now a direct devDependency here for `GenericContainer`).
- Tests: `packages/storage/src/keys.spec.ts` (unit, 8 tests) and
  `packages/storage/src/s3-adapter.integration.spec.ts` (integration, 7 tests, against MinIO in
  Testcontainers — a fresh container per test file, independent of the shared Compose stack).

All four source files and both test files were written **verbatim** from the brief, with one
necessary deviation described below.

### One deviation from the brief's verbatim source

The brief's `head()` implementation:

```ts
return {
  size: response.ContentLength ?? 0,
  contentType: response.ContentType,
  etag: response.ETag ?? '',
  sha256: response.Metadata?.sha256,
  lastModified: response.LastModified,
};
```

fails `tsc` under this repo's `exactOptionalPropertyTypes: true` (a flag the brief predates —
Tasks 1–7 established the four extra strict flags in `tsconfig.base.json`): assigning
`contentType: undefined` to an optional `contentType?: string` field is rejected outright under
that flag. Fixed by building the object with conditional spreads so an absent SDK value is
never assigned, only omitted:

```ts
return {
  size: response.ContentLength ?? 0,
  etag: response.ETag ?? '',
  ...(response.ContentType === undefined ? {} : { contentType: response.ContentType }),
  ...(response.Metadata?.sha256 === undefined ? {} : { sha256: response.Metadata.sha256 }),
  ...(response.LastModified === undefined ? {} : { lastModified: response.LastModified }),
};
```

Behaviourally identical (a key that would have held `undefined` is simply absent instead, which
is what `exactOptionalPropertyTypes` requires and what the interface documents). Everything else
in `s3-adapter.ts`, `adapter.ts`, and `keys.ts` matches the brief exactly.

## TDD evidence

### RED — `keys.spec.ts` written before `keys.ts` existed

Command: `pnpm vitest run --project unit packages/storage`

```
FAIL  unit  packages/storage/src/keys.spec.ts [ packages/storage/src/keys.spec.ts ]
Error: Cannot find module './keys.js' imported from
'E:/GitHub/SSTSaasPv1/packages/storage/src/keys.spec.ts'
Caused by: Error: Failed to load url ./keys.js (resolved id: ./keys.js) ...
Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

Expected and correct: `keys.ts` did not exist yet.

### GREEN — after implementing `keys.ts`

```
✓ unit  packages/storage/src/keys.spec.ts (8 tests) 5ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### GREEN — integration suite after implementing `adapter.ts` / `s3-adapter.ts` / `index.ts`

Docker was confirmed running (`docker info`) before this run. Command:
`pnpm vitest run --project integration packages/storage`

```
✓ integration  packages/storage/src/s3-adapter.integration.spec.ts (7 tests) 2799ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

All 7 tests ran against a real MinIO container started per-file by Testcontainers (not the
shared Compose MinIO), confirming the package is self-contained.

## Control-removal drills (mutation testing my own controls)

Each drill: mutate implementation → confirm the expected test fails for the stated reason → git
diff back to committed content → confirm green again. `.bak` copies were used and removed after
each restore; `git status` was clean before committing.

### Drill 1 — `tenantPrefix` returns a prefix-less key for an empty organisation id

Mutation (`keys.ts`):
```ts
export function tenantPrefix(organizationId: string): string {
  return `org/${organizationId}`;   // guard clause removed
}
```

`pnpm vitest run --project unit packages/storage`:
```
× storage keys > rejects an empty organisation id rather than building a prefix-less key
  → expected [Function] to throw an error
Tests  1 failed | 7 passed (8)
```
**Caught.** Restored; unit suite back to 8/8 green.

### Drill 2 — original filename let into the key

Mutation (`keys.ts`, `evidenceKeyForFinding`):
```ts
return `${prefix}/finding/${options.findingId}/${options.originalFilename ?? randomUUID()}.${safeExtension(options.extension)}`;
```

`pnpm vitest run --project unit packages/storage`:
```
× storage keys > never reuses the original filename
  → expected 'org/org_01J/finding/fnd_01J/../../etc…' not to contain 'passwd'
Tests  1 failed | 7 passed (8)
```
**Caught.** Restored; unit suite back to 8/8 green.

### Drill 3 — `presignGet` changed to `inline` disposition

Mutation (`s3-adapter.ts`):
```ts
ResponseContentDisposition: `inline; filename="${filename}"`,
```

`pnpm vitest run --project integration packages/storage`:
```
× S3 storage adapter against MinIO > issues a presigned GET that forces attachment disposition
  → expected '...response-content-disposition=inline...' to contain
    'attachment; filename="evidence.txt"'
Tests  1 failed | 6 passed (7)
```
**Caught.** Restored; integration suite back to 7/7 green.

### Drill 4 — TTL clamp removed

Mutation (`s3-adapter.ts`, `presignGet`):
```ts
{ expiresIn: presignOptions.ttlSeconds },   // Math.min(..., MAX_PRESIGN_TTL_SECONDS) removed
```

`pnpm vitest run --project integration packages/storage`:
```
× S3 storage adapter against MinIO > clamps a too-long presign TTL to five minutes
  → expected '...X-Amz-Expires=86400...' to contain 'X-Amz-Expires=300'
Tests  1 failed | 6 passed (7)
```
**Caught.** Restored; integration suite back to 7/7 green.

### Drill 5 — `head()` swallows a 403 as `null` (checking for coverage)

Mutation (`s3-adapter.ts`):
```ts
if (status === 404 || status === 403) return null;
```

Ran both suites: `pnpm vitest run --project unit packages/storage` → 8/8 passed.
`pnpm vitest run --project integration packages/storage` → 7/7 passed.

**Not caught. This gap is real.** Neither the brief's unit tests nor its 7 MinIO integration
tests exercise a 403 response from `head()` — MinIO's anonymous/authenticated setup in the test
never produces one, since the test credentials always have full access to the bucket they
created. The rethrow-on-non-404 behaviour is implemented correctly and matches the code comment
and `.claude/architecture/storage.md` §... intent, but if a future refactor accidentally widened
the `if (status === 404)` condition, no test in this package would notice. I did not add a new
test for this because the task instructed using the brief's two test files verbatim; flagging it
here per the task's own instruction ("is that even covered? If not, say so").

Restored; both suites green again (confirmed by the final full verification run below).

## Root command output (final, post-drills)

**`pnpm lint`**
```
Tasks:    7 successful, 7 total
Cached:    7 cached, 7 total
  Time:    21ms >>> FULL TURBO
```

**`pnpm typecheck`**
```
Tasks:    7 successful, 7 total
Cached:    7 cached, 7 total
  Time:    24ms >>> FULL TURBO
```

**`pnpm test`**
```
✓ unit  packages/contracts/src/permissions.spec.ts (8 tests)
✓ unit  packages/storage/src/keys.spec.ts (8 tests)
✓ unit  packages/db/src/tenant-scope.spec.ts (26 tests)
✓ unit  packages/observability/src/redaction.spec.ts (13 tests)
✓ unit  packages/observability/src/logger.spec.ts (30 tests)
✓ unit  packages/contracts/src/error-envelope.spec.ts (6 tests)
✓ unit  packages/db/src/id.spec.ts (9 tests)
✓ unit  packages/config/src/env.spec.ts (8 tests)

 Test Files  8 passed (8)
      Tests  108 passed (108)
```

**`pnpm test:integration`** (Docker confirmed running; `docker info` succeeded before the run)
```
✓ integration  packages/storage/src/s3-adapter.integration.spec.ts (7 tests) 4657ms
✓ integration  packages/db/src/migration.integration.spec.ts (4 tests) 13537ms
✓ integration  packages/db/src/rls.integration.spec.ts (9 tests) 13818ms
✓ integration  packages/db/src/tenant-transaction.integration.spec.ts (17 tests) 14034ms
✓ integration  packages/db/src/tenant-client.integration.spec.ts (19 tests) 14845ms
✓ integration  packages/db/src/seed.integration.spec.ts (4 tests) 15709ms

 Test Files  6 passed (6)
      Tests  60 passed (60)
```

**`pnpm build`**
```
Tasks:    5 successful, 5 total
Cached:    5 cached, 5 total
  Time:    26ms >>> FULL TURBO
```

No `cpu-features` MSVC build issue was observed — `pnpm install` exited 0 and Testcontainers
(both the existing Postgres harness and the new MinIO container) worked normally throughout.

## Files changed

Created:
- `packages/storage/package.json`
- `packages/storage/tsconfig.json`
- `packages/storage/tsconfig.build.json`
- `packages/storage/src/adapter.ts`
- `packages/storage/src/keys.ts`
- `packages/storage/src/s3-adapter.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/keys.spec.ts`
- `packages/storage/src/s3-adapter.integration.spec.ts`

Modified:
- `.claude/development/folder-structure.md`
- `.claude/architecture/overview.md`
- `pnpm-lock.yaml` (new dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
  `testcontainers` as a direct devDependency of `packages/storage`)

## Exact wording used in the two `.claude/` document corrections

`.claude/development/folder-structure.md` — added to the `packages/` tree block, in the same
list position the brief specified (between `observability/` and `config/`):

```
│   ├── storage/                 S3-compatible adapter, tenant-prefixed keys
```

Added under **Rules**, as its own paragraph after the existing "Engines are plugins" rule
(verified current wording of that final rule first — matched the brief, no other rules had
drifted):

```
**The storage adapter is a package, not API infrastructure.** Workers upload evidence from
Phase 5 onward, and no app may import another app, so the adapter has to live where both
can reach it.
```

`.claude/architecture/overview.md` §3 — added to the `packages/` block, between `observability/`
and `config/` (matching the brief's ordering, and verified the surrounding lines were unchanged
from the brief's assumption):

```
  storage/          S3-compatible adapter, tenant-prefixed key construction
```

I did not touch the `apps/api/.../infrastructure/  prisma, redis, queue, storage, mail, stripe`
line in `folder-structure.md`, since the brief's Step 7 specified only these two additions and
did not ask for that line to change. It's plausible `apps/api/src/infrastructure/storage` still
holds thin NestJS wiring (a provider constructing `createS3StorageAdapter` from config) even
though the adapter's implementation now lives in `packages/storage` — noting this only in case a
reviewer wants that line reconciled too.

## Self-review findings

- The `exactOptionalPropertyTypes` fix in `head()` (documented above) is the only place I
  deviated from the brief's literal source. It's a mechanical, behaviour-preserving change
  forced by this repo's stricter tsconfig, not a design decision.
- Drill 5 above is a genuine, currently-unaddressed test gap: `head()`'s 403-vs-404 distinction
  has no regression test. I did not fix it by adding a test, per the "use exact test files
  verbatim" instruction — flagging for the reviewer/next task instead.
- `packages/storage/src/index.ts` is new (not dictated verbatim by the brief, since it wasn't
  shown in the code blocks) — I followed `packages/contracts/src/index.ts`'s export style
  (named type-only exports separated from value exports) for consistency.
- Checked file sizes: all six source files are between 45 and 146 lines, comfortably under the
  ~300-line constraint.
- Confirmed no `console.log`, no `any`, no bare `process.env` access anywhere in
  `packages/storage/src`.
- Confirmed no AWS SDK type is exported from `adapter.ts` or `index.ts` — `S3StorageOptions` in
  `s3-adapter.ts` only uses primitive types (strings, booleans), and the SDK's request/response
  types never appear outside `s3-adapter.ts`.

## Concerns

1. **Drill 5 gap (403-vs-404 in `head()`)** — real, not covered by any test in this package.
   Worth a follow-up test (`head()` on a bucket the credentials can reach but the key is denied
   by policy, or a mocked/adjusted MinIO policy) in a later task if evidence-serving security is
   revisited, since this is exactly the "hardest bug to find" class the brief calls out.
2. The `apps/api/.../infrastructure/  ... storage ...` line in `folder-structure.md` was left
   unchanged (see wording section above) — flagging in case the intent was to remove `storage`
   from that list entirely rather than just add the package line elsewhere.

Everything else: no blockers, no open questions.

---

## Addendum — follow-up round (coordinator-requested)

The coordinator asked for two fixes before review: cover the `head()` 403 case with a real test
(rather than leaving it as a reported gap), and reconcile `folder-structure.md` so the storage
adapter is listed in one place, not two.

### 1. `head()` 403 case — now covered, integration test

Chose the **integration** route (second adapter with deliberately wrong credentials against the
same MinIO container), as the coordinator's preferred option, rather than the unit-test
substitute. Before writing the assertion I verified MinIO's actual behaviour with a throwaway
probe script (run from inside `packages/storage` so its dependencies resolved, then deleted):
a `HeadObjectCommand` sent with a wrong secret key against an object that *does* exist returned

```
status: 403 name: Unknown message: UnknownError
```

confirming MinIO rejects the signature before ever consulting the key — exactly the "permissions
problem, not a missing object" case `head()` must not swallow as `null`. That confirms the new
test genuinely exercises the 403 branch and not just "any thrown error."

Added to `packages/storage/src/s3-adapter.integration.spec.ts`:
- Hoisted `endpoint` from a `beforeAll`-local `const` to a module-level `let` so a second adapter
  can be built against the same running container from within a test.
- New test, `'rethrows rather than returning null when the request is rejected (not absent)'`:
  builds a second `StorageAdapter` via `createS3StorageAdapter` pointed at the same `endpoint`
  with `secretAccessKey: 'wrong_secret_key'`, then asserts `rejectedStorage.head(BUCKET,
  objectKey)` on a key that **does** exist rejects rather than resolving to `null`.

Integration suite is now 8 tests (was 7): `pnpm vitest run --project integration
packages/storage` → `8 tests | 8 passed`.

### Drill — head() swallows any error (not just 404) as null

Mutation (`s3-adapter.ts`, the `catch` block in `head()`):
```ts
if (status === 404) return null;
return null;   // was: throw error;
```

`pnpm vitest run --project integration packages/storage`:
```
× S3 storage adapter against MinIO > rethrows rather than returning null when the request is
  rejected (not absent)
  → promise resolved "null" instead of rejecting
Tests  1 failed | 7 passed (8)
```
**Caught.** Restored (`git diff` confirmed byte-identical to the committed `s3-adapter.ts` after
restore); re-ran the full integration suite for `packages/storage` → `8 tests | 8 passed`.

The previously-reported gap is closed: `head()`'s "only a genuine 404 returns null, everything
else rethrows" contract now has a regression test, and that test was itself confirmed to fail
when the contract is violated.

### 2. `folder-structure.md` reconciled

Removed `storage` from the `apps/api/src/infrastructure/` line so the document names the adapter
in exactly one place (`packages/storage/`), per "stale documentation is a defect."

Before:
```
│   │       ├── infrastructure/  prisma, redis, queue, storage, mail, stripe
```

After:
```
│   │       ├── infrastructure/  prisma, redis, queue, mail, stripe
```

The `packages/` tree line added earlier in this task (`storage/  S3-compatible adapter,
tenant-prefixed keys`) and the new **Rules** paragraph are unchanged — this was the only other
edit needed.

### Root commands, re-run after both fixes

**`pnpm lint`** — `Tasks: 7 successful, 7 total`
**`pnpm typecheck`** — `Tasks: 7 successful, 7 total`
**`pnpm test`** — `Test Files 8 passed (8)` / `Tests 108 passed (108)` (unchanged — the new test
is integration-only)
**`pnpm build`** — `Tasks: 5 successful, 5 total`
**`pnpm test:integration`** — `Test Files 6 passed (6)` / `Tests 61 passed (61)` (was 60; the new
`packages/storage` test brings its file to 8, workspace integration total to 61)

### Files changed in this round

- `packages/storage/src/s3-adapter.integration.spec.ts` — hoisted `endpoint`, added the 403
  rejection test.
- `.claude/development/folder-structure.md` — removed `storage` from the `apps/api/.../
  infrastructure/` line.

No other files touched in this round.


---

## Addendum 2 — review round (two fixes requested, plus a mid-round self-correction)

Review verdict on the prior state: spec approved, quality approved, no Critical/Important
findings. The reviewer independently attacked the key builders against real MinIO (unicode and
`../` org ids, null-byte/path-separator extensions, header-injection attempts in
`downloadFilename`, 1000-iteration collision checks) and fetched real presigned URLs to read the
actual `X-Amz-Expires` rather than trusting the code path. It reproduced the 403 drill and added
two of its own (dropping the prefix from `reportKey`, hashing the wrong bytes in `put`) — both
caught. Two things remained before close.

### 1. `.claude/architecture/storage.md` was stale relative to what shipped

Section 4 still documented `put(key, body, opts)`, `head(key)`, `presignPut(key, ttl, opts)` — no
`bucket` argument — and the status banner still read "Designed. Not Implemented."

Fixed:
- Status banner now reads **"Adapter Implemented (Phase 1)."**, with evidence (Phase 5) and
  reports (Phase 8) explicitly still not built ("nothing calls this adapter in application
  code").
- Section 4's interface block now shows every method's actual, shipped signature — `bucket` first
  throughout, `put` returning `sha256` too, `head` returning `StoredObjectMetadata | null`,
  `presignGet`'s options object spelled out, `list`'s optional `cursor`.
- Added: which package it lives in and why (`packages/storage`, not
  `apps/api/src/infrastructure`, linking to `folder-structure.md`'s Rules); that every method
  takes the bucket explicitly because one adapter instance serves all four buckets; that
  `S3StorageOptions` is plain strings/booleans so no AWS SDK type crosses the boundary; that the
  four key builders in the same package are the only way to construct a key, and `tenantPrefix`
  throws rather than returning a prefix-less one.
- Kept the "Not in Phase 1" items (lifecycle rules, cross-region replication, the reconciliation
  job in sections 5 and 7) exactly as they were — still honestly listed as outstanding.

Diff summary (`.claude/architecture/storage.md`, 40 lines changed): status banner rewritten;
interface block's seven method signatures all corrected to take `bucket` first, matching the
shipped code; new prose on the package location, the per-call bucket rationale, the SDK-type-free
boundary, and the key builders.

### 2. CR/LF (and NUL) stripped from downloadFilename — defence in depth

MinIO's Go HTTP stack collapses raw CR/LF before emitting the response, so the old
`.replaceAll('"', '')` was not exploitable *today* — but that safety lived in the server's HTTP
implementation, not the adapter's. A different S3-compatible provider need not behave the same.

Changed `packages/storage/src/s3-adapter.ts`'s `presignGet` to strip the quote character (as
before) plus every C0 control character and DEL (hex 00 through 1f, and 7f) — CR and LF included
— in the same expression, using the regex character class `["\x00-\x1f\x7f]`, so header splitting
can no longer depend on the server's tolerance for raw control bytes. The `eslint-disable-next-line
no-control-regex` directive sits on the single line directly above the line containing the regex
literal, with the justification inline after `--` on that same line.

A mid-round self-correction on the disable-directive placement itself is worth recording, since
this exact class of mistake is what triggered this whole addendum. My first attempt at this fix
put the `eslint-disable-next-line` comment two lines above the regex, with a second explanatory
comment line in between — which, as the coordinator's diagnosis explained for the original bug,
disables nothing, because the directive only covers the line immediately below it. `pnpm lint`
caught it immediately, reporting both an "Unexpected control character(s)" error on the regex
line and an "Unused eslint-disable directive" warning on the directive's own line. Fixed by
moving all explanatory prose to the block comment above `const filename = ...` and leaving the
directive as the single line immediately preceding the regex literal. Re-ran `pnpm lint`: clean.

### New test: CR/LF/NUL header-injection attempt

Added to `packages/storage/src/s3-adapter.integration.spec.ts`, a test that calls `presignGet`
with `downloadFilename: 'evil\r\nX-Injected: 1\r\n\x00'` and decodes the resulting URL, then
asserts two things: (1) no raw CR, LF, or NUL character survives anywhere in the signed URL —
proof the disposition value cannot span more than one line; (2) the decoded URL contains the
exact string `attachment; filename="evilX-Injected: 1"` — the attempted second header folded into
inert text inside the single filename attribute, rather than merely asserting the injected
substring is absent (which would also pass if stripping had over-deleted legitimate characters).

This test's own `/[\r\n\x00]/` assertion regex needed the same disable-directive treatment —
`no-control-regex` fires in spec files too, since the eslint config's spec-file exemptions cover
`no-restricted-imports`, `no-non-null-assertion`, and `no-restricted-properties` only, not this
rule. Placed correctly on the first attempt this time (directive as the line immediately above
the `expect(...).not.toMatch(...)` line that contains the regex).

### RED — reverted the fix, confirmed the new test fails

Reverted `presignGet`'s sanitiser to the old `.replaceAll('"', '')` (backed up first, restored
after). Running the integration suite for `packages/storage` produced:

```
x S3 storage adapter against MinIO > strips CR/LF and NUL from downloadFilename so the
  disposition stays a single line
  -> expected '...' not to match /[\r\n\x00]/

+ Received:
"http://localhost:33052/evidence/org/org_01J/finding/fnd_01J/....txt?...
&response-content-disposition=attachment; filename=\"evil
X-Injected: 1
 \"&x-amz-checksum-mode=ENABLED&x-id=GetObject"

Tests  1 failed | 8 passed (9)
```

The raw output makes the vulnerability visible directly: `X-Injected: 1` lands on its own line
inside the decoded URL — precisely the header-splitting outcome the fix prevents. Confirms the
test is not decoration: it fails for the exact reason it exists.

### GREEN — restored the fix, full suite passes

Restored `s3-adapter.ts` from the backup (`git diff` before committing showed only the intended
changes — no leftover backup files). Re-ran the integration suite for `packages/storage`: 9 of 9
tests passed.

### Root commands, re-run after both fixes and the disable-directive correction

**`pnpm lint`** — 7 of 7 tasks successful (clean; no unused-directive warning, no control-regex
error)
**`pnpm typecheck`** — 7 of 7 tasks successful
**`pnpm test`** — 8 of 8 test files passed, 108 of 108 tests passed (unchanged — both new tests
are integration-only)
**`pnpm build`** — 5 of 5 tasks successful
**`pnpm test:integration`** — 6 of 6 test files passed, 62 of 62 tests passed (was 61;
`packages/storage`'s file is now 9 tests, workspace integration total 62)

Also ran `pnpm exec prettier --check` on the changed source file as a courtesy (not one of the
five required commands) after noticing the long single-line disable-directive comment risked a
formatting complaint. It flagged the file once; `pnpm exec prettier --write` resolved it with no
content change (prettier does not rewrap comments — the initial warning was stale from an
in-progress edit, not a real width violation).

### Files changed in this round

- `.claude/architecture/storage.md` — section 4 signatures and prose corrected; status banner
  rewritten.
- `packages/storage/src/s3-adapter.ts` — `presignGet`'s filename sanitiser now strips control
  characters in addition to quotes; disable-directive placement fixed.
- `packages/storage/src/s3-adapter.integration.spec.ts` — added the CR/LF/NUL injection test.

### Residual for whole-branch review

None outstanding from Task 8 itself. For the record, per the coordinator's note: self-reporting
4 of 5 drills (then confirming the 403 case in the next round) rather than claiming 5 of 5
surfaced the real gap before review rather than during it. The mid-round disable-directive
mistake in this addendum was caught by `pnpm lint` itself before commit, not by a subsequent
review pass — worth noting only as a reminder that `eslint-disable-next-line` placement is easy
to get wrong when justification prose wants to wrap across lines, and the fix each time is the
same: keep the directive as the single line immediately before the flagged line, with any longer
explanation living outside that adjacency.
