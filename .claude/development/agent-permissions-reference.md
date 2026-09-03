# Agent permissions — the full catalogue

A menu to copy from, **not a file that is loaded**. The live rules are in
[`.claude/settings.json`](../settings.json); what is allowed there today and why is in
[`agent-permissions.md`](agent-permissions.md).

> **`settings.json` is strict JSON and has no comment syntax.** `//` in the live file does not
> disable a rule — it makes the file unparseable, and Claude Code fails *silently*: every setting
> in that file stops applying and nothing tells you. That is why this catalogue is a separate
> Markdown file. Copy the lines you want into the `allow` or `deny` array, without the `//`.
>
> Validate after every edit: `node -e "require('./.claude/settings.json')"` — it prints nothing on
> success and throws on malformed JSON.

## 1. How a rule is written

```
Tool                      // the whole tool, every invocation
Tool(specifier)           // narrowed — the specifier syntax depends on the tool
```

Three matching forms, and the difference matters:

```jsonc
// "Bash(pnpm test)"        exact  — matches `pnpm test` and NOT `pnpm test:integration`
// "Bash(gh pr merge:*)"    prefix — matches `gh pr merge` plus any arguments after it
// "Bash(git *)"            prefix — the older space form; both are accepted
// "Read"                   tool-only — every Read call
```

**Precedence:** `deny` beats `ask` beats `allow`. A command matching both an allow and a deny rule
is denied. Settings sources layer user → project → local, later overriding earlier.

## 2. The three buckets

```jsonc
// {
//   "permissions": {
//     "allow": [ ... ],   // run without asking
//     "deny":  [ ... ],   // refuse outright, overrides allow
//     "ask":   [ ... ]    // always prompt, even if an allow rule would have matched
//   }
// }
```

`ask` is the one most people forget. It is the right bucket for "I want to know every time" —
louder than leaving a rule out, because it survives a broad allow rule added later.

## 3. Bash — the tool worth most of your attention

Every entry below is a candidate. Nothing here is live unless it is also in `settings.json`.

### Git — read-only

```jsonc
// "Bash(git status:*)"
// "Bash(git log:*)"
// "Bash(git show:*)"
// "Bash(git diff:*)"
// "Bash(git branch:*)"
// "Bash(git tag:*)"
// "Bash(git remote:*)"
// "Bash(git rev-parse:*)"
// "Bash(git rev-list:*)"
// "Bash(git ls-tree:*)"
// "Bash(git ls-files:*)"
// "Bash(git ls-remote:*)"
// "Bash(git merge-base:*)"
// "Bash(git blame:*)"
// "Bash(git shortlog:*)"
// "Bash(git describe:*)"
// "Bash(git config --get:*)"
```

### Git — writes to the local repository

```jsonc
// "Bash(git add:*)"
// "Bash(git commit:*)"
// "Bash(git checkout:*)"          // can discard uncommitted changes: `git checkout -- <file>`
// "Bash(git switch:*)"
// "Bash(git restore:*)"           // discards uncommitted changes by design
// "Bash(git stash:*)"
// "Bash(git merge:*)"             // broad — allows merge commits
// "Bash(git merge --ff-only:*)"   // narrow — refuses anything but a clean fast-forward
// "Bash(git rebase:*)"            // rewrites local history
// "Bash(git cherry-pick:*)"
// "Bash(git revert:*)"
// "Bash(git apply:*)"
// "Bash(git worktree:*)"
```

### Git — outward-facing or destructive (deny candidates)

```jsonc
// "Bash(git push:*)"                    // ANY push, any remote, including --force
// "Bash(git push origin:*)"             // narrower: only the origin remote
// "Bash(git fetch:*)"
// "Bash(git pull:*)"                    // fetch + merge; can create merge commits
// "Bash(git push --force:*)"            // DENY — rewrites published history
// "Bash(git push -f:*)"                 // DENY — same thing, short flag
// "Bash(git push --force-with-lease:*)" // DENY — the "safe" force is still a force
// "Bash(git push --delete:*)"           // DENY — removes a remote branch
// "Bash(git reset --hard:*)"            // DENY — destroys uncommitted work
// "Bash(git clean -xdf:*)"              // DENY — deletes untracked and ignored files
// "Bash(git filter-branch:*)"           // DENY — rewrites all of history
// "Bash(git update-ref:*)"              // DENY — moves refs with no safety net
```

### GitHub CLI

```jsonc
// "Bash(gh pr view:*)"
// "Bash(gh pr list:*)"
// "Bash(gh pr checks:*)"
// "Bash(gh pr diff:*)"
// "Bash(gh pr status:*)"
// "Bash(gh pr create:*)"          // opens a PR — outward-facing
// "Bash(gh pr merge:*)"           // merges — the rule ruling 114 needed
// "Bash(gh pr close:*)"
// "Bash(gh pr comment:*)"         // posts publicly
// "Bash(gh pr review:*)"          // posts publicly
// "Bash(gh issue list:*)"
// "Bash(gh issue view:*)"
// "Bash(gh issue create:*)"       // outward-facing
// "Bash(gh issue comment:*)"      // outward-facing
// "Bash(gh run list:*)"
// "Bash(gh run view:*)"
// "Bash(gh run watch:*)"
// "Bash(gh run rerun:*)"          // spends CI minutes
// "Bash(gh run cancel:*)"
// "Bash(gh api:*)"                // BROAD — any REST call, including writes and DELETEs
// "Bash(gh api --method GET:*)"   // narrower: reads only
// "Bash(gh api --method DELETE:*)"// DENY
// "Bash(gh repo delete:*)"        // DENY
// "Bash(gh release delete:*)"     // DENY
// "Bash(gh release create:*)"     // publishes
// "Bash(gh secret set:*)"         // DENY — writes repository secrets
// "Bash(gh workflow run:*)"       // triggers CI
// "Bash(gh auth:*)"               // DENY — touches credentials
```

### This project's scripts

Exact matches, because `Bash(pnpm test)` does **not** match `pnpm test:integration`.

```jsonc
// "Bash(pnpm format:check)"
// "Bash(pnpm lint)"
// "Bash(pnpm typecheck)"
// "Bash(pnpm test)"
// "Bash(pnpm test:integration)"
// "Bash(pnpm test:e2e)"           // builds and starts the web app; slow
// "Bash(pnpm build)"
// "Bash(pnpm build:packages)"
// "Bash(pnpm check:specs)"
// "Bash(pnpm check:openapi)"
// "Bash(pnpm check:registry)"
// "Bash(pnpm check:secrets)"
// "Bash(pnpm install:*)"          // mutates node_modules and can run install scripts
// "Bash(pnpm add:*)"              // adds a dependency — a supply-chain decision
// "Bash(pnpm dev:*)"              // long-running
// "Bash(pnpm db:studio:*)"
// "Bash(pnpm db:migrate:*)"       // DENY — see agent-permissions.md; protocol §5 is a review gate
// "Bash(pnpm db:seed:*)"          // DENY — writes to the database
// "Bash(prisma migrate:*)"        // DENY — the same gate, reached directly
// "Bash(npx prisma:*)"            // DENY — and again by another path
```

### Containers and services

```jsonc
// "Bash(docker compose ps:*)"
// "Bash(docker compose logs:*)"
// "Bash(docker compose up -d:*)"
// "Bash(docker compose down:*)"   // DENY — stops the stack other work depends on
// "Bash(docker exec:*)"           // BROAD — arbitrary commands inside a container
// "Bash(docker rm:*)"             // DENY
// "Bash(docker volume rm:*)"      // DENY — deletes database volumes
// "Bash(docker system prune:*)"   // DENY
```

### Shell built-ins and filesystem

```jsonc
// "Bash(ls:*)"
// "Bash(cat:*)"
// "Bash(head:*)"
// "Bash(tail:*)"
// "Bash(wc:*)"
// "Bash(find:*)"
// "Bash(grep:*)"
// "Bash(rg:*)"
// "Bash(jq:*)"
// "Bash(node -e:*)"               // BROAD — arbitrary JavaScript
// "Bash(python:*)"                // BROAD — arbitrary Python
// "Bash(curl:*)"                  // BROAD — network egress, can exfiltrate
// "Bash(wget:*)"                  // BROAD — same
// "Bash(chmod:*)"
// "Bash(mv:*)"
// "Bash(cp:*)"
// "Bash(rm:*)"                    // DENY
// "Bash(rm -rf:*)"                // DENY
// "Bash(sudo:*)"                  // DENY
// "Bash(ssh:*)"                   // DENY
```

**A caution about breadth.** `Bash(node -e:*)`, `Bash(python:*)`, `Bash(docker exec:*)` and
`Bash(gh api:*)` each amount to "run anything" through a different door. Allowing one of those
makes most of the deny list above decorative — a denied `rm -rf` is no protection if
`node -e "fs.rmSync(...)"` is allowed. Grant them only if you mean to grant arbitrary execution.

## 4. File tools

Path specifiers accept gitignore-style globs. `//` prefixes an absolute path, `~` your home
directory, `./` a path relative to the project.

```jsonc
// "Read"                          // every read
// "Read(./src/**)"
// "Read(//etc/**)"                // DENY candidate
// "Read(~/.ssh/**)"               // DENY — private keys
// "Read(~/.aws/**)"               // DENY — cloud credentials
// "Read(./.env)"                  // DENY — this repo's real secrets
// "Read(./.env.*)"                // DENY
// "Edit"                          // every edit
// "Edit(./apps/**)"
// "Edit(./packages/**)"
// "Edit(./.claude/**)"            // lets the agent edit its own rules — consider ask/deny
// "Edit(./.github/workflows/**)"  // lets the agent edit CI — consider ask/deny
// "Edit(./.env)"                  // DENY
// "Write(./docs/**)"
// "Write(//tmp/**)"
// "Glob"
// "Grep"
// "NotebookEdit"
```

**`Edit(./.claude/**)` deserves a decision rather than a default.** It is the path by which an
agent can widen its own permissions. Putting it in `ask` is a reasonable middle: edits still
happen, but never without you seeing them.

## 5. Network and research tools

```jsonc
// "WebFetch"                             // any URL
// "WebFetch(domain:github.com)"          // one domain
// "WebFetch(domain:docs.anthropic.com)"
// "WebSearch"
```

## 6. Agent, task and session tools

```jsonc
// "Agent"                  // spawn subagents — this project uses them per task
// "Skill"                  // invoke skills (sentinel-phase, sentinel-verify, ...)
// "TodoWrite"
// "AskUserQuestion"
// "Artifact"               // publishes a page to claude.ai — outward-facing
// "SendMessage"            // message other sessions
// "ListAgents"
// "Monitor"
// "TaskOutput"
// "TaskStop"
// "SendUserFile"
// "PushNotification"
// "CronCreate"             // schedules recurring runs
// "CronDelete"
// "CronList"
// "RemoteTrigger"
// "EnterWorktree"
// "ExitWorktree"
// "EnterPlanMode"
// "ExitPlanMode"
```

## 7. MCP server tools

Two granularities — a whole server, or one tool on it. This project has no `.mcp.json`; the
servers below come from plugins enabled in your user settings.

```jsonc
// "mcp__plugin_context7_context7"                                  // the whole server
// "mcp__plugin_context7_context7__query-docs"                      // one tool
// "mcp__plugin_context7_context7__resolve-library-id"
// "mcp__plugin_playwright_playwright"                              // the whole server
// "mcp__plugin_playwright_playwright__browser_navigate"
// "mcp__plugin_playwright_playwright__browser_snapshot"
// "mcp__plugin_playwright_playwright__browser_click"
// "mcp__plugin_playwright_playwright__browser_take_screenshot"
// "mcp__plugin_playwright_playwright__browser_evaluate"            // BROAD — arbitrary JS in the page
// "mcp__plugin_playwright_playwright__browser_run_code_unsafe"     // DENY — the name is the warning
```

## 8. Settings that are not rules

These live beside `allow`/`deny`/`ask` inside `permissions`.

```jsonc
// "defaultMode": "default"            // prompt as normal
// "defaultMode": "plan"               // plan first, no edits
// "defaultMode": "acceptEdits"        // file edits without asking
// "defaultMode": "auto"               // classifier decides
// "defaultMode": "dontAsk"
// "defaultMode": "bypassPermissions"  // NO PROMPTS AT ALL — do not set this
//
// "disableBypassPermissionsMode": "disable"   // forbid bypass mode being turned on
// "blockReadsOutsideWorkingDirectories": true // refuse reads outside the project
// "disableAutoMode": "disable"
// "additionalDirectories": ["/some/other/repo"]
```

And at the top level of `settings.json`, outside `permissions`:

```jsonc
// "disableAllHooks": true          // no hooks or statusLine execution
// "disableSkillShellExecution": true
// "sandbox": { "enabled": true }   // run Bash inside a sandbox
```

## 9. What is live today

35 allow rules, 14 deny rules — the reasoning for each group is in
[`agent-permissions.md`](agent-permissions.md). Deliberately **not** granted: `Bash(git:*)`,
`Bash(pnpm:*)`, `Bash(*)`, `Edit(./.claude/**)`, `Bash(curl:*)`, `Bash(node -e:*)`, and
`defaultMode: "bypassPermissions"`.

Rules load at session start, so an edit takes effect in your **next** session.
