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
