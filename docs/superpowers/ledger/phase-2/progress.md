# Phase 2 progress

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Plan: [`../../plans/2026-08-24-phase-2-identity.md`](../../plans/2026-08-24-phase-2-identity.md)
Branch: `feat/phase-2-identity`

## Task status

| # | Task | Mode | State |
|---|---|---|---|
| 1 | Identity schema, migrations, registry, Membership partial-unique fix | subagent | Not started |
| 2 | `packages/contracts` — identity contracts, Principal, TenantContext | subagent | Not started |
| 3 | Password hashing and the breach check | subagent | Not started |
| 4 | Single-use secret tokens | subagent | Not started |
| 5 | Mail infrastructure and templates | subagent | Not started |
| 6 | Session service | chained with 7 | Not started |
| 7 | Authentication guard, CSRF, CORS | chained with 6 | Not started |
| 8 | Registration and email verification | either | Not started |
| 9 | Login, logout, session endpoint, lockout | chained with 10 | Not started |
| 10 | Password reset | chained with 9 | Not started |
| 11 | TOTP MFA and recovery codes | subagent | Not started |
| 12 | Tenant resolution and the authorization guard | orchestrator | Not started |
| **A** | **Checkpoint — verify, push, CI green, status recorded** | orchestrator | Not reached |
| 13 | Organisations and organisation switching | chained 13→15 | Not started |
| 14 | Memberships, roles, last-owner invariant | chained 13→15 | Not started |
| 15 | Invitations | chained 13→15 | Not started |
| 16 | Web — authentication screens | chained with 17 | Not started |
| 17 | Web — app shell, org switcher, `/settings/security` | chained with 16 | Not started |
| 18 | E2E journey, doc audit, ADR sweep, roadmap | orchestrator | Not started |

## Carry-forward rulings

Nothing yet. Rulings from a task carry forward to every later task and are repeated here so a
fresh session does not have to read all previous entries to find them.

## Pause state

**2026-08-24 — planning complete, no code written.** The branch holds two commits: the plan and
roadmap entry, then the execution protocol, the Checkpoint A section, the distributed doc
ownership, and this ledger.

Phase 1 was re-verified at `40852c1` before planning (all four exit criteria, recorded in
`roadmap.md`). Docker Desktop was started during that session and the compose stack is up.

**Next action:** Task 1, in a new session, starting with `sentinel-phase`. Task 1's migration must
be generated with `--create-only` and its SQL reviewed by the operator before it is applied —
including the hand-written `ALTER TABLE "Session" RENAME COLUMN` and the partial unique index,
neither of which Prisma will produce correctly on its own.
