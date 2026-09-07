/**
 * Injection tokens local to the memberships module.
 *
 * Strings rather than symbols, for the reason `infrastructure/tokens.ts` gives:
 * an unresolved dependency names itself in Nest's boot error instead of
 * printing `Symbol(...)`.
 */

/**
 * "Revoke this user's sessions for this organisation, and only for this
 * organisation."
 *
 * A port rather than `SessionService` itself, on the rule
 * `organizations.module.ts` states for `OrganizationService`: a consumer
 * holding the whole service could mint a session, rotate one, or revoke every
 * session a user has anywhere. `MembershipService` needs exactly one of its
 * twenty methods, so it is handed exactly one.
 *
 * The narrowing is not cosmetic here. `SessionService.revokeAllForUser` and
 * `revokeAllForUserInOrganization` differ by one argument and by whether a
 * consultant removed from one organisation stays signed in to the other three
 * — carry-forward ruling 95, and the difference between a removal and a
 * lock-out. A service that cannot reach the wider method cannot call it by
 * mistake.
 */
export const MEMBER_SESSION_REVOKER = 'SENTINEL_MEMBER_SESSION_REVOKER';

/**
 * The one capability behind {@link MEMBER_SESSION_REVOKER}. Returns the number
 * of sessions revoked, which is what the caller logs rather than what it acts
 * on: zero is a member who was not signed in, not a failure.
 */
export interface MemberSessionRevoker {
  (userId: string, organizationId: string): Promise<number>;
}

/**
 * "Revoke the live invitations this member issued that they could no longer
 * issue now, inside this transaction."
 *
 * ADR-0026. `MembershipService` is the only consumer, and it is handed one
 * function over the transaction handle rather than `InvitationService` — which
 * could invite, list, revoke by id or accept. The discipline is
 * {@link MEMBER_SESSION_REVOKER}'s above, and the reason is sharper here than
 * usual: this is a second module writing to `Invitation`, a table another
 * module owns, and ADR-0026 records that coupling as a real cost. A port whose
 * type is a single function is the narrowest form that coupling can take.
 *
 * **The interface lives with the implementation rather than beside this
 * constant**, which is the one place this file departs from
 * {@link MEMBER_SESSION_REVOKER}'s shape. `InvitationRevocationCascade` is
 * declared in `invitations/invitation-revocation.cascade.ts` because that file
 * must import nothing from `memberships/` — `invitation.service.ts` imports
 * `membership.service.ts`, so an import in the other direction from anything
 * `membership.service.ts` can reach is an ES module cycle, and a cycle in ESM
 * does not always fail loudly. `membership.service.ts` takes the type with
 * `import type`, which TypeScript erases, so **the service** carries no runtime
 * edge from `memberships/` into `invitations/`.
 *
 * **There is exactly one such runtime edge, and it is this module's factory.**
 * `memberships.module.ts` imports `invitationRevocationCascade` — a value —
 * from `../invitations/invitation-revocation.cascade.js`. The claim that
 * matters is not that no edge exists but that **no cycle** does: nothing in
 * `invitations/` imports `memberships.module.ts`, and
 * `invitation-revocation.cascade.ts` imports only `@sentinel/db`,
 * `audit/audit.service.js` and a type from `auth/request-context.js`. This
 * docblock said "no runtime edge … at all" until the D9 review's Finding 3,
 * and a reader who believed the absolute version would not look for the
 * module-level edge when reasoning about a future cycle — which is the whole
 * argument this port rests on. The provider factory is in
 * `memberships.module.ts` alongside the session revoker's.
 */
export const INVITATION_REVOCATION_CASCADE = 'SENTINEL_INVITATION_REVOCATION_CASCADE';
