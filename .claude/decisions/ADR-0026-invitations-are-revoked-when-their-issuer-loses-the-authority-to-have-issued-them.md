# ADR-0026: An invitation is revoked when its issuer loses the authority that created it

**Status:** Accepted · **Date:** 2026-09-07

## Context

Task 15 shipped invitations and, with them, an open security window that has been carried in
`roadmap.md` for three tasks and pinned by a test named to be read as a defect:
`D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's authority`
(`apps/api/src/modules/invitations/invitations.integration.spec.ts`).

**Measured, not inferred**, end to end through Task 14's real
`DELETE /api/v1/organizations/:id/members/:membershipId`: an `OWNER` issues an invitation offering
`OWNER`, is then removed by another owner, and the invitation is still live days later — the
acceptor receives `201` with `roleKey: OWNER`.

The rule that should have stopped it is D5, `assertActorMayGrant`: *you cannot mint authority you
do not possess* (`security/authorization.md` §4). D5 runs in `InvitationService.create` and in
`MembershipService.updateRole` and `remove`, and **nowhere else**. An invitation is the durable
artefact that check produces, and nothing invalidated the artefact when the authority behind it
went away. That is carry-forward ruling 130's shape in one sentence: *an authority check at issue
time creates a durable artefact; something has to invalidate the artefact.*

The window is a re-escalation path for exactly the person the removal existed to disempower,
through an email address they control.

## Decision

**The membership writes revoke the invitations their subject could no longer issue, in the same
transaction as the change that takes the authority away.**

1. `MembershipService.remove` revokes **every** live invitation the removed member issued in that
   organisation. Unconditional, and deliberately not "every invitation whose role exceeds what
   they now hold": a removed member holds no role at all, and a predicate that computed the empty
   set from `ROLE_PERMISSIONS` would silently stop working the day a role with no permissions is
   seeded.

2. `MembershipService.updateRole` revokes the live invitations that member issued **whose offered
   role carries a permission they do not hold after the change**, and only those. A demotion from
   `OWNER` to `MEMBER` revokes their pending `OWNER` and `ADMIN` invitations and leaves a pending
   `MEMBER` invitation alone, because they could still issue that one today. A promotion revokes
   nothing, because the subset test passes.

3. **`InvitationService.create` re-resolves the actor's own role inside its transaction** and
   runs `assertActorMayGrant` against *that* permission set rather than against `ctx.permissions`.
   Without this, points 1 and 2 close only the front door: `TenantContextGuard` reads the actor's
   membership before the handler runs, so a `create` already in flight when the removal commits
   inserts a fresh invitation from a member who no longer exists — and the `updateMany` above
   cannot revoke a row that did not exist when it ran. This is carry-forward ruling 82 and 122's
   shape for the third time (*"the endpoint checks first" is not sufficient*), and it is closed
   here rather than recorded as owed, because a cascade that a concurrent request can walk around
   is not a control.

   The re-read costs one query against a row the transaction will already have contended for, and
   it makes the check that refuses and the fact it is checking come from the same snapshot. An
   actor whose membership has gone by then receives the same refusal as any other principal who
   cannot grant the role.

The comparison is `assertActorMayGrant`'s — a set comparison against the seeded
`RolePermission` rows, not a ranking — so the rule that revokes and the rule that refuses cannot
drift into two models of authority.

**Each revocation writes its own `INVITATION_REVOKED` audit event**, inside the same transaction,
with the acting user as `actorId` and a `reason` in `metadata` naming the cause. `resourceId` is
the `Invitation`, which is what a reader follows from one end of its life to the other.

**`INVITATION_REVOKED`'s meaning widens and its docblock says so.** It previously meant "a person
revoked a pending invitation through `DELETE .../invitations/:invitationId`" and nothing else. It
now also covers the cascade — which still has a person behind it, the one who removed or demoted
the issuer, so a reader who finds one can still find the actor. That is the property that keeps it
one action rather than two. Supersession by a newer invitation to the same address continues to
write **no** event; that is the case with no actor, and it stays recorded as a field of
`MEMBER_INVITED` instead.

## Alternatives considered

**Re-run `assertActorMayGrant` at accept time, against the issuer's current membership.** Rejected
in Task 15 and rejected again here. It refuses every invitation from a colleague who has since
legitimately left, and it refuses it at the worst possible moment: the invitation is still listed
as live to the organisation's admins, the email still works up to the final step, and the invitee
receives an opaque refusal that nobody in the organisation is notified of. Revoking at the moment
the authority moves fails in the opposite direction — earlier, visibly, and in a list any holder
of `organization.manage_members` can read.

**Do nothing, and rely on the last-owner invariant and the removal being noticed.** Rejected. The
invariant guarantees an organisation keeps an owner; it says nothing about a removed one returning
through an address they control. Nothing else observes the invitation.

**A background sweeper that expires invitations whose issuer is no longer a member.** Rejected on
the same reasoning `audit.actions.ts` gives for the absence of `INVITATION_EXPIRED`: there is no
scheduler and no queue in this codebase until Phase 4, and a sweeper would write the change outside
the transaction that caused it, which `CLAUDE.md` rule 10 and `security/audit.md` §2 forbid for a
security-relevant action.

**Revoke on any membership change whatsoever, including promotion.** Rejected as security theatre
that costs invitees real work: a promoted member could still issue every invitation they have
outstanding, so revoking them invalidates nothing dangerous and forces a re-invite.

## Consequences

**Positive.** The highest-value open security item in Phase 2 closes, and it closes at the moment
the fact moves rather than at redemption. The D9 test is rewritten from a pinned defect into a
guarantee, and the rewrite is the record that it was closed deliberately. `security/authentication.md`
loses the paragraph recording an open window.

**Negative — and this is a real cost, not a rounding error.** A member who leaves for entirely
benign reasons takes their outstanding invitations with them, and every invitee who had not yet
accepted must be re-invited by somebody else. The organisation learns this only by reading the
invitation list or the audit trail; **nothing emails the invitee to say the link they were sent no
longer works**, and this ADR does not add such a mail. An invitee who clicks a revoked link gets
the same refusal as one presenting a token that matches nothing, which is the correct behaviour for
the token and an unhelpful experience for the person.

**Negative.** `remove` and `updateRole` each grow a read of the live invitations the subject
issued. It is not paginated. It is bounded in practice by two things — one live invitation per
`(organizationId, email)` (the partial unique index), and the `invitations` rate-limit class at
50/day per organisation — and it runs under the organisation lock these methods already take, so
it lengthens a transaction that is already serialised per tenant. If a tenant is ever found with
thousands of outstanding invitations from one issuer, this is the read that needs a bound.

**Negative.** `MembershipService` now writes to `Invitation`, a table owned by another module. The
coupling is deliberate and narrow — a single function taking the transaction handle, on the same
port discipline `MEMBER_SESSION_REVOKER` follows — but it is a second module that can change an
invitation's state, and "acceptance and revocation cannot come to disagree about what live means"
now has a third party to keep in step.

**Neutral.** The cascade writes one audit row per invitation revoked, so a removal that used to
write exactly one `MEMBER_REMOVED` event may now write several rows in one transaction. That is
the intended shape — a reader following one invitation needs the event on that invitation's id —
and it means audit volume for a removal is no longer constant.
