# Agent permissions

What Claude Code may do in this repository without stopping to ask, and — more importantly — what
it may never do. The rules live in [`.claude/settings.json`](../settings.json), which is **checked
into git**, so these grants apply to anyone who clones the repository and runs Claude Code here.

Added 2026-09-04, after carry-forward ruling 114 stopped three consecutive tasks at the same step:
`gh pr merge` was refused by the permission classifier at the end of Tasks 13, 14 and 15, and each
time a human had to finish the merge by hand.

## The principle

**Allow the loop the operator has already reviewed; deny anything that destroys work or changes a
database.** A rule earns its place by being something that happens every task and whose failure
mode is a wasted minute, not a lost afternoon. `deny` beats `allow`, so the deny list is a
backstop that holds even if an allow rule turns out to be broader than intended.

## What is allowed, and why

| Group | Rules | Why |
|---|---|---|
| **Merge the PR** | `gh pr merge`, `gh pr create` | The step ruling 114 kept blocking. Branch protection still applies — a push to `main` is only accepted when the commits carry a green PR, which is what made Task 15's merge legitimate rather than a bypass. |
| **Read CI and PR state** | `gh pr view`/`list`/`checks`/`diff`, `gh run list`/`view`/`watch` | Read-only. Ruling 105 requires reading a run's conclusion from its own field rather than assuming, and that means a lot of these calls. |
| **Publish a branch** | `git push origin:*`, `git fetch` | Without this the merge grant is useless — the flow is push, open PR, wait for CI, merge. Scoped to `origin` so it cannot push to a remote added later. |
| **Fast-forward only** | `git merge --ff-only` | The local half of the merge workaround. `--ff-only` refuses anything that is not a clean fast-forward, so it cannot silently create a merge commit or rewrite history. |
| **Read the repository** | `git status`, `log`, `show`, `diff`, `branch`, `rev-parse`, `rev-list`, `ls-tree`, `ls-files`, `ls-remote`, `merge-base` | All read-only. This is most of what the citation pass in every review actually runs. |
| **Run verification** | `pnpm format:check`, `lint`, `typecheck`, `test`, `test:integration`, `build`, `build:packages`, `check:specs`, `check:openapi`, `check:registry`, `check:secrets` | Exact matches, not prefixes — `Bash(pnpm test)` does not match `pnpm test:integration`, so both are listed and nothing else under `pnpm` is covered. These are the commands `sentinel-verify` requires, run several times per task. |
| **Check services** | `docker compose ps` | Read-only status. |

## What is denied, and why these specifically

| Rule | Why |
|---|---|
| `git push --force`, `-f`, `--force-with-lease` | Rewrites published history. `--force-with-lease` is the safe one and is still denied, because "safer force" is not a decision an agent should take alone. |
| `git push --delete` | Deleting a remote branch is not recoverable from the local clone alone. |
| `git reset --hard`, `git clean -xdf` | Both destroy uncommitted work with no undo. |
| `gh repo delete`, `gh release delete`, `gh api --method DELETE` | Irreversible and outward-facing. |
| **`pnpm db:migrate`, `pnpm db:seed`, `prisma migrate`** | **The important one.** The Phase 2 plan's execution protocol §5 requires the operator to read every migration's SQL *before* it touches a database. An allow rule here would silently repeal a review gate that has already caught real defects — both Task 15 migrations were reviewed as SQL first, and one of them fixed a latent Task 1 index defect precisely because a human read it. |
| `docker compose down` | Stops the stack other work depends on. |
| `rm -rf` | Obvious. |

## What is deliberately not granted

No blanket `Bash(git:*)`, no `Bash(pnpm:*)`, no `Bash(*)`, and no
`permissions.defaultMode: "bypassPermissions"`. Each would collapse every distinction above into
one grant. If a specific command is needed often enough to be worth allowing, add that command —
not the family it belongs to.

## Changing this

Delete any line you would rather be asked about; the file is a plain allowlist and removing an
entry restores the prompt. Rules take effect for **new sessions** — an already-running session has
its permissions loaded.

To keep a rule off the shared list, put it in `.claude/settings.local.json` instead and add that
filename to `.gitignore`; local settings override project settings and are meant to be personal.
