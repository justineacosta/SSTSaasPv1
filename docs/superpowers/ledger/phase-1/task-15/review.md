# Task 15 adversarial review — `sentinel-phase` and `sentinel-verify`

Reviewer: fresh adversarial subagent. Did not write this code.
Tree reviewed: working tree at base commit df61629, uncommitted.
Date: 2026-08-22.

**Verdict: APPROVED CONDITIONAL ON I1, I2, I3 and plan Step 4.**
No Critical. No non-existent command. No broken link. No false claim found in either
skill or in the implementer's report — every factual assertion in `task-15-report.md`
was independently re-derived and holds.

---

## What I re-ran myself (not trusted from the report)

| Command | Exit code | What it proves |
|---|---|---|
| `pnpm lint` | 0 | Confirms the report's row. `14 successful, 14 cached, FULL TURBO` — reproduced exactly, including the cache caveat the report itself raised. |
| `pnpm typecheck` | 0 | Same, 14/14 FULL TURBO. |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm test` | 0 | 32 files, 403 tests. **Not run by the implementer** — I ran it. Relevant to I2 below. |
| `pnpm test:integration` | 0 | 10 files, 139 tests, against the live stack. Not run by the implementer. |
| `pnpm build` | 0 | 8 tasks. Not run by the implementer. |
| `pnpm check:specs` | 0 | 42 spec files, each claimed once. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all Up (healthy). Establishes that today's green `test:integration` depends on a running daemon. |
| `diff` plan frontmatter vs both SKILL.md | 0 | Both frontmatter blocks byte-identical to plan lines 5291-5294 and 5325-5328. |
| `diff` plan red-flags / anti-patterns vs skills | — | Both tables byte-identical row-for-row; the only delta is the one deliberately added red-flag row. |
| `ls` from inside `.claude/skills/sentinel-phase/` | 0 | `../../development/resuming-work.md` resolves. |
| `cat package.json` + `grep -oE` over both skills | 0 | Every command named in either skill exists: `lint`, `typecheck`, `test`, `test:integration`, `build`, `check:openapi`, `check:registry`, plus `docker compose ps`, `git log`, `git show`, `git status`. `dev:worker` and `test:security` appear nowhere. |
| `git status --short` | 0 | Exactly `M .claude/README.md`, `M CLAUDE.md`, `?? .claude/skills/`. `roadmap.md` untouched — constraint 2 honoured. |

Referents checked against the filesystem, all real:
`.claude/architecture/overview.md` §8 "Where each phase lands" (a per-phase docs table, exists);
`.claude/decisions/README.md` (exists, has the index table the skill says to add a row to, and its
Rules section does state "An ADR is **immutable once accepted**" — the skill's paraphrase is
accurate); `roadmap.md` §"Blocked items" (a real table, line 134);
`.claude/development/resuming-work.md`.
The Docker-daemon example is also true of this repository: `git log -S` shows the roadmap's Blocked
table once carried `| Local stack verification (Postgres, Redis, MinIO) | **Docker daemon not
running** ... | Operator |` and that row was later removed.

The `sentinel-verify` §5 citation was verified against the ledger and is accurate, including the
quoted string: `task-14-rereview-round1.md` line 12 — "recorded in the roadmap as owed" — is false;
the roadmap was never touched. The counts "ten instances" and "four of them introduced while
correcting another one" match `progress.md` line 1933 verbatim.

---

## Pass A — spec compliance

Contract: plan lines 5277-5399.

### Step 1 — `sentinel-verify`

| Plan item | Status | Note |
|---|---|---|
| Frontmatter `name` / `description` byte-identical | **Met** | Proved by `diff`, not by eye. |
| 1. Run these, and read the output (5 commands + conditional `docker compose ps`, `check:openapi`, `check:registry`) | **Met, with deviation** | All eight present. The plan's flat prose list became a two-column table, and the plan's single conditional "`check:openapi` / `check:registry` when it touches the API or the schema" was split into two rows with different conditions. Reshaping is defensible; the added "Always." column is what I1/I2/M1 are about. |
| 2. Evidence table — command, exit code, what it proves; a command not run has no row | **Met** | Header present, rule stated, plus a useful anti-widening sentence. |
| 3. Map to a status using §79's vocabulary; Implemented requires zero exit for every covering command | **Met** | All four statuses defined. |
| 4. Write the status; never "Implemented" without evidence | **Met** | |
| Red-flags table, six rows | **Met** | Byte-identical. |
| Brief's carry-forward: citation check + one added red-flag row | **Met** | §5 "Cite before you claim" plus the seventh row. Grounded in a real, verified incident. |

### Step 2 — `sentinel-phase`

| Plan item | Status |
|---|---|
| Frontmatter byte-identical | **Met** (proved by `diff`) |
| 1. Read in order: CLAUDE.md, roadmap, overview, phase docs (`overview.md` §8), ADRs; then `git log --oneline -20`, `git status` | **Met** |
| 2. Verify, do not trust — run exit criteria; use `sentinel-verify` | **Met** |
| 3. Check the Blocked table; Docker-daemon example | **Met** |
| 4. Build on `feat/`, test-first, commit often, never `main` | **Met** |
| 5. Update `roadmap.md` in the same change | **Met** (see I3) |
| 6. Update every invalidated `.claude/` document | **Met** |
| 7. Write an ADR; add its row to `decisions/README.md`; immutable once accepted | **Met** |
| 8. End cleanly; commit even if incomplete; plain-words note | **Met** |
| Anti-patterns table, five rows | **Met** (byte-identical) |
| "one todo per item" | **Met** — eight `- [ ]` items, with "Track each item as its own todo." |

Nothing was silently dropped. Everything added to `sentinel-phase` beyond the plan's wording
traces to `resuming-work.md` (§5, §6, the `WIP:` sentence) or to `decisions/README.md`.

### Step 3 — registration

| Plan item | Status |
|---|---|
| `.claude/README.md` row `[skills/](skills/)` / "Project skills: …" | **Partial** — content preserved, form changed. See M4. |
| `CLAUDE.md` paragraph | **Met, verbatim** (three lines, byte-identical to plan lines 5370-5372, placed directly under the "Resuming work in a new session" roadmap paragraph). |

### Step 4 — discoverability

**Missed, and correctly not claimed.** The report says so plainly ("as of this report, both are
files"). This is a controller step and it is still open — see the conditional in the verdict, and
the observation at the end of this review.

### Step 5 — commit

Deliberately not done, per brief constraint 3. Correct.

---

## Pass B — quality and correctness

### I1 — Important. `sentinel-verify`'s command table omits three of the gates CI actually runs.

`.claude/skills/sentinel-verify/SKILL.md`, the §1 table.

CI (`.github/workflows/ci.yml`) runs, in order: `format:check`, `lint`, `typecheck`, `test`,
`check:specs`, the compose stack, `test:integration`, `build`, `check:openapi`, `check:registry`,
`playwright install`, `test:e2e`. The skill's table names five "Always" commands and three
conditional ones. **`pnpm format:check`, `pnpm check:specs` and `pnpm test:e2e` appear nowhere in
either skill**, and `check:openapi`/`check:registry` are marked conditional though CI runs them
unconditionally.

Why it is wrong: the skill's stated purpose is to stop a session claiming green when it is not, and
its own red-flag row says *"CI will catch it" → "CI catching it is you shipping a red branch."* A
session that follows this table exactly, sees five zeros, and pushes can still hand CI a red build
from a Prettier drift or a spec claimed by no Vitest project. Both of those are live failure modes
on this branch, not hypotheticals: Task 14 exists because `format:check` had never passed and 11
files had drifted, and `check:specs` exists because Task 12 hit three spellings of an
unclaimed-spec bug, the third introduced by the fix round for the second. The task brief's own
definition of done required `format:check` — so the omission is visibly wrong even inside this task.

This is faithful to the plan, which predates Task 14's three new checks. Fidelity to a stale plan
is the defect.

**Fix:** add rows for `pnpm format:check` ("Always.") and `pnpm check:specs` ("Always — a spec
claimed by no Vitest project runs nothing while `--passWithNoTests` prints green."); add
`pnpm test:e2e` with the condition "the change touches `apps/web` or a response header"; and change
the `check:openapi`/`check:registry` conditions to note CI runs them on every build.

### I2 — Important. Nothing in `sentinel-verify` distinguishes a warm tree from a clean clone, so it would license the exact false status the roadmap warns about — on its first real use.

`.claude/skills/sentinel-verify/SKILL.md` §1 (the `pnpm test` / "Always." row) and §3
("**Implemented** — requires a zero exit for *every* command covering the claim").

Phase 1's exit criterion, `roadmap.md` line ~150, is:

> *Exit:* `pnpm install && pnpm build && pnpm test` passes **from a clean clone**; the compose
> stack starts; a migration applies; CI is green.

`roadmap.md` line 180 records that this currently **fails**: four `apps/api` specs plus one under
`scripts/` import workspace packages by name, root `postinstall` only runs `prisma generate`, so the
`dist` they resolve to does not exist on a fresh clone. Owed to Task 16.

I ran `pnpm test` in this tree: **exit 0, 403 passed.** Both facts are true at once — warm tree
green, clean clone red. The skill's table has exactly one row for `pnpm test` and no notion of the
distinction. Task 16 is the *next* task, and its job is the exit-criteria verification pass that
moves Phase 1's status. A session that invokes `sentinel-verify` there, follows it literally, and
collects five zero exits gets a fully green evidence table and a skill telling it that "Implemented
requires a zero exit for every command covering the claim" — condition satisfied. The control fails
open on the single most consequential status move on this branch, in favour of a claim the roadmap
already knows to be false.

Note this is *not* a "the skill can never report Implemented" trap — the opposite. The trap runs the
other way, and it is worse.

**Fix:** add a row or a short §1 note: when the claim is a phase status, the exit criteria in
`roadmap.md` are the covering commands, and where an exit criterion says "from a clean clone" the
warm-tree run does not cover it — verify in a scratch clone (or `git clean -xdf` equivalent) or
record the gap as Partially Implemented. Naming `roadmap.md`'s current `pnpm test` entry as the
worked example would make it concrete.

### I3 — Important. `sentinel-phase` step 5 moves the status without invoking `sentinel-verify`.

`.claude/skills/sentinel-phase/SKILL.md`:

> - [ ] **5. Update `roadmap.md` in the same change that moves the status.**

`sentinel-verify`'s own description says it is for use "before claiming any work is complete … **and
before moving a status in roadmap.md**". `sentinel-phase` cites `sentinel-verify` in step 2
(verifying *someone else's* claimed status) but not in step 5, which is where *this* session writes
one. The pair of controls has a hole exactly where the branch's own defect history says it needs one:
the false-claim class is a writing defect, not a reading defect.

**Fix:** one clause in step 5 — "Run `sentinel-verify` first; the status you write is whatever its
evidence table supports."

### M1 — Minor. The `pnpm test:integration` / "Always." row has an unstated precondition.

`CLAUDE.md` states "**Docker Desktop must be running** for anything touching the database, queue, or
storage." I confirmed the stack is up here (`docker compose ps`: four services healthy) and
`test:integration` exits 0. On a machine with the daemon stopped it cannot pass, and the skill offers
no guidance — a session doing a docs-only change is left choosing between an unpassable table and
quietly ignoring the row it was told is mandatory. A control that is routinely ignored stops being a
control.

**Fix:** either condition the row ("Always — start the compose stack first; it needs Postgres, Redis
and MinIO"), or state that an environment that cannot run a covering command yields **Blocked**, not
a shrug. The machinery for the second option already exists in §3.

### M2 — Minor. "specification §79" is a dangling referent.

`sentinel-verify` §3: "Use specification §79's vocabulary". `find . -iname '*specification*'` outside
`node_modules` returns nothing; the only other occurrences of the phrase are `CLAUDE.md` and
`roadmap.md` line 8. So the skill inherits a repo-wide dangling citation rather than introducing one,
and the harm is bounded because §3 enumerates all four statuses inline — a fresh session is not
blocked. Recording it, not asking for a fix here; it belongs to whoever reconciles the external
specification with the tree.

### M3 — Minor. §5's supporting evidence is gitignored and machine-local, and "this branch" will not stay current.

`sentinel-verify` §5 cites "the Task 14 fix-round report". That lives in
`.superpowers/sdd/2026-08-20-phase-1-foundation/`, which `roadmap.md` states is "**gitignored and
exists only on the machine that built it**". A session in Phase 6, on a fresh clone, is told by a
skill whose first rule is "Name the source" to trust a source it cannot open. Also "Four of *this
branch's* false claims" reads as feat/phase-1-foundation, which will be merged and gone.

Low harm — the failure is restated inline and stands without the file. **Fix if touching it:** say
"Phase 1" rather than "this branch", and note the ledger is machine-local.

### M4 — Minor, disclosed. Plan Step 3's literal README row was reshaped.

Confirmed the implementer's justification is accurate: `.claude/README.md`'s first table is headed
`| I need to... | Read |`, so the plan's row cannot be dropped in as written, and the Map is a fenced
code block where a markdown link would not render. The content survives in both places, and the
deviation was flagged rather than hidden. Accept as written.

### M5 — Minor. One imprecision in the report.

`task-15-report.md`: "Shows exactly four paths touched: `M .claude/README.md`, `M CLAUDE.md`,
`?? .claude/skills/`." That is three `git status --short` lines. Four *files* are touched (the
untracked directory holds two `SKILL.md`s), so the sentence is defensible but reads as a
miscount against the list it introduces. Worth naming only because this branch's defect history
is precisely this kind of sentence.

### M6 — Minor. "`pnpm lint` costs eight seconds" is plan rhetoric, not a measurement.

Verbatim from the plan, so in scope only as a note. Eight seconds is a warm-cache figure (I measured
22ms FULL TURBO); cold it is far longer. Nobody will be harmed by it.

---

## Things I looked for and did not find

- **No non-existent command.** Every command in both skills exists in root `package.json` or is a
  real `docker`/`git` invocation. `dev:worker` and `test:security` are absent, as the brief required.
- **No broken link.** `../../development/resuming-work.md` resolves from the skill directory;
  `skills/` resolves from `.claude/README.md`; the `CLAUDE.md` addition contains no links.
- **No false claim in the skills.** The §79 vocabulary, `overview.md` §8, the Blocked table, the
  Docker-daemon precedent, `decisions/README.md` and its immutability rule, and the Task 14 incident
  all check out against the tree and against git history.
- **No false claim in the report.** Every exit code reproduced; FULL TURBO 14/14 reproduced; the
  8-package count is right (2 apps + 6 packages); `**/*.md` is in `.prettierignore` as stated; the
  "not verified" list is honest and complete, and the report volunteers the turbo-cache caveat
  against its own evidence. This is the first report on the branch I could not break.
- **No contradiction with `CLAUDE.md` or `resuming-work.md`.** The skills are a faithful compression
  of both, allowing for I1's staleness.
- **Followable by a fresh session?** Yes. Both skills name absolute document paths, define their
  vocabulary inline, and assume no conversational context. `sentinel-phase` step 2 says "run its exit
  criteria" without saying where they live (`roadmap.md` §"Phase detail and exit criteria"), but step
  1 has already required reading that file, so the gap closes itself.

## Observation for plan Step 4 (not a finding)

Neither `sentinel-phase` nor `sentinel-verify` appeared in this reviewer session's available-skills
list. I cannot tell whether that is meaningful — this session may have inherited a skill snapshot
taken before the files were written, and subagent sessions may not enumerate project skills the same
way a top-level session does. Flagging it only so the controller treats Step 4 as a real test with a
real possible failure, rather than a formality: check a genuinely fresh top-level session, and
confirm invoking `sentinel-verify` loads its body, not just that the name appears.

---

## Verdict

**APPROVED CONDITIONAL ON:**

1. **I1** — add `format:check`, `check:specs` and `test:e2e` to `sentinel-verify`'s table so it
   matches the gates CI actually runs.
2. **I2** — give `sentinel-verify` a clean-clone / exit-criteria rule before Task 16 uses it to move
   Phase 1's status.
3. **I3** — cross-reference `sentinel-verify` from `sentinel-phase` step 5.
4. **Plan Step 4** — discoverability confirmed in a fresh session before this is called done. Until
   then the honest status of Task 15 is Partially Implemented: two files exist, and a file is not a
   skill.

M1 is a cheap fix worth folding in while I1 is being applied. M2-M6 are recorded, not required.

Spec compliance is otherwise the cleanest on this branch: both frontmatter blocks and both
tables are byte-identical to the contract, proved by `diff` rather than by reading.


---

# Re-review — fix round 1

Reviewer: same adversarial subagent. Scope: the fix round only. I did not re-review anything
approved in round 1, and I did not re-raise M2-M6 (ruled residuals).
Tree: still uncommitted — `git status --short` is `M .claude/README.md`, `M CLAUDE.md`,
`?? .claude/skills/`. `roadmap.md` untouched.

**Verdict: CLEAN — 0 open Important or Critical. One new Minor (NEW-1) recorded.**

---

## Question 1 — did each fix land in the tree, not just in the report?

I read both `SKILL.md` files off disk and machine-checked every block the report quotes,
whitespace-normalised, against the real file contents rather than reading them side by side.
**All six quoted blocks matched.** Nothing in the fix-round report describes work that is not
on disk.

| Finding | On disk? | Evidence |
|---|---|---|
| I1 — `format:check` | Yes, `sentinel-verify` line 18 | Row reads `Always.` |
| I1 — `check:specs` | Yes, line 22 | Row present with the `--passWithNoTests` justification |
| I1 — `test:e2e` | Yes, line 25 | Row present, conditional, with both preconditions |
| M1 — `test:integration` | Yes, line 23 | Cell amended from bare "Always." |
| I2 — phase-status rule | Yes, lines 55-60 | Paragraph appended to §3, before §4 |
| I3 — `sentinel-verify` cross-reference | Yes, `sentinel-phase` lines 31-34 | Clause at the head of step 5 |

The rows were **inserted in CI's own order** (format → lint → typecheck → test → check:specs →
integration → build), not appended to the end. The report says "added three rows and amended one
cell" without mentioning placement; the placement is better than appending, so this is an
unreported improvement rather than an unreported deviation.

I also re-checked that the fix round did not disturb what round 1 approved:

- Both frontmatter blocks are **still byte-identical** to plan lines 5291-5294 and 5325-5328
  (`diff`, exit 0).
- The red-flags table is still byte-identical to the plan's six rows plus the one sanctioned
  addition; the anti-patterns table is still byte-identical to all five.
- The three pre-existing conditional rows (`docker compose ps`, `check:openapi`,
  `check:registry`) are unchanged, as the report claims.
- Every prose (non-table) line in both files is at most 100 characters, so the I3 re-wrap claim
  holds.

Re-ran the three gates myself rather than trusting the appended table:

| Command | Exit code | Note |
|---|---|---|
| `pnpm lint` | 0 | 14/14 cached, FULL TURBO — same caveat the report raises against its own row |
| `pnpm typecheck` | 0 | 14/14 cached, FULL TURBO |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |

---

## Question 2 — did any fix introduce a new defect?

### The `test:e2e` row — verified true, no defect

Both halves of the quoted precondition are accurate against the real files, not plausible-sounding:

- The command `pnpm --filter @sentinel/web exec playwright install --with-deps chromium` is
  **character-for-character identical** to `.github/workflows/ci.yml` line 108 (compared by
  `grep -o` on both files). The filter name is right: `apps/web/package.json` declares
  `"name": "@sentinel/web"`.
- "`playwright.config.ts` builds and starts the web app itself" is **true**.
  `apps/web/playwright.config.ts` sets `webServer.command: 'pnpm build && pnpm start:e2e'`, so
  Playwright does rebuild and start the app. The report's citation of "the comment at line 110"
  is also exact — line 110 of `ci.yml` is the "playwright.config.ts owns the server" comment.
- I additionally checked the flag is not Linux-only folklore that would fail on this Windows dev
  machine. Ran the same command with `--dry-run`: **exit 0**, resolving Chrome for Testing
  151.0.7922.34 plus ffmpeg, headless shell and winldd, with `--with-deps` dispatching to
  `install_media_pack.ps1` rather than erroring. The command a future session is told to run works
  on the platform it will be run on.

### The `check:specs` row's `--passWithNoTests` justification — verified true, no defect

Not filler. `vitest.workspace.ts` sets `passWithNoTests: true` on the `unit`, `integration` and
`ui` projects, and root `package.json` passes `--passWithNoTests` to both `test` and
`test:integration`. `scripts/check-vitest-projects.ts`'s own docblock states the identical
rationale — "A spec whose filename matches no Vitest project's `include` glob is not an error.
`--passWithNoTests` … prints green while executing none of it." The skill's one-line compression
is faithful to the mechanism it names.

### M1's routing of a stopped daemon to Blocked — supported, with one wording overlap

§3 defines Blocked as "name the blocker and its owner". The §1 cell says the daemon is "named as
the blocker (§3)" and defers to §3 for the rest, so the owner requirement carries. The two
sections agree on the status. No contradiction there.

The one thing worth recording: the word **"row"** is now overloaded across adjacent sections. §1's
cell says a daemon you cannot start is "not a row you drop"; §2 says "**A command that was not run
has no row.**" These are about different tables — §1's obligation list versus §2's evidence table —
and the correct reading is unambiguous once you notice that, but the two sentences sit ten lines
apart using the same noun in opposite directions. Not a contradiction and not a finding; noted so
nobody rediscovers it as one.

### The I2 clause — general, consistent, and it closes a loop

- **Genuinely general.** No mention of Phase 1, no mention of the current `pnpm test` clean-clone
  defect. It states a rule ("an exit criterion that says 'from a clean clone' is not proven by a
  warm tree") and quotes the criterion phrase as an example. The skill asserts nothing about
  whether that criterion currently passes, so it cannot go stale when Task 16 fixes it.
- **No conflict with §3's "zero exit for every command covering the claim."** It *defines*
  "covering" for the phase-status case rather than weakening it, and explicitly frames §1 as the
  default it overrides ("not the default list in §1").
- **No conflict with `sentinel-phase`.** It improves the pair: step 2 says "run its exit criteria"
  without saying what counts as running them; §3 now answers that. The two skills are more
  coherent after this fix than before it.

### The I3 edit — wording genuinely unchanged

The trailing text on disk is "Not afterwards, not at the end of the phase. A stale roadmap makes
the next session rebuild what exists or skip what does not." — **identical** to round 1, only
re-wrapped across lines 32-34. Nothing was quietly altered, softened or dropped.

One consequence, checked and dismissed: "Not afterwards" now sits after the new
`sentinel-verify` clause, so its nearest antecedent has changed. Both available readings ("update
the roadmap in the same change, not afterwards" and "run sentinel-verify first, not afterwards")
prescribe correct behaviour, so the ambiguity is harmless.

---

## NEW-1 — Minor. `sentinel-verify` §3 now miscounts its own §1 table.

`.claude/skills/sentinel-verify/SKILL.md` line 59, the closing sentence of the I2 paragraph:

> Five green rows from a warm tree are not a phase.

The I1 edit in this same fix round took §1 from five "Always" rows to **seven** (`format:check`,
`lint`, `typecheck`, `test`, `check:specs`, `test:integration`, `build` — counted on disk, lines
18-24). The I2 sentence was written against the pre-fix table — it echoes the "five zero exits"
phrasing from my round-1 write-up — and the two edits shipped together without reconciling.

Nothing behaves differently because of it: the sentence is a closing flourish, not an instruction,
and the rule above it is stated correctly. But it is a document asserting a number that is untrue
of the document, introduced while correcting something else — the branch's own defect class, in
miniature, inside the skill built to stop it. That is the only reason it is worth a line.

**Fix (one word, and the file is still uncommitted):** "Seven green rows…", or better, drop the
count — "A green default table is not a phase." — so the sentence cannot rot again the next time a
row is added.

---

## Residual I own, not a finding against the implementer

The `test:e2e` row is **conditional** ("The change touches `apps/web` or a response header") while
CI runs `test:e2e` unconditionally on every build. That condition is my own round-1 prescription,
quoted back verbatim, so the implementer did exactly what was asked. Recording the residual
honestly: a change under `packages/ui` or `packages/config` can reach the rendered page without
touching `apps/web`, and such a change would skip the row and still be caught red by CI — a
narrower version of the I1 gap. It is a defensible trade (the row costs minutes and a browser
download), and it is the controller's call, not a defect to reopen here.

## Observation, out of scope

`roadmap.md` carries `*Exit:*` criteria for Phases 1-5 only; Phases 6-12 have headings without
them. §3's new rule ("that phase's exit criteria as written in `roadmap.md`") is therefore
followable today and silently un-followable at Phase 6 until someone writes them. That is a
roadmap gap, not a skill gap, and the roadmap was explicitly out of scope for this task.

---

## Re-review verdict

**CLEAN — 0 open.**

I1, I2, I3 and M1 are all genuinely fixed in the tree, verified against the real `ci.yml`,
`playwright.config.ts`, `vitest.workspace.ts` and `package.json` rather than against the report's
description of them. Every quoted diff matches disk. Nothing round 1 approved was disturbed — both
frontmatter blocks and both plan tables are still byte-identical.

One new **Minor** (NEW-1, the stale "Five green rows") is recorded in the same spirit as M2-M6:
a one-word fix worth taking while the file is uncommitted, not a blocker.

Plan **Step 4 (discoverability)** remains the only thing standing between this task and done, and
it is a controller step. Until it passes, the honest status is Partially Implemented.
