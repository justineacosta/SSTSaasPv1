# Task 14 review — CI checks: OpenAPI diff, tenant registry completeness, spec coverage

**Reviewer verdicts**

| Question | Verdict |
|---|---|
| **A. Spec compliance** | **Met with two partials** — 11/11 steps attempted, 8 fully met, 3 partially met. Nothing on the out-of-scope list was done. |
| **B. Quality** | **Approved with conditions** — 1 Critical, 5 Important, 6 Minor. The Critical (C1) blocks merge; it is a small fix. |

Range reviewed: `21746c5..a18c95d` (3 commits, 39 files). Tree was clean at start and is clean at
finish (`git status --porcelain` empty, HEAD still `a18c95d`). Docker Desktop **was running**
(server 29.7.2), so `test:integration` and `test:e2e` were both executed.

This is strong work. The FK-cascade rule carries its qualifier correctly, the omitted-`onDelete`
decision is the safe one and I reproduced the measurement behind it, the Prettier commit is
provably behaviour-neutral, and all ten `§` citations are correct — the first clean citation
audit on this branch. The Critical is a single blind spot in one glob, not a design failure.

---

## A. Spec compliance, per brief step

| Step | Verdict | Evidence |
|---|---|---|
| **1** — failing registry test | **Met** | `scripts/check-tenant-registry.spec.ts` contains the brief's seven specified tests **verbatim** (lines 18–34 match the brief character-for-character), plus tests for all five additional rules. 24 `it` blocks. |
| **2** — DMMF-driven check | **Met**, with I1 | `pnpm check:registry` → `OK — 10 models, 3 tenant-owned, 1 tenant root, 6 deliberately global (Prisma client 6.19.3)`, exit 0. Failure messages match the brief's specified text. Caveat: reads a possibly-stale client (I1). |
| **2b** — FK-cascade rule | **Met** | Rule and qualifier both correct; verified by drill (below). The brief's two required measurements were both independently reproduced. |
| **2c** — accounted-for-exactly-once | **Met** | `DELIBERATELY_GLOBAL_MODELS` is a name→reason map with all six required entries, each with a real reason. Both directions (none / more than one) fire — I proved the "more than one" direction, which the implementer did not drill. |
| **3** — OpenAPI diff | **Met** | Real leaf-by-leaf JSON-path diff, readable. Does not dirty the tree on success **or** failure (verified both). Header comment correctly disclaims what `generate.integration.spec.ts` already covers. |
| **4** — spec-project coverage | **Partially met** | Both directions work **for `*.spec.*`**. The class is not closed: `*.test.*` is invisible to the check (**C1**). |
| **5** — prove every check fails | **Partially met** | The ten reported drills are real — I re-ran six of them and they reproduce exactly. But every drill stayed inside spellings the check already handles; the first spelling I invented that it does not handle got straight past it (**C1**). |
| **6** — `eslint-plugin-react-hooks` | **Met** | Verified firing through the *real* gate `pnpm lint`, not just a scoped eslint call. |
| **7** — CI wiring incl. E2E | **Met** (YAML read-only) | All steps present and correctly ordered. Env chain for E2E holds. Read-only concerns in M5. |
| **8** — `format:check` | **Met** | 11 files, gated in CI, exemptions untouched, reformat **proven** behaviour-neutral. |
| **9** — `dev` scripts | **Met** | `pnpm dev:api` observed compiling and booting Nest. |
| **10** — documentation | **Partially met** | All 10 citations correct. But `testing.md` §6 was left in live self-contradiction (**I4**). |
| **11** — verify and commit | **Met** | Every gate re-run by me and green. Commits are in the required logical units. |

**Out-of-scope compliance: clean.** `git diff --name-only 21746c5..a18c95d` touches no
`packages/config/tsconfig/*`, no `roadmap.md`, no `@RequirePermission` enforcement, no Redis
work. The `omit` guard was deferred as the brief permits.

---

## Findings

### CRITICAL

#### C1 — `check:specs` is blind to `*.test.*`, the exact silent-skip class it exists to close

**File:** `scripts/check-vitest-projects.ts:38-42` (`SEARCH_GLOBS`)

`SEARCH_GLOBS` only globs `*.spec.*`. Every Vitest project in `vitest.workspace.ts` overrides
`include` with `.spec.ts` / `.spec.tsx` patterns only (lines 7, 27–30, 62) — Vitest's *default*
include, which covers `{test,spec}`, is discarded. So a `*.test.ts` file matches **no project**
and is simultaneously **invisible to the guard**.

**How I proved it.** Created `packages/db/src/__probe__.test.ts` containing `expect(1).toBe(2)`:

```
=== pnpm test (does it run the failing probe?) ===
 Test Files  31 passed (31)
      Tests  375 passed (375)
TEST_EXIT=0

=== pnpm check:specs (does it catch the silent skip?) ===
check:specs OK — 41 spec files, each claimed by exactly one of: unit, integration, ui.
SPECS_EXIT=0
```

A test asserting `1 === 2` sat in the tree and **both** the suite and the guard reported green.
This is the Task 12 trap, reproduced end to end, in the guard built to end it.

**Why this is Critical, not Important.** `.test.ts` is at minimum as common a JavaScript
convention as `.spec.ts` — it is the default a contributor reaches for. The check's own docblock
(lines 1–12), `testing.md` §6, `setup.md` and `CLAUDE.md` all now advertise that spec coverage is
mechanically guaranteed. The brief's standard applies exactly: *a check that is wrong in the
direction of green is worse than no check, because it manufactures confidence.*

**What should change.** Widen `SEARCH_GLOBS` to `*.{spec,test}.*`. Note that this will
immediately make `check:specs` **fail** on any `.test.*` file, which is the correct loud outcome —
it forces an explicit decision: either the Vitest projects claim `.test.*` too, or the repo bans
the spelling. Either is fine; silence is not. Add a regression test to
`check-vitest-projects.spec.ts` pinning the candidate glob against a `.test.ts` fixture.

---

### IMPORTANT

#### I1 — `check:registry` silently reads a stale Prisma client

**File:** `packages/db/src/datamodel.ts:22` → `scripts/check-tenant-registry.ts:365`

`datamodelModels()` reads `Prisma.dmmf` from `packages/db/generated/client`. Nothing ties that
artefact to the current `schema.prisma`. Edit the schema without regenerating and the check
answers from yesterday's DMMF, with no warning.

**How I proved it.** Reintroduced the exact live defect Task 6 found — `Membership.userId` back to
`onDelete: Cascade` (`schema.prisma:190`) — and ran the check **without** regenerating:

```
=== check:registry WITHOUT prisma generate (stale DMMF test) ===
check:registry OK — 10 models, 3 tenant-owned, 1 tenant root, 6 deliberately global (Prisma client 6.19.3).
EXIT=0
```

Then `pnpm --filter @sentinel/db db:generate` and re-ran, changing nothing else:

```
check:registry FAILED — 1 problem(s).
Membership.user -> User is ON DELETE CASCADE.
EXIT=1
```

Staleness was the sole cause; the rule itself is correct.

**Mitigation that exists:** CI is safe. I confirmed `pnpm install --frozen-lockfile` runs
`postinstall` → `prisma generate` (`✔ Generated Prisma Client (v6.19.3)`), so a CI checkout always
has a fresh DMMF. This is a **local** false green, not a CI hole — which is why it is Important
rather than Critical.

**What should change.** The check should refuse to answer from an unverified artefact. Cheapest
form: hash `schema.prisma` at generate time, record it beside the generated client, and compare —
fail with "the generated client is older than schema.prisma; run `pnpm --filter @sentinel/db
db:generate`". The OK line currently prints the Prisma *client version*, which reads like a
provenance claim while saying nothing about whether the DMMF matches the schema on disk.

#### I2 — `apps/api/scripts/dev.ts` is linted by nothing and typechecked by nothing

**File:** `apps/api/scripts/dev.ts` (new, 74 lines); `apps/api/package.json:11` (`"lint": "eslint src"`), `apps/api/tsconfig.json` (`"include": ["src/**/*.ts"]`), root `tsconfig.json:19` (`"include": ["scripts/**/*.ts"]` — root-relative)

**How I proved it.** Appended to `dev.ts`:

```ts
const broken: number = "definitely not a number";
console.log(broken);
```

```
=== pnpm typecheck (should FAIL if dev.ts is covered) ===
 Tasks:    14 successful, 14 total
TC_EXIT=0
=== pnpm lint (should FAIL if dev.ts is covered) ===
 Tasks:    14 successful, 14 total
LINT_EXIT=0
```

A blatant type error **and** a `console.log` — which `coding-standards.md` §6 lists as
lint-enforced — both pass. This is precisely the gap the implementer identified and fixed for
root `scripts/` (divergence 4, and it credits that fix with catching three real errors), recreated
in the same commit for a different directory.

**What should change.** `apps/api`: `"lint": "eslint src scripts"`, and add `scripts/**/*.ts` to a
tsconfig that `typecheck` visits (a sibling `tsconfig.scripts.json`, since `dev.ts` must not land
in `rootDir: src`/`dist`).

#### I3 — the unscoped-Prisma-client lint fence does not cover the generated client path *(pre-existing)*

**File:** `eslint.config.js:63-73`

The `no-restricted-imports` group is `['**/unscoped', '**/unscoped.js', '@sentinel/db/unscoped']`.
It fences the *wrapper module*, not the generated client. Both `unscoped.ts:9` and the new
`datamodel.ts:22` import from `../generated/client/index.js` — a path the rule never sees.

**How I proved it.** Created a new, non-exempt file `packages/db/src/__probe_bypass__.ts`:

```ts
import { PrismaClient } from '../generated/client/index.js';
export const bypass = (): PrismaClient => new PrismaClient();
```

`pnpm --filter @sentinel/db exec eslint src/__probe_bypass__.ts` → **exit 0, zero errors.**

**This is pre-existing and was not introduced by Task 14.** I flag it here for two reasons.
First, it makes divergence 3's stated rationale wrong: the file was justified because "widening
that exemption list … would trade a security fence for convenience", but the fence does not cover
the import `datamodel.ts` actually uses, so nothing would have been widened. Second,
`coding-standards.md` §6 asserts as fact that "No import of the unscoped Prisma client outside
migrations, seeds, and platform admin" is enforced by lint — and that claim is false for the
direct path.

**`datamodel.ts` itself is safe**, and I checked this specifically: it exports only
`datamodelModels()` and `PRISMA_CLIENT_VERSION`, does **not** re-export `Prisma`, and nothing it
exports can issue a query. It opens no new path around the tenant-scoped-client rule.

**What should change.** Add `**/generated/client`, `**/generated/client/*` to the restricted
group, with `unscoped.ts` and `datamodel.ts` on the file-exemption list. Then the fence matches
what the docs claim.

#### I4 — `testing.md` §6 contradicts `playwright.config.ts`, and this change made it live

**Files:** `.claude/development/testing.md` §6 (last paragraph) vs `apps/web/playwright.config.ts:31`

§6 still ends: *"Flaky tests are quarantined and fixed, never retried into passing — a retried
test is a test that no longer tells you anything."* `playwright.config.ts:31` sets
`retries: process.env['CI'] !== undefined ? 2 : 0`, and `ci.yml:117` now runs that suite. The
document was edited by this very change (the CI pipeline block was rewritten three paragraphs
above the contradiction) and the contradiction was left standing.

The implementer flagged this honestly in report §8.2 and declined to pick a side. Under
`CLAUDE.md`'s Documentation rule — *"a `.claude/` document that this change makes wrong is a
defect in this change"* — declining is not available here; the E2E stage is what made it wrong.
See my ruling on flagged item 4 for the direction I recommend.

#### I5 — `pnpm test` fails on a fresh clone; CI survives only as a side effect *(pre-existing)*

**How I proved it.** Moved `packages/contracts/dist` aside and ran the gate:

```
Error: Failed to resolve entry for package "@sentinel/contracts". …  (×4)
 Test Files  7 failed | 24 passed (31)
TEST_EXIT=1
```

Confirmed the mechanism: exactly four `apps/api` unit specs import workspace packages by name
(`all-exceptions.filter.spec.ts`, `request-id.middleware.spec.ts`, `zod-validation.pipe.spec.ts`,
`health.service.spec.ts`), and root `postinstall` runs only `prisma generate`, never a build. CI
survives solely because `pnpm lint` and `pnpm typecheck` are turbo tasks with
`dependsOn: ["^build"]` and run before `pnpm test`.

Genuinely pre-existing. Marginally worsened by this task, which adds a fifth dependent spec:
`scripts/check-tenant-registry.spec.ts` needs `packages/db/dist` (the implementer measured this
itself and corrected its own docblock accordingly). See flagged item 3 for my ruling on deferral.

---

### MINOR

#### M1 — every `changed` difference is announced as a breaking change

**File:** `scripts/check-openapi-diff.ts:118-122`

`hasBreakingDifference` returns true for `kind === 'changed'`, so any altered value triggers the
`/api/v2` banner. Proved by editing `info.description` — free prose no client consumes:

```
  ~ info.description
      committed: "Multi-tenant security TESTING, penetration-test management, and vulnerability management."
      generated: "Multi-tenant security testing, penetration-test management, and vulnerability management."

At least one difference REMOVES or CHANGES something. If the committed
document is the shipped contract, that is a breaking change: it needs
/api/v2 and a documented migration, not an in-place edit.
```

Exit code is 1 either way, so nothing unsafe happens — but a "this needs /api/v2" banner on every
docstring tweak is how people learn to skim past it. Exempting `description`, `summary` and
`info.*` from the breaking classification would keep the signal meaningful.

#### M2 — a missing committed `openapi.json` produces a raw stack trace

Deleting `apps/api/openapi.json` and running the check:

```
    at main (file:///E:/GitHub/SSTSaasPv1/scripts/check-openapi-diff.ts:192:27)
  errno: -4058, code: 'ENOENT', syscall: 'open',
  path: 'E:\GitHub\SSTSaasPv1\apps\api\openapi.json'
EXIT=1
```

Fails closed, and the `finally` still cleaned up `.openapi-check.json` — both correct. But
`readFileSync(COMMITTED)` at line 192 has no guard, so the reader gets a Node stack instead of
"the committed schema is missing; run `openapi:generate` and commit it."

#### M3 — `check:specs` passes vacuously on an empty candidate list

`scripts/check-vitest-projects.ts:220-224`: if `findCandidateSpecFiles` returned `[]`, the output
is `check:specs OK — 0 spec files`, exit 0. There is no floor assertion. I did not trigger this
(the glob works today), so it is **unproven** — but it is a live code path in a check whose whole
premise is distrusting silent zeros. A one-line `if (candidates.length === 0) fail` closes it.

#### M4 — success messages are written to stderr

All three scripts' `report()` uses `console.error` for the OK path as well as failures. Harmless
in CI; mildly confusing when redirecting output.

#### M5 — E2E `webServer` timeout is unproven on a cold Linux runner *(read-only)*

`playwright.config.ts:49,52`: `command: 'pnpm build && pnpm start:e2e'` with `timeout: 180_000`.
CI runs `pnpm build` at `ci.yml:84` first, so `.next` should be warm and the rebuild incremental —
but a full Next 16 production build plus server start inside 180s on `ubuntu-latest` has never
been executed. Also note `job timeout-minutes: 30` now covers install, format, lint, typecheck,
unit, specs, docker stack, integration, build, a Nest boot, `playwright install --with-deps`
(apt-get), and a second Next build. Both are plausible; neither is measured. Worth watching on the
first real run rather than pre-emptively changing.

#### M6 — `findCandidateSpecFiles(REPO_ROOT)` is computed twice

`scripts/check-vitest-projects.ts:175` and `:220`. Trivial.

---

## Things that are genuinely right

Brief, as instructed:

- **The FK-cascade rule and its qualifier.** Verified the rule fires on the real Task 6 defect,
  and that `Credential.user → User` and `Session.user → User` (both `Cascade`, both correct
  because the child is deliberately-global) are correctly *not* flagged. The qualifier survives
  into the failure message.
- **The omitted-`onDelete` decision.** I reproduced the measurement independently:
  `organization -> hasKey: true | "Cascade"`, `user -> hasKey: true | "Restrict"`,
  `role -> hasKey: false | undefined`. Prisma really does not materialise its default, and the
  check *reports* rather than assuming — the safe direction the brief demanded.
- **The Prettier commit.** See flagged item 1; proven behaviour-neutral by construction.
- **The citation audit.** 10/10 correct. First clean one on this branch.
- **The wider-than-`src` sweep** (divergence 2) demonstrably earns its keep — see flagged item 5.

---

## Verdicts on the five flagged items

### 1. "13 files" vs "11 files", and the CRLF/Linux question — **implementer CORRECT; CI will be green on Linux**

I reproduced this without relying on the report. `git archive` of each commit reproduces exactly
what a Linux runner checks out (blob bytes, LF-normalised by `.gitattributes`):

- At `21746c5`: `prettier --check .` → **`Code style issues found in 11 files.`** The brief's 13
  is wrong; 11 is right.
- At `a18c95d`: `prettier --check .` → **`All matched files use Prettier code style!`, exit 0.**

**So the new CI Format stage will be green on Linux, and cannot be red-there-green-here.** I also
checked the reverse direction: 7 tracked files still carry CRLF on this machine
(`.claude/api/errors.md`, `.claude/architecture/backend.md`,
`.claude/development/coding-standards.md`, `.claude/security/abuse-prevention.md`,
`.claude/security/tenant-isolation.md`, `.prettierignore`, `LICENSE`) — every one of them is
either matched by `.prettierignore`'s `**/*.md` or has no Prettier parser, so none can affect
`format:check` on either platform.

One correction to the report's *explanation*, which does not change its conclusion:
`.gitattributes`' `* text=auto eol=lf` **overrides** `core.autocrlf=true` (`git check-attr` confirms
`eol: lf` for the named files). Those files were not being CRLF-ified by autocrlf on an ongoing
basis — they were stale working-tree leftovers written before `.gitattributes` was added, which
git does not re-normalise until a file is re-checked-out. `pnpm format` rewrote them to LF, which
is why they produced no `git diff`. Accept the ruling; the reasoning wants one sentence fixed.

### 2. The self-corrected false comment (`a18c95d`) — **correction is CORRECT; design still sound**

The corrected docblock (`check-tenant-registry.ts:332-356`) claims the dynamic `@sentinel/db`
import does *not* decouple the spec from `packages/db/dist`, and that the real benefit is narrower
(not loading Prisma's query engine when only the pure functions are imported). I verified the
underlying mechanism by the same class of experiment: removing `packages/contracts/dist` makes
Vite fail with `Failed to resolve entry for package "@sentinel/contracts"` at transform time,
exactly as described for `@sentinel/db`. The corrected text is accurate.

The design is still sound and should stay: the dynamic import costs nothing, the stated narrower
benefit is real, and the module-guard at line 396 correctly keeps importing the module from
running the process-exiting check. Worth explicit credit — the implementer went to verify its own
comment before filing, found it false, measured the truth, and shipped the correction as its own
commit. That is the behaviour this branch has been failing at eight times.

### 3. The fresh-clone `pnpm test` gap — **real, genuinely pre-existing, marginally worsened; deferral acceptable but I would not let it reach Task 17**

Verified independently (see I5) — the claim is accurate in every particular, including that CI is
saved only by `dependsOn: ["^build"]` on the lint/typecheck turbo tasks running first.

"Pre-existing" is correct: the four dependent specs and the build-free `postinstall` all predate
this task. "Made worse" is also true but marginally — this task adds a fifth dependent spec and
extends the class from `apps/api` into root `scripts/`.

**On "recommend Task 16": acceptable, with a caveat I'd record.** The implementer's reasoning —
that the honest fixes are workspace-topology changes that deserve their own review rather than
being smuggled into a CI-checks task — is sound and consistent with how this branch has been run.
But the fix is genuinely one line (a `pretest` that builds, or routing root `test` through turbo),
and the failure mode is *the correctness of a CI gate depending on the incidental side effect of
an earlier step's task graph* — which is the exact species of rot this entire task exists to stop.
Defer it, but record it in the roadmap as **owed**, not as a suggestion, and do not let it slip
past Task 16.

### 4. `testing.md` §6 "never retried into passing" vs `retries: 2` — **must be resolved now; fix the document, not the config**

Confirmed live (see I4). My ruling: **change `testing.md` §6.** `retries: 2` on a browser E2E lane
is defensible engineering — it absorbs genuine infrastructure flake (port binding, cold server
start, network) rather than test flake, and `trace: 'on-first-retry'` means every retry leaves
evidence behind rather than hiding the failure. The absolute in §6 was written about unit and
integration tests, where it is right, and over-generalised to a lane that did not exist yet.

Recommended shape: retries are permitted **only** in the E2E lane; unit and integration run with
`retries: 0`; and a test that goes red-then-green on retry is triaged, not ignored — the trace
artefact exists for exactly that. What is not acceptable is leaving it as-is: this task made the
contradiction live, and the Documentation rule makes it this change's defect.

### 5. The seven divergences — **all seven are proportionate; not scope creep. One rationale needs correcting.**

- **Div 1 (fixed relative `--out` rather than a temp dir):** good call. Verified the tree stays
  clean on success *and* on both failure paths, and that `.openapi-check.json` never survives.
  Keeping environment-derived strings off a Windows command line is a real, measured constraint.
- **Div 2 (scan whole packages, not just `src`):** good call, and I proved it earns its keep.
  A probe at `packages/db/__probe_root__.spec.ts` — outside any `src` tree, so invisible to the
  ruling as literally written — was caught: `check:specs FAILED … claimed by NO Vitest project`,
  exit 1. Widening beyond the ruling was correct.
- **Div 3 (`packages/db/src/datamodel.ts`):** **right outcome, wrong reason.** The file is safe —
  I verified it exports only `datamodelModels()` and `PRISMA_CLIENT_VERSION`, does not re-export
  `Prisma`, and opens **no** path around the tenant-scoped-client rule. But the justification
  ("widening that exemption list would trade a security fence for convenience") does not hold:
  the fence never covered `../generated/client/index.js` in the first place (proved in I3).
  Keep the file; it is the cleaner design regardless. Correct the docblock at
  `datamodel.ts:9-14`, which currently asserts a protection that is not there.
- **Div 4 (`cli-args.ts` + root `tsconfig.json`):** good call, and the root tsconfig closed a real
  gap that immediately paid for itself. Incomplete, though — see I2.
- **Div 5 (`exhaustive-deps` → `error`):** correct and necessary. ESLint exits 0 on warnings, so
  at `warn` the rule would have gated nothing in the task whose entire theme is gating. Verified
  it fires as an **error** through `pnpm lint` itself, not merely a scoped eslint call.
- **Div 6 (Playwright reporter → `[github, html]`):** correct. Without it the upload step at
  `ci.yml:123` would name a directory that never exists — the step's name would have been
  half-false, which is the class this branch keeps re-introducing.
- **Div 7 (third commit correcting its own comment):** exactly right. See item 2.

None of these is scope creep. Each is small, each is load-bearing for something the brief actually
asked for, and each was declared.

---

## What I verified by execution

All commands run from `e:\GitHub\SSTSaasPv1` at `a18c95d`, Docker Desktop running.

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 — 14/14 turbo tasks |
| `pnpm typecheck` | exit 0 — 14/14 turbo tasks |
| `pnpm format:check` | exit 0 — `All matched files use Prettier code style!` |
| `pnpm test` | exit 0 — **31 files / 375 tests passed** |
| `pnpm test:integration` | exit 0 — **10 files / 139 tests passed** against the live stack |
| `pnpm build` | exit 0 — 8/8 tasks |
| `pnpm test:e2e` | exit 0 — **5 Playwright tests passed** (Windows/Chromium) |
| `pnpm install --frozen-lockfile` | exit 0, no lockfile change; `postinstall` regenerates Prisma client |
| `pnpm check:registry` | exit 0 — `10 models, 3 tenant-owned, 1 tenant root, 6 deliberately global` |
| `pnpm check:openapi` | exit 0 — byte-identical; `git status` empty; temp file removed |
| `pnpm check:specs` | exit 0 — `41 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm dev:api` (90s) | Compiles (`Found 0 errors`), boots Nest, initialises every module |

**Drills I re-ran from the report** (all reproduced as described): registry FK-cascade
(`Membership.userId` → `Cascade`), registry omitted-`onDelete` (`Membership.role`), openapi
hand-edit, specs zero-project (`.spec.jsx`), specs two-project (`unit` widened to `.spec.tsx`),
react-hooks `exhaustive-deps`.

**Drills I invented** (five; two found defects):

| Drill | Outcome |
|---|---|
| `packages/db/src/__probe__.test.ts` with `expect(1).toBe(2)` | **C1** — both `pnpm test` and `check:specs` green |
| `schema.prisma` cascade defect **without** `prisma generate` | **I1** — `check:registry` OK, exit 0 |
| `apps/api/scripts/dev.ts` + type error + `console.log` | **I2** — lint and typecheck both exit 0 |
| `packages/db/src/__probe_bypass__.ts` importing raw `PrismaClient` | **I3** — eslint exit 0 |
| `'User'` added to `TENANT_OWNED_MODELS` (already global) | Correctly caught — 2 problems, exit 1 |
| `packages/db/__probe_root__.spec.ts` (outside any `src`) | Correctly caught, exit 1 |
| Delete `apps/api/openapi.json` entirely | **M2** — exit 1 (fails closed) but raw ENOENT stack |
| Cosmetic `info.description` edit | **M1** — announced as breaking |
| `packages/contracts/dist` moved aside → `pnpm test` | **I5** — 7 files fail, exit 1 |
| `prettier(old)` vs committed, all 11 reformat files | All byte-identical; commas-only delta on the two `packages/db` security files |
| `git archive` + `prettier --check` at `21746c5` / `a18c95d` | 11 files / 0 files — flagged item 1 settled |

**Tree restored after every drill**, each confirmed with `git status --short`. Final state:
`git status --porcelain` empty, HEAD `a18c95d`.

## What I could only verify by reading

- **The GitHub Actions workflow has not been run**, by me or by the implementer. Step ordering,
  `.env` availability before `check:openapi`, `if: failure()` semantics, and
  `actions/upload-artifact@v4` behaviour are read-only conclusions. My reading of the ordering
  agrees with the implementer's and I found no ordering defect.
- **`playwright install --with-deps chromium` on `ubuntu-latest`** — never executed anywhere.
- **The E2E `webServer` on Linux**, including whether `pnpm build && pnpm start:e2e` fits inside
  `timeout: 180_000` on a cold runner (M5). The env chain (`.env.example` → `.env` → `WEB_PORT=3000`,
  `APP_ENV` overridden by `start:e2e`) I confirmed by reading the files; the Linux execution I did not.
- **Job `timeout-minutes: 30`** against the now-longer step list (M5).
- **The `html` reporter output directory** — CI-only, never produced on this machine.
- **`ci.yml`'s claim that a genuine E2E failure always leaves a trace.** `trace: 'on-first-retry'`
  plus `retries: 2` makes this sound, but it is reasoning, not observation.

---

## Conditions for approval

1. **C1 — mandatory.** Widen the `check:specs` candidate sweep to `*.{spec,test}.*` and pin it
   with a regression test. Decide explicitly whether `.test.*` is claimed or banned.
2. **I2 — mandatory, cheap.** Bring `apps/api/scripts/` under lint and typecheck.
3. **I4 — mandatory, cheap.** Resolve `testing.md` §6 against `retries: 2` (I recommend amending
   the document).
4. **I1 — this round if cheap, otherwise recorded as owed.** A staleness guard on the DMMF.
5. **I3 — record as owed** (pre-existing), and correct `datamodel.ts:9-14`'s rationale in this
   round since it is a false statement about a security control.
6. **I5 — record in the roadmap as owed to Task 16**, not as a suggestion.
7. Minors at the implementer's discretion; M1 and M3 are one-liners worth taking.

**The single thing most likely to bite:** C1. Someone writes `auth.test.ts` — the most natural
filename in the ecosystem — it never executes, `pnpm test` prints green, and `check:specs`, the
check whose entire reason for existing is to catch exactly that, prints green too. The next person
to look will trust it, because this task's documentation now tells them to.
