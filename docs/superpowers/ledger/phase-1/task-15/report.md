# Task 15 report — `sentinel-phase` and `sentinel-verify`

Implementer: fresh subagent. Base commit df61629, branch `feat/phase-1-foundation`.
**Not committed** — tree left dirty for the controller.

## Files written

| File | Change |
|---|---|
| `.claude/skills/sentinel-verify/SKILL.md` | Created. Frontmatter transcribed verbatim from plan lines 5292-5293. Body: plan Steps 1-4 as numbered sections, plus a fifth section "Cite before you claim" (the carry-forward ruling). Red-flags table: the plan's six rows verbatim, plus one added row for the false-claim class. |
| `.claude/skills/sentinel-phase/SKILL.md` | Created. Frontmatter transcribed verbatim from plan lines 5326-5327. Body: the plan's eight items as an eight-item checklist (one todo per item), plus the anti-patterns table with all five rows verbatim. |
| `.claude/README.md` | Two edits — a row in the "How to use this tree" table pointing at `skills/`, and a `skills/` line in the Map code block. |
| `CLAUDE.md` | The two-sentence paragraph added verbatim under "Resuming work in a new session", after the `roadmap.md` paragraph. |

### Deviation from the plan's literal text (one, deliberate)

Plan Step 3 gives the README row as `| [`skills/`](skills/) | Project skills: … |`. `.claude/README.md`
has two candidate targets and neither takes that row as written: the **Map** is a fenced code
block (a markdown link there would not render), and the **"How to use this tree"** table's first
column is a need ("I need to…"), not a path. I wrote both in their own idiom:

- Table row: `| Start, resume, or finish a phase | [`skills/`](skills/) — project skills: `sentinel-phase`, `sentinel-verify` |`
- Map line: `skills/         Project skills: sentinel-phase, sentinel-verify`

The content of the plan's row is preserved; the column order is not. Flagging it rather than
silently reshaping the file.

## Command / script honesty check

Every command named in either skill was checked against the root `package.json` as it stands at
df61629 (`cat package.json`). Present and used: `lint`, `typecheck`, `test`, `test:integration`,
`build`, `check:openapi`, `check:registry`. Not referenced anywhere in either skill: `dev:worker`
and `test:security` (they do not exist). `docker compose ps` is a Docker command, not a pnpm
script, and is named as such.

## Evidence

| Command | Exit code | What it proves |
|---|---|---|
| `pnpm lint` | 0 | ESLint across all 8 packages plus `scripts/` is clean on the working tree. Proves the docs-only change did not break lint; proves nothing about the skill bodies' content. |
| `pnpm typecheck` | 0 | `tsc --noEmit` across all 8 packages plus the root project passes. Same scope caveat. |
| `pnpm format:check` | 0 | `prettier --check .` passes over the whole tree. Note: `**/*.md` is in `.prettierignore`, so this exit code says nothing about the formatting of the four files this task touched — it only proves nothing else regressed. |
| `cat package.json` | 0 | Establishes which pnpm scripts exist, which is what the "no command that does not exist" constraint rests on. |
| `git status --short` | 0 | Shows exactly four paths touched: `M .claude/README.md`, `M CLAUDE.md`, `?? .claude/skills/`. Confirms `.claude/product/roadmap.md` was not modified. |

Both lint and typecheck reported `FULL TURBO` (14/14 cached). The cache hit is itself consistent
with a docs-only change — no package input changed — but it means these two runs re-played prior
output rather than re-executing the compilers.

## What I did NOT verify

1. **Discoverability (plan Step 4).** Not tested and not claimed. Whether a fresh session lists
   `sentinel-phase` and `sentinel-verify` and loads their bodies on invocation cannot be
   determined from inside this session. This is a controller step. A skill that is not discovered
   is a file, not a skill — as of this report, both are files.
2. **`pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`, `pnpm check:*`.** Not
   run. The brief's definition of done named three commands; I ran those three. No claim is made
   about the state of the test suites.
3. **Whether the skills' instructions produce good behaviour** when followed. The content was
   written against the plan and `.claude/development/resuming-work.md`; it has not been exercised.
4. **The roadmap.** Not read for status and not edited, per constraint 2.

## Out-of-scope observation (not fixed, per constraint 4)

`.claude/README.md` § "Current status" still reads "Phase 0 is complete and no application code
exists." That is stale — `apps/`, `packages/`, and a Prisma schema exist at df61629. Left alone
as instructed.

---

# Fix round 1

Applied after `task-15-review.md`. Controller ruling: fix I1 (+M1 folded in), I2, I3 only.
M2, M3, M4, M5, M6 recorded as accepted residuals and deliberately not touched.
Still not committed; `.claude/product/roadmap.md` still untouched.

## I1 + M1 — `sentinel-verify` §1 command table

`.claude/skills/sentinel-verify/SKILL.md`. Added three rows and amended one cell. The table's
shape and the three existing conditional rows (`docker compose ps`, `check:openapi`,
`check:registry`) are unchanged, per the ruling.

Added:

> \| `pnpm format:check` \| Always. \|

> \| `pnpm check:specs` \| Always — a spec claimed by no Vitest project runs nothing while `--passWithNoTests` prints green. \|

> \| `pnpm test:e2e` \| The change touches `apps/web` or a response header. Not free: it needs a Playwright browser (`pnpm --filter @sentinel/web exec playwright install --with-deps chromium`), and `playwright.config.ts` builds and starts the web app itself, so budget the minutes rather than skipping the row. \|

`test:e2e` is conditional rather than Always, with its precondition stated. Both halves of that
precondition were read out of `.github/workflows/ci.yml` (the `Install Playwright chromium` step
and the comment at line 110 stating `playwright.config.ts` owns the server), not assumed.

M1, folded into the same edit — the `pnpm test:integration` cell changed from `Always.` to:

> \| `pnpm test:integration` \| Always. Requires the compose stack: `docker compose up -d` first, with Docker Desktop running. If you cannot start it, that is a **Blocked** status with the daemon named as the blocker (§3) — not a row you drop. \|

No escape hatch: the clause routes a missing daemon to Blocked, and explicitly denies dropping
the row.

## I2 — `sentinel-verify` §3, phase-status rule

Appended to §3, after the four-status list and before §4. Kept general — no Phase 1, no mention
of the current `pnpm test` defect:

> When the claim is a **phase status**, the covering commands are that phase's exit criteria as
> written in `roadmap.md`, not the default list in §1. Read them literally: an exit criterion that
> says "from a clean clone" is not proven by a warm tree, where `node_modules`, build output and
> generated clients already exist. Satisfy it as written — a scratch clone, or a `git clean -xdf`
> equivalent — or record the gap and mark it **Partially Implemented**. Five green rows from a warm
> tree are not a phase.

## I3 — `sentinel-phase` step 5

One clause added at the head of the step, so the cross-reference lands before the instruction to
write:

> - [ ] **5. Update `roadmap.md` in the same change that moves the status.** Run `sentinel-verify`
>   first — the status you write is whatever its evidence table supports, and no more. Not
>   afterwards, not at the end of the phase. A stale roadmap makes the next session rebuild what
>   exists or skip what does not.

The trailing sentence was re-wrapped to keep the paragraph inside the file's line width; its
wording is unchanged.

## Evidence — fix round 1

| Command | Exit code | What it proves |
|---|---|---|
| `pnpm lint` | 0 | ESLint clean across 8 packages + `scripts/` after the edits. Docs-only change; proves no regression, nothing about skill content. |
| `pnpm typecheck` | 0 | `tsc --noEmit` across packages + root project still passes. |
| `pnpm format:check` | 0 | `prettier --check .` passes. `**/*.md` is prettier-ignored, so this still says nothing about the four files edited — only that nothing else regressed. |
| `git status --short` | 0 | Unchanged from round 1: `M .claude/README.md`, `M CLAUDE.md`, `?? .claude/skills/` (three status lines, four files — correcting the imprecision M5 named). No commit; roadmap untouched. |
| `grep -n` over `.github/workflows/ci.yml` | 0 | Establishes the CI gate list and the two `test:e2e` preconditions quoted above. |

## What fix round 1 did NOT verify

1. **Discoverability (plan Step 4).** Still not tested, still not claimed. The reviewer's
   observation that neither skill appeared in their own session's skill list makes this a real
   open risk, not a formality. Controller step.
2. **That a session following the amended §1 table can actually get eight green rows here.** I did
   not re-run `pnpm test`, `test:integration`, `build`, `check:specs`, `check:openapi`,
   `check:registry` or `test:e2e` in this round — the reviewer ran the first six at exit 0 on this
   same tree; `pnpm test:e2e` has been run by neither of us in either round.
3. **The clean-clone rule in §2 (I2) against a real clean clone.** The rule is written from
   `roadmap.md`'s own exit-criterion wording as quoted in the review; I did not perform a scratch
   clone to confirm the current `pnpm test` clean-clone failure, and the skill does not assert it.
4. Whether the skills produce good behaviour when followed. Unexercised.
