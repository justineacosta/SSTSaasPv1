---
name: sentinel-phase
description: Use when starting, resuming, or finishing a numbered Sentinel build phase — encodes the resuming-work protocol, including verifying a claimed status before building on it and updating roadmap.md in the same change that moves the status.
---

# sentinel-phase

The protocol in [`.claude/development/resuming-work.md`](../../development/resuming-work.md) as
an ordered checklist. Track each item as its own todo. Do not start at step 4.

- [ ] **1. Read, in this order.**
  1. `CLAUDE.md` — identity, stack, critical rules, commands.
  2. `.claude/product/roadmap.md` — what is actually built, what is next, what is blocked.
  3. `.claude/architecture/overview.md` — how the pieces fit.
  4. The phase's own documents — listed per phase in `overview.md` §8.
  5. Any relevant ADR in `.claude/decisions/` — read before proposing a change to a decision.

  Then `git log --oneline -20` and `git status` for what happened most recently.

- [ ] **2. Verify, do not trust.** For every earlier phase this one builds on that the roadmap
  calls Implemented, run its exit criteria. The exit criteria are written to be executable
  checks, not descriptions. A status is a claim until a command proves it. Use `sentinel-verify`.

- [ ] **3. Check the Blocked table.** If a blocker has cleared — as the Docker daemon did before
  Phase 1 — correct the roadmap before building on the assumption. A stale blocker sends the
  session down a workaround it does not need.

- [ ] **4. Build** on a `feat/` branch, test-first, committing frequently. Never commit to
  `main`.

- [ ] **5. Update `roadmap.md` in the same change that moves the status.** Run `sentinel-verify`
  first — the status you write is whatever its evidence table supports, and no more. Not
  afterwards, not at the end of the phase. A stale roadmap makes the next session rebuild what
  exists or skip what does not.

- [ ] **6. Update every `.claude/` document the change invalidated**, in the same change. API
  behaviour, schema, auth, authorization, the scanner contract, worker behaviour, billing,
  deployment, a security control — each has a matching document. Docs ship with the change.

- [ ] **7. Write an ADR** for any decision expensive to reverse, and add its row to
  `.claude/decisions/README.md`. Write it when the decision is made, not after the code. An ADR
  is immutable once accepted — supersede it, do not edit it.

- [ ] **8. End cleanly.** Commit even if the phase is incomplete — a `WIP:` commit with a clear
  message is a better handoff than an uncommitted working tree. Note anything half-finished in
  the roadmap's phase detail, in plain words: "auth done except MFA enrolment; the TOTP secret is
  generated but not persisted" is worth more than any amount of inferred context.

## Anti-patterns

| Anti-pattern | Why it hurts |
|---|---|
| Starting two phases at once | Exit criteria stop being answerable; a half-finished Phase 3 under a half-finished Phase 4 makes both unverifiable. |
| Updating the roadmap at the end | The window between building and recording is exactly when a session ends unexpectedly. |
| Trusting a status without running it | The roadmap is the most-edited file in the repository and therefore the most likely to be wrong. |
| Writing the ADR after the fact | An ADR written to justify what was built records a rationalisation, not a decision. |
| Marking a phase Implemented with one criterion unmet | Partially Implemented is a real, useful status. Use it. |
