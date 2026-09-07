# Task 15 — D9: Invitations are revoked when their issuer loses the authority to have issued them

**Implementer report.** Branch: `feat/phase-2-task-15-d9-invitation-revocation`.
Status vocabulary per CLAUDE.md §Honesty rule: Implemented / Partially Implemented /
Not Implemented / Blocked.

> This skeleton is committed FIRST, before any reading or implementation, per
> carry-forward ruling 131 (an agent whose deliverable is a document, and who writes
> the document last, delivers nothing when it dies). Every section below is filled in
> and committed as the work happens, not at the end.

## Status

**Not Implemented** — work not yet started at the time this skeleton was committed.

## What I was asked to build

Per `d9-brief.md` and ADR-0026 (Accepted, not re-litigated):

1. `MembershipService.remove` revokes **every** live invitation the removed member
   issued in that organisation, in the same transaction as the soft delete.
2. `MembershipService.updateRole` revokes the live invitations that member issued
   whose offered role carries a permission they do not hold after the change, and
   only those. Set comparison against seeded `RolePermission` rows, reusing the read
   `updateRole` already does for its own D5 check.
3. `InvitationService.create` re-resolves the actor's own live membership and role
   permissions inside its transaction and runs `assertActorMayGrant` against that set
   rather than against `ctx.permissions`.

Plus: one `INVITATION_REVOKED` audit event per revoked invitation, inside the same
transaction; correct `audit.actions.ts`'s now-false "written only for a deliberate
revocation through DELETE ..." sentence; rewrite the pinned D9 open-window test into a
guarantee.

## Log

- Skeleton created and committed before reading anything.
- Read `CLAUDE.md`, `d9-brief.md`, ADR-0026, and all seven target files plus the two
  integration specs' helper sections.

## Tests added

_(none yet)_

## Verification commands

| Command | Result | Evidence |
|---|---|---|
| `pnpm lint` | not run | |
| `pnpm typecheck` | not run | |
| `pnpm test` | not run | |
| `pnpm test:integration` | not run | |
| `pnpm check:specs` | not run | |
| `pnpm format:check` | not run | |

## Deviations from the brief

_(none yet)_

## Residual risks and open questions

_(none yet)_
