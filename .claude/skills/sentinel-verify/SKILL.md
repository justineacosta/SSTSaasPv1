---
name: sentinel-verify
description: Use before claiming any work is complete, implemented, working, or passing, and before moving a status in roadmap.md — runs the verification commands, captures their real output, and maps the result onto the Implemented / Partially Implemented / Not Implemented / Blocked vocabulary. Evidence before assertions.
---

# sentinel-verify

Turns a completion claim into captured evidence. Work through the steps in order before you
write the word "complete", "implemented", "working", or "passing" anywhere — a report, a commit
message, a `.claude/` document, or `roadmap.md`.

## 1. Run these, and read the output

Not "run these and glance at the last line". Read what they printed.

| Command | Run it when |
|---|---|
| `pnpm format:check` | Always. |
| `pnpm lint` | Always. |
| `pnpm typecheck` | Always. |
| `pnpm test` | Always. |
| `pnpm check:specs` | Always — a spec claimed by no Vitest project runs nothing while `--passWithNoTests` prints green. |
| `pnpm test:integration` | Always. Requires the compose stack: `docker compose up -d` first, with Docker Desktop running. If you cannot start it, that is a **Blocked** status with the daemon named as the blocker (§3) — not a row you drop. |
| `pnpm build` | Always. |
| `pnpm test:e2e` | The change can reach a rendered page or a response header — `apps/web`, but also `packages/ui`, `packages/config`, or middleware, none of which live under `apps/web`. Not free: it needs a Playwright browser (`pnpm --filter @sentinel/web exec playwright install --with-deps chromium`), and `playwright.config.ts` builds and starts the web app itself, so budget the minutes rather than skipping the row. |
| `docker compose ps` | The change touches a backing service (Postgres, Redis, MinIO, Mailpit). |
| `pnpm check:openapi` | The change touches the API. |
| `pnpm check:registry` | The change touches the API or the schema. |

Capture the real exit code of each. `$?` in bash, `$LASTEXITCODE` in PowerShell. A command whose
output you did not see did not run.

## 2. Build the evidence table

One row per command you actually ran:

| Command | Exit code | What it proves |
|---|---|---|

"What it proves" is specific to that command and no wider. `pnpm typecheck` exiting 0 proves the
types compile; it proves nothing about behaviour. **A command that was not run has no row.** Do
not add a row for a command you intended to run, expected to pass, or ran on an earlier tree.

## 3. Map to a status

Use specification §79's vocabulary, and only that vocabulary:

- **Implemented** — requires a zero exit for *every* command covering the claim. One non-zero
  exit, one command not run, one uncovered part of the claim: not Implemented.
- **Partially Implemented** — name the specific gap. "Auth done except MFA enrolment; the TOTP
  secret is generated but not persisted", not "mostly done".
- **Not Implemented** — the work does not exist. Say so plainly.
- **Blocked** — name the blocker and its owner.

When the claim is a **phase status**, the covering commands are that phase's exit criteria as
written in `roadmap.md`, not the default list in §1. Read them literally: an exit criterion that
says "from a clean clone" is not proven by a warm tree, where `node_modules`, build output and
generated clients already exist. Satisfy it as written — a scratch clone, or a `git clean -xdf`
equivalent — or record the gap and mark it **Partially Implemented**. A green table from a warm
tree is not a phase.

## 4. Write the status

Never write "Implemented" for a row with no evidence behind it. If the table is thinner than the
claim, shrink the claim — do not widen the table.

## 5. Cite before you claim

Every factual assertion about the state of this repository carries the command or file that
establishes it. Before writing a claim into a report, a document, or a commit message:

- **Name the source.** A command and its exit code, or a file path and the line you read there.
- **Verify work assigned to someone else.** Do not assume another agent's, another task's, or
  another commit's change landed. Open the file. Run `git log`/`git show` over the actual commit
  range and confirm the file appears in it.
- **A correction is a claim too.** Four of this branch's false claims were introduced *while
  correcting an earlier one*. Re-run the check after the fix; do not describe the fix from
  memory.

The concrete failure this encodes: the Task 14 fix-round report stated an item was "recorded in
the roadmap as owed" when `roadmap.md` had not been touched anywhere in that commit range. No
command catches this class. Only citation does.

## Red flags

| Thought | Reality |
|---|---|
| "The code looks right" | Not evidence. Run it. |
| "It worked last time" | Not evidence. The tree has changed. |
| "The test file exists" | A test that has not run has proven nothing. |
| "It's just a docs change" | Then `pnpm lint` costs eight seconds. Run it. |
| "CI will catch it" | CI catching it is you shipping a red branch. |
| "It's obviously fine" | Then the command will obviously pass. Run it. |
| "I recorded that elsewhere" / "the other task handled it" | Then open the file and find the line, or run `git show` over the range. An unverified claim about the repository is a false claim whether or not you meant it — and this is the one class no command catches. |
