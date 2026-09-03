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
