/**
 * Injection tokens local to the invitations module.
 *
 * Strings rather than symbols, for the reason `infrastructure/tokens.ts` gives:
 * an unresolved dependency names itself in Nest's boot error instead of
 * printing `Symbol(...)`.
 */

/**
 * "Send this one invitation message, and tell nobody if it fails."
 *
 * A port rather than `InvitationMailerAdapter` itself, on the rule
 * `memberships.module.ts` states for `SessionService` and
 * `organizations.module.ts` for `OrganizationService`. It is a narrow port over
 * something already narrow — the adapter has one method — because the boundary
 * that matters is the type `InvitationService` is written against: a service
 * whose collaborator is a function cannot grow a second send by autocompleting
 * one, and cannot be handed `AuthMailer` in a later refactor without the
 * signature refusing.
 *
 * **The signature carries no display name, and that is the control.**
 * Carry-forward rulings 70 and 85: `renderInvitation` accepts no `inviterName`
 * — the fifth channel of that defect was this very template — and there is no
 * parameter here for one to travel through either. The inviter is recorded in
 * the `MEMBER_INVITED` audit row, which an operator reads, not in a message a
 * stranger reads.
 *
 * **`token` is the raw secret, returned once by `mintSecretToken`.** It is in
 * this signature and in the link the template builds, and nowhere else: not in
 * the row, not in a log line, not in the audit event's metadata.
 */
export const INVITATION_MAILER = 'SENTINEL_INVITATION_MAILER';

/** The one capability behind {@link INVITATION_MAILER}. */
export interface InvitationMailer {
  (input: {
    readonly to: string;
    readonly token: string;
    readonly organizationName: string;
  }): Promise<void>;
}

/**
 * "Which organisation does this invitation token belong to?"
 *
 * A port over `invitationOrganizationLookup`, provided as a token for the
 * reason `USER_ORGANIZATION_LOOKUP` is: the query behind it is one of the two
 * in this product that run **outside** a tenant transaction, against a
 * `SECURITY DEFINER` function that bypasses row-level security (ADR-0022). A
 * service that received the base Prisma client could make any other query with
 * it; a service whose collaborator is a single function taking a token hash and
 * returning an organisation id can make exactly this one.
 *
 * **It returns a routing hint, not a permission.** See
 * `invitation-organization.store.ts`: liveness, expiry and the invited-address
 * binding are all decided afterwards, under RLS, inside the tenant transaction
 * the returned id opens.
 */
export const INVITATION_ORGANIZATION_LOOKUP = 'SENTINEL_INVITATION_ORGANIZATION_LOOKUP';
