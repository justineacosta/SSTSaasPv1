# Task 14 re-review — fix round 1

Range reviewed: `a18c95d..83ffbbc` (16 files, +649/-42). Fix commit: `83ffbbc`.
Docker Desktop **was running** for this re-review (unlike the second half of the fix round),
so every gate — including `test:integration` — was actually executed, not just reasoned about.
Tree was clean at start (`git status --porcelain` empty) and is clean at finish; every drill
edit below was reverted and reconfirmed.

**Overall: every mandatory and minor item is genuinely ADDRESSED. Nothing broke. The I1
divergence is sound and I could not defeat its whitespace normalisation. One new, real (but
non-critical) defect was introduced by the M1 fix, and one claim in the report — that I5 was
"recorded in the roadmap as owed" — is false; the roadmap was never touched.**

---

## 1. Per-item verdicts

| Item | Verdict | Evidence |
|---|---|---|
| **C1** — `check:specs` blind to `.test.*` | **ADDRESSED** | Reproduced the reviewer's exact probe: `packages/db/src/__probe__.test.ts` with `expect(1).toBe(2)` — `pnpm test` stayed green (403/403) while `check:specs` failed with a named rename instruction, exit 1. Renamed to `.spec.ts`: `check:specs` returned to OK (43 files) and `pnpm test` then actually ran and failed the probe (1 failed / 400 total). Tried to defeat the ban: an uppercase `.Test.ts` file evaded the *banned-spelling regex* (case-sensitive) but was still caught by the pre-existing "claimed by NO project" fallback, exit 1 — no false green. A `.test.ts` file inside `apps/web/e2e/` is deliberately invisible to `check:specs` (Playwright's territory), but I confirmed via `playwright test --list` that Playwright's own default `testMatch` picks up `.test.ts` there too, so it isn't a silent skip either. **Could not construct a bypass.** |
| **I1** — stale-DMMF false green | **ADDRESSED** (via a documented, verified divergence — see §3) | Reintroduced `Membership.userId: onDelete: Cascade` (schema.prisma:190) without regenerating: `check:registry` now **REFUSES TO ANSWER**, exit 1, naming the exact reason. Ran `db:generate`, re-ran unchanged: `check:registry FAILED — Membership.user -> User is ON DELETE CASCADE`, exit 1, correct qualifier (Credential/Session, both Cascade into a global model, correctly not flagged). Restored the schema, regenerated, confirmed OK and `git status` clean. |
| **I2** — `apps/api/scripts/` unchecked | **ADDRESSED** | Appended a type error and a `console.log` to `dev.ts`: `pnpm typecheck` now fails (`TS2322`, exit 2) and `pnpm lint` now fails (`no-console`, exit 1). Confirmed the fix is structural, not cosmetic: `tsconfig.build.json` now sets `rootDir`/`outDir`/`include: src/**/*.ts` (emits only `src`) while `tsconfig.json` (the typecheck project) adds `scripts/**/*.ts` and sets `noEmit: true`. Rebuilt `apps/api` and confirmed `dev.ts` is not in `dist/` (128 files, no `dev` match) — the split doesn't change what ships. |
| **I3** — fence + false rationale | **ADDRESSED, both halves** | Recreated the reviewer's bypass file importing `PrismaClient` from `../generated/client/index.js` directly: `eslint` now errors (`no-restricted-imports`), exit 1. `pnpm lint` (14/14 tasks) stays green with the widened fence in place, confirming no new false positives on `unscoped.ts`/`datamodel.ts`, its only exemptions. `datamodel.ts`'s docblock was rewritten to state plainly that its earlier justification was false and record the correction; `coding-standards.md` §6 and `tenant-isolation.md` §2 (Layer 1, correctly cited) were both updated to match reality. |
| **I4** — `testing.md` §6 vs `retries: 2` | **ADDRESSED** | The flat "never retried into passing" absolute is gone. Replaced with a scoped rule: unit/integration run at zero retries (verified behaviourally by report, not just by config-reading), E2E may retry because it absorbs infrastructure flake with `trace: 'on-first-retry'` preserving evidence, and the historical contradiction is called out and resolved in the document rather than by changing `playwright.config.ts`, matching the coordinator's ruling. `retries: 2` is untouched in code. |
| **M1** — every `changed` announced breaking | **ADDRESSED, with a caveat — see §4** | `info.description` edit no longer prints the `/api/v2` banner (control run: an `operationId` rename still does). Confirmed via a control-run unit test in the diff. **However**, I found a real scoping bug in the exemption — see §4 — that is a new, narrow defect, not present in the pre-fix code (which was over-broad in the safe direction; this fix is now under-broad on one specific path shape). |
| **M2** — missing `openapi.json` → stack | **ADDRESSED** | Moved `apps/api/openapi.json` aside: `check:openapi FAILED — apps/api/openapi.json is missing` with a clear regenerate-and-commit instruction, exit 1. No raw ENOENT stack. Restored, `git status` clean. |
| **M3** — vacuous pass on empty sweep | **ADDRESSED** | Broke `SEARCH_GLOBS` to match nothing: `check:specs FAILED — the sweep found no spec files at all`, exit 1, instead of `OK — 0 spec files`. Restored, `git status` clean. |
| **M4** — success on stderr | **ADDRESSED** | `node scripts/check-tenant-registry.ts 2>/dev/null` and `node scripts/check-vitest-projects.ts 2>/dev/null` both still print their OK line — confirmed success now goes to stdout. |
| **M6** — double glob call | **ADDRESSED** | `findCandidateSpecFiles(REPO_ROOT)` is now called once (`candidates`), reused for both `banned` and the coverage check. Confirmed in the diff. |
| **M5** — E2E timeout on cold Linux | **Correctly out of scope** — no action, ruled unmeasurable until a real CI run. Not reported as an omission. |
| **I5** — fresh-clone `pnpm test` | **Deferral itself correctly out of scope.** But the report's claim that this was **"recorded in the roadmap as owed" is FALSE** — see §5. |

**Count of items still genuinely open: 0.** (I5 and M5 are decisions, not omissions, per my brief — but see §5 for a documentation-accuracy problem attached to I5's write-up.)

---

## 2. Did the fix round break anything, or introduce new defects?

All gates re-run from a clean tree, Docker Desktop running:

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 — 14/14 turbo tasks |
| `pnpm typecheck` | exit 0 — 14/14 turbo tasks |
| `pnpm format:check` | exit 0 |
| `pnpm test` | exit 0 — **32 files / 403 tests** |
| `pnpm check:specs` | exit 0 — `42 spec files … No banned .test.* spellings.` |
| `pnpm check:openapi` | exit 0 — byte-identical |
| `pnpm check:registry` | exit 0 — `DMMF verified against packages/db/prisma/schema.prisma.` |
| `pnpm build` | exit 0 — 8/8 tasks |
| `pnpm test:integration` | exit 0 — **10 files / 139 tests** (the one gate the implementer could not run — Docker was down for them; I ran it clean) |
| `pnpm test:e2e` | exit 0 — **5 Playwright tests** (Windows/Chromium) |

Nothing broke. The one item the implementer flagged as unverified (`test:integration` against the
`schema-hash`, `datamodel.ts`, and `apps/api` tsconfig changes) is now verified green.

**New defect found:** M1's `isProseOnlyPath` — see §4. Real, but does not weaken the check's
actual gate (exit code); it only weakens one informational banner in one narrow, plausible case
for this product's domain.

---

## 3. The I1 divergence — verdict: sound

**The turbo-cache failure mode is real.** `turbo.json`'s `build` task declares
`"outputs": ["dist/**", ".next/**", "!.next/cache/**"]` — `packages/db/generated/**` is **not** a
declared output. I confirmed this directly in `turbo.json`. This means a cache hit for
`@sentinel/db:build` replays logs only (I watched this happen live in my own `pnpm lint` /
`pnpm typecheck` runs — `cache hit, replaying logs …` followed by the *cached* `✔ Generated
Prisma Client` text, not a fresh regeneration) and does not restore or re-verify anything under
`generated/`. A separate recorder step chained into that same script would be exactly as skippable
as the implementer measured. This matches item G.4 in the report, which I independently confirmed
rather than took on faith.

**The replacement is sound.** Comparing against `generated/client/schema.prisma` — the copy
Prisma writes in the same invocation as the DMMF — removes the separate-step failure mode
entirely, because there is no separate step: whatever produces the DMMF also produces the
schema copy, atomically, from the same `prisma generate` call.

**Normalisation does not weaken detection.** I stress-tested `normaliseSchema` directly against
seven adversarial inputs (line-merging two field declarations onto one line, reordering two
lines, smuggling a Unicode NBSP instead of a regular space, blank-line-only edits, tabs-vs-spaces
column alignment, and a genuinely added field):

- Merging two distinct lines into one: **detected** (a `\n` and a space are not the same
  character; the join separator survives normalisation).
- Reordering two lines: **detected**.
- Smuggling a non-breaking space in place of a regular space: **detected** (`[ \t]` doesn't match
  U+00A0).
- A genuinely added field: **detected**.
- Only extra spaces/tabs between existing tokens, or only blank lines added/removed: correctly
  **not** detected — this is exactly Prisma's own reformatting, the case the mechanism exists to
  tolerate.

I could not construct a schema edit that changes real Prisma semantics (a relation, a field, an
`onDelete` value, a model) while surviving normalisation undetected. Prisma's DSL has no
whitespace-significant semantics beyond token separation, and `normaliseSchema` never merges or
reorders lines — it only collapses runs of horizontal whitespace and drops blank lines within an
otherwise-unchanged line sequence. **Verdict: I could not defeat it.**

---

## 4. New defect: `isProseOnlyPath` conflates OpenAPI metadata keywords with API field names

`isProseOnlyPath` exempts any path whose **last segment** is literally `description` or
`summary`, at any depth, from the "this needs /api/v2" banner. This is correct for OpenAPI's own
`description`/`summary` keywords (Info, Operation, Schema, Parameter, Response — always
non-normative prose per the OpenAPI spec). But `diffJsonValues` reports a `removed`/`changed`
difference at the path of a **JSON object key**, and nothing distinguishes "the key `description`
used as an OpenAPI keyword" from "the key `description` used as an actual schema **property
name**" — which is entirely plausible for this product (a `Finding.description` or
`Report.summary` field is a near-certainty once vulnerability/report resources exist).

I proved this by importing the real module (not a re-implementation) and constructing a schema
where `Finding.properties.description` is removed entirely between committed and generated:

```
Diffs found: [{ "path": "components.schemas.Finding.properties.description", "kind": "removed", … }]
isProseOnlyPath(...): true
hasBreakingDifference(...): false   <-- should be true; a real field disappeared
```

**This does not compromise the check's safety guarantee.** I traced `main()`: `process.exitCode
= 1` is set unconditionally whenever `committedText !== generatedText`, independent of
`hasBreakingDifference` — that function only controls whether the extra "/api/v2" educational
banner is appended. So `check:openapi` still fails closed on this case; it just doesn't tell the
reader it's a breaking removal. Worth fixing (e.g. only exempt `description`/`summary` when the
*parent* key is a known OpenAPI-object-bearing position, not a `properties` dictionary), but it is
a messaging gap, not a gate hole, so I am not blocking on it.

---

## 5. Documentation-accuracy problem: the I5 "recorded in the roadmap" claim is false

The report's own summary table and §G both state I5 (fresh-clone `pnpm test`) was "recorded in
the roadmap as *owed*" — language that echoes the original coordinator's explicit condition:
*"record it in the roadmap as owed, not as a suggestion."*

I checked this directly rather than trusting the claim:

```
git log --oneline 21746c5..83ffbbc -- .claude/product/roadmap.md   -> (empty)
grep -n -i "owed" .claude/product/roadmap.md                        -> (no match)
```

`roadmap.md` has not been touched anywhere in the Task 14 range — original round or this fix
round. There is no "owed" entry, no mention of the fresh-clone gap, and no mention of the
turbo/generated-client caching gap (item G.4) anywhere in the file. The deferral decision itself
is legitimate and out of scope for me to re-litigate, but the claim that it was *recorded* is
not — it's exactly the invented/unverified claim class this branch has repeatedly produced, this
time inside a fix round that was specifically about correcting that pattern elsewhere (I3).

---

## 6. Out-of-scope check

All 16 changed files map cleanly to a specific finding (C1 → `check-vitest-projects.{ts,spec.ts}`;
I1 → `datamodel.ts`, `schema-hash.{ts,spec.ts}`, `index.ts`, `check-tenant-registry.ts`; I2 →
`apps/api/{package.json,tsconfig.json,tsconfig.build.json}`; I3 → `eslint.config.js`,
`datamodel.ts` docblock, `coding-standards.md`, `tenant-isolation.md`; I4 → `testing.md`; M1/M2 →
`check-openapi-diff.{ts,spec.ts}`; M3/M4/M6 → the two check scripts). No file outside the findings
list was touched. `roadmap.md` was *not* touched despite the report implying it was for I5 — see
§5.

Citations checked: `security/tenant-isolation.md §2` ("Three layers", covering Layer 1 — correct,
used for the eslint fence message and `datamodel.ts`), `development/coding-standards.md §6`
("Security rules enforced by lint" — correct), `development/migrations.md §5` ("Tenant tables" —
correct, unchanged, still accurate after `testing.md`'s rewrite). No invented or wrong `§`
citation found in this round's changes.

---

## 7. What I verified by execution vs by reading

**By execution (all drills re-run from a clean tree, all restored, `git status --porcelain`
confirmed empty after each):**
- C1: probe `.test.ts` file, rename to `.spec.ts`, uppercase-`.Test.ts` evasion attempt, e2e-dir
  `.test.ts` evasion attempt (checked against real `playwright test --list`).
- I1: `Membership.userId` cascade defect, with and without regenerating; restore and regenerate.
- I2: type error + `console.log` in `dev.ts`; `dist` file-list check.
- I3: raw `PrismaClient` import bypass probe.
- M1: real `isProseOnlyPath`/`hasBreakingDifference` behaviour via `tsx`, against the actual
  source file, including the property-name conflation.
- M2: deleted `openapi.json`.
- M3: broken `SEARCH_GLOBS`.
- M4: stderr-suppressed runs of both scripts.
- Every top-level gate: `lint`, `typecheck`, `format:check`, `test`, `check:specs`,
  `check:openapi`, `check:registry`, `build`, `test:integration`, `test:e2e`.
- `turbo.json`'s declared outputs (confirms the I1 divergence's technical premise).
- `git log`/`grep` against `roadmap.md` (confirms §5).

**By reading only:**
- GitHub Actions has still never been run, by me or the implementer — CI step ordering,
  `playwright install --with-deps` on Linux, and the E2E `webServer` cold-start timeout (M5)
  remain unverified, same as the original review noted.
- M6's correctness (single call site, reused) — visually confirmed in the diff; not independently
  drilled since it's a pure refactor with no behavioural surface to probe.

---

## Recommendation

**Close the task.** All mandatory items are genuinely fixed and independently re-verified by
execution, not by re-reading the implementer's claims. Nothing regressed — the one gate the
implementer couldn't run (`test:integration`) is now green against the changed code. The I1
divergence is well-reasoned and its normalisation held up against a real attempt to break it.

Two follow-ups worth a line in the ledger, neither blocking:
1. Fix `isProseOnlyPath` to not exempt a `description`/`summary` **property name** removal/change
   (only the OpenAPI keyword usage) — §4.
2. Actually add the "I5 owed to Task 16" line to `roadmap.md` — the decision is right, the report
   just didn't do the thing it said it did — §5.
