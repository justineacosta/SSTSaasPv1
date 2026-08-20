# Resuming work in a new session

> **Status: Active process.** This is how any session — a new Claude Code session, a new
> engineer, or you six weeks from now — picks up the build without re-deriving context.

The project is designed so that **no knowledge lives only in a conversation**. Every decision
is in an ADR, every design is in `.claude/`, and the current state is in one file. A session
that reads three documents knows everything it needs.

## 1. Starting a phase

Open a session in the repository root and say what you want:

```
Start Phase 1.
```

That is enough. `CLAUDE.md` loads automatically and points at everything else. If you want to
be explicit:

```
Read .claude/product/roadmap.md for current status, then start Phase 1.
Follow .claude/development/coding-standards.md and the phase exit criteria.
```

## 2. What a resuming session must read first

In this order. It is roughly ten minutes of reading and it prevents every kind of drift.

| Order | Document | Answers |
|---|---|---|
| 1 | [`../../CLAUDE.md`](../../CLAUDE.md) | Identity, stack, critical rules, commands |
| 2 | [`../product/roadmap.md`](../product/roadmap.md) | **What is actually built, what is next, what is blocked** |
| 3 | [`../architecture/overview.md`](../architecture/overview.md) | How the pieces fit |
| 4 | The phase's own documents | Listed per phase in `overview.md` §8 |
| 5 | [`../decisions/`](../decisions/) | Why things are the way they are — read before proposing a change |

Then `git log --oneline -20` and `git status` for what happened most recently.

## 3. The rule that makes this work

**`roadmap.md` is the single source of truth for status, and it is updated in the same change
that moves the status.** Not afterwards, not at the end of the phase.

If that file goes stale, a resuming session will confidently build something that already
exists, or skip something that does not. Every other document describes design and changes
rarely; this one describes reality and changes constantly. It is the highest-maintenance file
in the repository and the most important one.

## 4. Ending a session cleanly

Before you stop, leave the repository in a state a stranger could resume from:

- [ ] Commit the work, even if the phase is incomplete — a branch with a clear message is a
      better handoff than an uncommitted working tree.
- [ ] Update [`../product/roadmap.md`](../product/roadmap.md): what moved, what is now blocked.
- [ ] Update any `.claude/` document whose subject changed
      ([`pull-request-rules.md`](pull-request-rules.md) — docs ship with the change).
- [ ] Write an ADR if an architectural decision was made.
- [ ] Note anything half-finished in the roadmap's phase detail, in plain words. "Auth module
      done except MFA enrolment; the TOTP secret is generated but not yet persisted" is worth
      more than any amount of inferred context.

A session that ends mid-task should leave a `WIP:` commit and a roadmap note. Neither is
tidy; both are recoverable.

## 5. Phase boundaries are the natural session boundary

Phases are sized so that each is a coherent unit of work with a verifiable end state. Starting
a phase in one session and finishing it in another is normal and expected. Starting *two*
phases at once is not — the exit criteria exist so that a phase either passes or does not, and
a half-finished Phase 3 underneath a half-finished Phase 4 makes both unverifiable.

## 6. Verify before claiming

A resuming session inherits the honesty rule. **Do not trust a status without checking it.** If
`roadmap.md` says Phase 2 is Implemented, run the tests and confirm before building Phase 3 on
top of it. The exit criteria in the roadmap are written to be executable checks, not
descriptions.

## 7. What does not carry over

Conversation history, reasoning that was never written down, and any decision discussed but not
recorded as an ADR. If something was worth deciding, it belongs in the tree before the session
ends — otherwise it will be re-litigated, and probably decided differently.
