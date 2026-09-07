# Task 15 — the D9 fix round: brief for the adversarial reviewer

> **A dated record of what was asked at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

**Date:** 2026-09-08 · **Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Range to review:** `53f40aa..HEAD` (nine commits, of which one is the orchestrator's ADR).

You are a **fresh reviewer**. You did not write this code and you owe it nothing. Your job is to
find what is wrong with it, and a review that finds nothing is a review that was not performed.

## What was built, in one paragraph

An invitation used to outlive the authority that created it: an `OWNER` could issue an `OWNER`
invitation, be removed, and the link would still mint an `OWNER` days later. ADR-0026 closes it
from the other side — `MembershipService.remove` revokes every live invitation the removed member
issued, `MembershipService.updateRole` revokes the ones whose offered role carries a permission
they no longer hold, both in the same transaction as the change, and `InvitationService.create`
re-resolves the actor's own membership and permissions **inside** its transaction so a `create` in
flight when the removal commits cannot slip past the cascade.

Read, in this order:
[`ADR-0026`](../../../../../.claude/decisions/ADR-0026-invitations-are-revoked-when-their-issuer-loses-the-authority-to-have-issued-them.md),
[`d9-brief.md`](d9-brief.md), [`d9-report.md`](d9-report.md), then the diff.

## The standard this repository holds a review to

**Two passes, and the citation pass is not optional.** Phase 1's single recurring defect was
agent-written prose asserting things that were not true — twelve instances, five of them
introduced while correcting an earlier one. So:

1. **A code pass.** Does it do what it claims, under concurrency, under RLS, cross-tenant?
2. **A citation pass.** Every factual claim in `d9-report.md`, in the new code comments, in
   ADR-0026, and in the `.claude/` document edits — check it against the thing it describes.
   Carry-forward ruling 129: **a citation a grep cannot resolve is a broken citation**, so grep
   every test name cited in a comment and confirm a test by exactly that name exists. Ruling 108:
   **when a sentence states a count, compute the count.** The orchestrator wrote ADR-0026 and the
   brief; findings against the orchestrator's own prose are the outcome this pass exists to
   produce, and two of Task 15's fourteen findings were exactly that.

**Write `d9-review.md` in this folder FIRST, before you review anything, and append each finding as
you land it, committing as you go.** Carry-forward ruling 131: the first reviewer on Task 15 was
killed by a session limit having completed its passes and written nothing, and all of it was lost.
The implementer's first attempt at *this* task died the same way. The document is your first
artefact, not your last.

Rank findings High / Medium / Low, and for each: what is wrong, how you established it (a command,
a probe, a measurement — not an intuition), and what it would cost if left. **Do not fix anything.**
Dispositions are the orchestrator's.

## Specific things to attack

The implementer volunteered these. Volunteered weaknesses are still weaknesses, and the fact that
somebody admitted one does not mean they measured it correctly — **verify each independently**:

- **"I tested the mechanism, not the race."** The two `create` re-read tests call the service
  directly with a stale `TenantContext`. Does the production path actually reach that code with a
  context that can be stale? Is `ctx.membershipId` the right key to re-resolve on — what happens to
  a member who was removed and re-added, and is `deletedAt: null` load-bearing there?
- **Two mutations survived.** Dropping `organizationId` from the cascade predicate (claimed: RLS
  refuses the rows anyway) and passing `new Set()` instead of `null` from `remove` (claimed: every
  seeded role holds at least one permission). Confirm both claims are true *and* that the code
  comments describe them honestly. Ruling 128: a mutation that cannot go red is a claim about the
  schema, and the claim must be written down.
- **A gap the ADR does not name**, per the implementer: an in-flight `create` by someone demoted
  `OWNER`→`MEMBER` can still land a `MEMBER` invitation, because only the no-minting rule is
  re-checked in-transaction, not the route's own `organization.manage_members`. Is that the whole
  gap, or is there more of it? What else does the guard decide that the transaction does not
  re-check?

And these, which nobody has claimed anything about:

- **The ES module cycle argument.** `memberships.module.ts` imports a *value* from
  `invitations/invitation-revocation.cascade.ts`, while `invitation.service.ts` imports values from
  `membership.service.ts`. Is the claimed acyclicity real at runtime, or does some other edge close
  the loop? `import type` erases — check that every import that had to be type-only actually is.
- **`LIVE_INVITATION` moved files.** Is there now exactly one production definition, and do all
  four call sites still mean the same thing? Does the partial unique index predicate still match it
  character for character?
- **The audit trail.** One event per revoked invitation, `actorId` = the remover. Is every event
  inside the transaction? Does a rolled-back removal leave any? Is anything logged or recorded that
  `security/audit.md` §5 forbids? Does the widened `INVITATION_REVOKED` docblock now describe every
  producer, including supersession's continued silence?
- **Cross-tenant and RLS.** The cascade writes to `Invitation` from a service in another module.
  Prove a member of organisation A cannot cause a revocation in organisation B. Prove the
  tenant-scoped client is what is being used.
- **Self-removal and the last-owner invariant.** A member who leaves voluntarily also loses their
  invitations. Is that tested, is it right, and does anything about the last-owner path interact
  with the cascade in a way nobody considered?
- **Order inside the transaction.** The cascade runs after the membership write and its audit
  event. Does anything depend on that order, and would a failure between them leave a coherent
  state?
- **What the tests actually prove.** For each of the eleven added tests, ask whether it would still
  pass if the feature were removed. An assertion that cannot fail is worse than a missing test,
  because it reads as coverage.

## Out of scope

Do not review `apps/web`. Do not re-litigate ADR-0026's decision — it is Accepted; if you think it
is wrong, say so as a finding with your reasoning and move on. Do not change any code.
