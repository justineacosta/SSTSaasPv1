import { withTenantTransaction } from '@sentinel/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRequestContext } from '../auth/request-context.js';

/** The transaction handle `withTenantTransaction` yields. */
type TenantTransaction = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

/**
 * "Live" for an invitation: neither accepted nor revoked.
 *
 * **It matches the partial unique index's predicate exactly**, and that is the
 * whole reason it is a shared constant rather than four inline object literals.
 * `Invitation_organizationId_email_live_key` is
 * `WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`; a query that used a
 * different definition of live would disagree with the constraint that enforces
 * uniqueness over it, and the disagreement would show up as a P2002 on a path
 * that had just checked there was nothing to collide with.
 *
 * **Expiry is deliberately not part of it**, for the same reason it is not part
 * of the index: a predicate mentioning `now()` is not IMMUTABLE and Postgres
 * refuses it. An expired row is still "live" by this definition and still holds
 * the slot, and `create`'s supersession is what frees it.
 *
 * # IT LIVES HERE RATHER THAN IN `invitation.service.ts`, AND THE MOVE IS THE
 * POINT
 *
 * It was a private const at the foot of that file until ADR-0026. This module
 * is the third writer of `Invitation.revokedAt` — `create`'s supersession and
 * `revoke` are the other two — and `invitations.module.ts` states the rule the
 * three are held to: acceptance and revocation cannot come to disagree about
 * what "live" means. The constant therefore has to sit where all three can
 * import it, and this file is the only one of the three that can be imported by
 * `memberships/` **without an ES module cycle**: `invitation.service.ts`
 * imports `membership.service.ts` (for `assertActorMayGrant`, `lockOrganization`
 * and `toMembershipResponse`), so nothing `membership.service.ts` can reach may
 * import it back. Hence this file imports nothing from `memberships/` at all,
 * not even a type.
 */
export const LIVE_INVITATION = { acceptedAt: null, revokedAt: null } as const;

/**
 * Why the issuer stopped being able to issue. It is written into the audit
 * event's `metadata` as `reason`, which is what tells a reader six months later
 * that a revocation had no direct actor beyond the person who moved the
 * membership.
 *
 * # `ISSUER_ROLE_CHANGED`, NOT `ISSUER_DEMOTED`, AND THE NAME IS THE POINT
 *
 * It was `ISSUER_DEMOTED` until the D9 review's Finding 10, and that name told
 * an investigator something that had not necessarily happened. The rule above
 * this one is a SET test against the seeded `RolePermission` rows, and the
 * seeded lattice is only PARTIALLY ordered — `AUDITOR` is incomparable with
 * `SECURITY_LEAD`, `MEMBER` and `VIEWER`, holding `audit.read` and
 * `billing.read` that none of them hold. So a **lateral** move revokes: a member
 * changed `MEMBER` → `AUDITOR` loses `MEMBER`'s non-`AUDITOR` permissions and
 * their pending `MEMBER` invitations die with them, although `AUDITOR` is not
 * below `MEMBER` in any order this codebase defines. Naming that a demotion
 * would put ranking vocabulary on the one rule the design insists is not a
 * ranking, and an investigator reading the trail would infer a demotion that
 * did not occur.
 *
 * `ISSUER_REMOVED` stays as it is: a removal is a removal under any ordering.
 */
export type InvitationRevocationReason = 'ISSUER_REMOVED' | 'ISSUER_ROLE_CHANGED';

export interface RevokeIssuedInvitationsInput extends AuthRequestContext {
  readonly organizationId: string;
  /** The member whose authority moved. Their invitations are the candidates. */
  readonly issuerUserId: string;
  /** The person who removed or demoted them, and the `actorId` of every event. */
  readonly actorUserId: string;
  readonly reason: InvitationRevocationReason;
  /**
   * The permissions the issuer still holds after the change, or `null` for
   * "they hold none, revoke everything".
   *
   * **`null` is not the empty set, and conflating the two is the defect
   * ADR-0026 §1 names.** A removed member holds no role at all; a predicate
   * that derived the empty set from the seeded rows would silently stop
   * revoking the day a role with no permissions is seeded, because every
   * offered role's permission list would then be a superset of nothing to
   * compare against. `null` says "do not compare".
   */
  readonly retainedPermissions: ReadonlySet<string> | null;
}

/**
 * The one capability behind `INVITATION_REVOCATION_CASCADE`. Returns the ids it
 * revoked, in creation order, so a caller can correlate and a spec can assert
 * that a rolled-back transaction left none of them written.
 */
export interface InvitationRevocationCascade {
  (tx: TenantTransaction, input: RevokeIssuedInvitationsInput): Promise<readonly string[]>;
}

/**
 * ADR-0026 — AN INVITATION DOES NOT OUTLIVE THE AUTHORITY THAT CREATED IT.
 *
 * D5 (`assertActorMayGrant` — *you cannot mint authority you do not possess*)
 * runs when an invitation is created and nowhere else. An invitation is the
 * durable artefact that check produces, and until this function existed nothing
 * invalidated the artefact when the authority behind it went away: an `OWNER`
 * could issue an `OWNER` invitation, be removed by another owner, and have the
 * link still mint an `OWNER` days later, through an address they control. That
 * is carry-forward ruling 130's shape in one sentence, and it was measured end
 * to end rather than inferred — see
 * `D9 — CLOSED BY ADR-0026: an invitation does NOT outlive its issuer’s
 * authority` in `invitations.integration.spec.ts`.
 *
 * # IT TAKES THE CALLER'S TRANSACTION AND OPENS NONE OF ITS OWN
 *
 * `CLAUDE.md` rule 10 and `security/audit.md` §2: the revocation and its audit
 * event belong to the transaction that took the authority away, so if the
 * demotion rolls back so do they. `AuditService.record` takes the same handle,
 * which is why this function needs the service rather than a client.
 *
 * # THE COMPARISON IS A SET TEST, NEVER A RANKING
 *
 * `assertActorMayGrant`'s docblock states the rule this obeys: a ranking
 * (`OWNER > ADMIN > ...`) is a second model of authority sitting beside the
 * seeded `RolePermission` rows, and the two drift the first time a permission
 * moves between roles. So the caller passes the permission set the issuer still
 * holds, read from the same seeded rows the authorization guard decides
 * against, and an invitation dies when the role it offers carries a permission
 * that set does not contain. A promotion revokes nothing, because the subset
 * test passes for every outstanding invitation.
 *
 * # THE WRITE IS CONDITIONAL, PER ROW, AND THAT IS WHAT DECIDES
 *
 * The read finds the candidates and decides nothing; each `updateMany` carries
 * `LIVE_INVITATION` again and only a row it actually moved gets an event. The
 * shape `revoke` and `TokenService.consume` use, for the same reason: a
 * `SELECT` followed by an unconditional `UPDATE` would write an
 * `INVITATION_REVOKED` for a row a concurrent `create` had already superseded
 * under its own advisory lock — an audit row claiming a revocation that did not
 * happen. Both callers hold the organisation lock, which serialises them
 * against each other but not against `create`, whose lock is on
 * `(organisation, address)`.
 *
 * # ONE EVENT PER INVITATION, ON THE INVITATION'S OWN ID
 *
 * Not one summary row on the `Membership`. `INVITATION_ACCEPTED`'s docblock
 * gives the reason: a reader following one invitation from one end of its life
 * to the other needs the event on that invitation's id. The consequence, stated
 * in ADR-0026, is that a removal no longer writes a constant number of audit
 * rows.
 *
 * # THE READ IS NOT PAGINATED, AND THAT IS A KNOWN BOUND
 *
 * It is bounded in practice by two things — one live invitation per
 * `(organizationId, email)` (the partial unique index) and the `invitations`
 * rate-limit class at 50/day per organisation — and it runs under the
 * organisation lock its callers already take, so it lengthens a transaction
 * that is already serialised per tenant. If a tenant is ever found with
 * thousands of outstanding invitations from one issuer, this is the read that
 * needs a bound.
 */
export function invitationRevocationCascade(audit: AuditService): InvitationRevocationCascade {
  return async (tx, input) => {
    // `organizationId` is named explicitly although the tenant-scoping
    // extension would inject it and RLS would refuse another tenant's row
    // anyway. Three layers, all stated, for the reason `membership.service.ts`
    // gives: a reader of this file should not have to know about either of the
    // other two to see which organisation is being asked about.
    const candidates = await tx.invitation.findMany({
      where: {
        organizationId: input.organizationId,
        invitedByUserId: input.issuerUserId,
        ...LIVE_INVITATION,
      },
      select: {
        id: true,
        email: true,
        role: {
          select: { key: true, permissions: { select: { permission: { select: { key: true } } } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const retained = input.retainedPermissions;
    const doomed =
      retained === null
        ? candidates
        : candidates.filter((candidate) =>
            candidate.role.permissions.some((grant) => !retained.has(grant.permission.key)),
          );

    const revoked: string[] = [];
    const revokedAt = new Date();
    for (const candidate of doomed) {
      const written = await tx.invitation.updateMany({
        where: { id: candidate.id, organizationId: input.organizationId, ...LIVE_INVITATION },
        data: { revokedAt },
      });
      // Zero means a concurrent `create` superseded this row between the read
      // above and this statement. Nothing to record: the row is already out of
      // the live set, and `MEMBER_INVITED.supersededInvitationId` is where that
      // outcome is written.
      if (written.count === 0) continue;

      await audit.record(tx, {
        organizationId: input.organizationId,
        actorType: 'USER',
        // The person who removed or demoted the issuer, not the issuer. That
        // is what keeps this one action rather than two: a reader who finds a
        // cascade revocation can still find a human behind it.
        actorId: input.actorUserId,
        action: 'INVITATION_REVOKED',
        resourceType: 'Invitation',
        resourceId: candidate.id,
        // `email` and `roleKey` match what a deliberate revocation writes, so
        // one reader reads both. `reason` and `issuerUserId` are what
        // distinguish this from somebody pressing the revoke button — an
        // invitation id is meaningless six months later and the issuer may by
        // then have several `Membership` rows, which is why the user id is
        // recorded rather than the membership id.
        metadata: {
          email: candidate.email,
          roleKey: candidate.role.key,
          reason: input.reason,
          issuerUserId: input.issuerUserId,
        },
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: input.requestId,
      });
      revoked.push(candidate.id);
    }

    return revoked;
  };
}
