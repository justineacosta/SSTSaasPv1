# Task 15 — the D9 fix round: an invitation must not outlive its issuer's authority

> **A dated record of what was asked at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

**Date:** 2026-09-07 · **Mode:** subagent implementer, fresh adversarial reviewer
**Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Decision already taken and not open for re-litigation:**
[`ADR-0026`](../../../../../.claude/decisions/ADR-0026-invitations-are-revoked-when-their-issuer-loses-the-authority-to-have-issued-them.md)
— read it in full before writing a line. It records the alternatives and why each lost.

## The defect

Measured in Task 15 and carried for three tasks as the highest-value open security item in Phase 2:

> An `OWNER` issues an invitation offering `OWNER`, is removed from the organisation by another
> owner, and the invitation is **still live**. The acceptor receives `201` with `roleKey: OWNER`.

D5 (`assertActorMayGrant` — *you cannot mint authority you do not possess*) runs in
`InvitationService.create`, `MembershipService.updateRole` and `MembershipService.remove`, and
nowhere else. An invitation is the durable artefact that check produces, and **nothing invalidates
the artefact when the authority behind it goes away** (carry-forward ruling 130).

It is pinned today by a test named to be read as a defect, not a guarantee:
`D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's authority` in
`apps/api/src/modules/invitations/invitations.integration.spec.ts`. **That test's rewrite is the
record that the window was closed deliberately**, and rewriting it is part of this task.

## What to build

Three things, all in `apps/api`. ADR-0026 is the authority on each; this is the checklist.

1. **`MembershipService.remove` revokes every live invitation the removed member issued in that
   organisation**, in the same transaction as the soft delete.
   Unconditional — *not* "every invitation whose role exceeds what they now hold". A removed
   member holds no role at all, and a predicate that derived the empty set from `ROLE_PERMISSIONS`
   would silently stop revoking the day a role with no permissions is seeded.

2. **`MembershipService.updateRole` revokes the live invitations that member issued whose offered
   role carries a permission they do not hold after the change**, and only those.
   - `OWNER` → `MEMBER`: their pending `OWNER` and `ADMIN` invitations go; a pending `MEMBER`
     invitation stays, because they could still issue it today.
   - Any promotion revokes nothing — the subset test passes.
   - The comparison is `assertActorMayGrant`'s: a **set** comparison against the seeded
     `RolePermission` rows, never a ranking. Two models of authority in one codebase is the drift
     that helper's docblock exists to prevent. `updateRole` has already read the new role's
     permissions for its own D5 check — reuse that read, do not issue a second one.

3. **`InvitationService.create` re-resolves the actor's own live membership and role permissions
   inside its transaction**, and runs `assertActorMayGrant` against that set rather than against
   `ctx.permissions`.
   Without this, 1 and 2 close only the front door: `TenantContextGuard` reads the actor's
   membership *before* the handler runs, so a `create` already in flight when the removal commits
   inserts a fresh invitation from a member who no longer exists, and the `updateMany` in 1 cannot
   revoke a row that did not exist when it ran. **This is carry-forward rulings 82 and 122 for the
   third time** — *"the endpoint checks first" is not sufficient* — and the ledger has struck that
   reasoning down twice already. An actor with no live membership by then gets the same refusal as
   any other principal who cannot grant the role.

### The audit trail

Each revoked invitation gets its **own** `INVITATION_REVOKED` event, inside the same transaction,
`resourceId` = the `Invitation`, `actorId` = the person who removed or demoted the issuer, and a
`reason` in `metadata` naming the cause. Per-invitation rather than one summary row on the
`Membership`: `INVITATION_ACCEPTED`'s docblock states the reason — a reader following one
invitation from one end of its life to the other needs the event on that invitation's id.

`audit.actions.ts`'s `INVITATION_REVOKED` docblock currently says it is **"Written only for a
deliberate revocation through `DELETE /organizations/:id/invitations/:invitationId`"**. That
sentence becomes false in this change and must be corrected in the same change — it is exactly the
class of stale-comment defect this ledger keeps recording. Supersession still writes no event; do
not change that.

## Where the code goes, and the one cycle to avoid

`invitation.service.ts` already imports from `../memberships/membership.service.js` (line 25). **Do
not import `membership.service.ts` from any file that `membership.service.ts` imports** — that is
an ES module cycle, and it will not always fail loudly.

Put the cascade in a **new standalone file in the invitations module** that imports nothing from
`memberships/`, export a single function over the transaction handle, and have `MembershipService`
call it. The port discipline to copy is `MEMBER_SESSION_REVOKER` in `memberships.tokens.ts` and its
factory in `memberships.module.ts`: `MembershipService` is handed one capability, not a service
that could invite, accept or list. Whether that arrives as a Nest token or as a direct function
import is yours to argue — **state which you chose and why in the report**; if it is a token, the
factory belongs in `memberships.module.ts` alongside the existing one.

**There must be exactly one definition of "live invitation".** `LIVE_INVITATION` is currently a
private const at the bottom of `invitation.service.ts`. A second copy in a second file is the
drift that `invitations.module.ts`'s "acceptance and revocation cannot come to disagree about what
live means" paragraph exists to prevent. Share the one that exists.

## Test first. The tests are the deliverable as much as the code.

Integration, against a real Postgres via Testcontainers, in the existing spec files. At minimum:

- **The D9 test, rewritten into a guarantee.** Same scenario, opposite assertion: after the issuer
  is removed through the real `DELETE .../members/:membershipId`, accepting the token **fails**,
  and the `Invitation` row carries `revokedAt`. Rename it so nothing still calls it an open
  window, and say in the comment that it was a pinned defect closed by ADR-0026 — carry-forward
  ruling 129: **cite a test by its name, not a paraphrase**, so if you cite it elsewhere, grep for
  your own citation afterwards.
- **Demotion is partial.** `OWNER` demoted to `MEMBER` with three live invitations they issued —
  `OWNER`, `ADMIN`, `MEMBER` — leaves exactly the `MEMBER` one live.
- **Promotion revokes nothing.**
- **Someone else's invitations are untouched.** An invitation issued by a *different* member to
  the same organisation survives the removal. This is the mutation most likely to pass a weak test.
- **Cross-tenant.** The same user is a member of two organisations and has a live invitation in
  each; removal from one leaves the other's invitation live. `organizationId` must be in the
  predicate even though RLS would refuse the row anyway — three layers, all stated, as every other
  statement in these two files does.
- **The audit rows exist**, one per revoked invitation, inside the same transaction — assert the
  count and the `resourceId`s, not just that something was written.
- **The freed slot works.** A revoked invitation releases `(organizationId, email)` in the partial
  unique index, so re-inviting that address afterwards succeeds. Ruling 126 is about exactly this
  index; do not assume, assert.
- **The rollback.** If the transaction fails after the cascade, no invitation is revoked. Rule 10
  and `security/audit.md` §2 — the audit row and the change live or die together.
- **The in-flight create (item 3)** — a unit or integration test that a `create` whose actor's
  membership has gone inside the transaction is refused. If you cannot construct the true race
  deterministically, test the mechanism directly and **say in the report that you tested the
  mechanism and not the race**. Do not describe a test as proving something it does not.

## Out of scope. Do not touch these.

- **`POST /api/v1/invitations/accept` gets no new authority check.** ADR-0026 rejects re-running
  D5 at accept time, twice over. Do not add it "for defence in depth".
- **No new email.** Nothing notifies an invitee that their link died. That cost is stated in the
  ADR and accepted.
- **No schema change and no migration.** `Invitation.revokedAt` already exists and is the column
  this uses.
- **`apps/web`** — nothing. The screens are Task 17's and Task 18's.
- **No new audit action name.** Widen `INVITATION_REVOKED`'s meaning; do not add a sibling.

## Commands, and the standard that applies to your report

Run these from the repository root. Docker Desktop is up; all four services were healthy at
2026-09-07.

```
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm check:specs
pnpm format:check
```

**Capture the exit code outside a pipe** — `out=$(pnpm <cmd> 2>&1); code=$?` — carry-forward ruling
105: read the result from the run's own field, never from a summary you wrote.

Your report is `d9-report.md` in this folder. **Create it before you write any code and append to
it as you go** (carry-forward ruling 131: an agent whose deliverable is a document must write the
document first, or a session limit destroys the whole task). Commands and exit codes, not prose.

**The honesty rule is the one that matters.** Never write that something passes, works, or is
covered unless you have run it and read the output. If a test you expected to go red stayed green,
that is a finding about the schema, not a nuisance to work around — ruling 128 exists because a
CHECK constraint made two mutation branches equivalent and a report claimed a red run that never
happened. Report what happened.
