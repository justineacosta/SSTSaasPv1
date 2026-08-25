import { z } from 'zod';
import { emailSchema, opaqueTokenSchema } from './auth.js';
import { invitationIdSchema, organizationIdSchema, userIdSchema } from './ids.js';
import { membershipResponseSchema, systemRoleSchema } from './memberships.js';
import { collectionEnvelopeSchema, listQuerySchema } from './pagination.js';
import { isoTimestampSchema } from './timestamps.js';

/**
 * An invitation names an address and a role, and nothing else.
 *
 * No `expiresAt`: the 7-day TTL is the server's, from
 * security/authentication.md §6. A caller who could set it could mint a
 * permanent invitation, which is a credential with no expiry.
 *
 * No `token`: it is generated server-side, only its SHA-256 hash is stored, and
 * the raw value goes to the invited address exactly once.
 *
 * The address goes through the shared `emailSchema`, so it is normalised the
 * same way `User.email` is. That matters here more than anywhere: acceptance
 * compares the invited address to the signed-in user's, and two casings of one
 * address would make that comparison fail for the person actually invited.
 */
export const createInvitationRequestSchema = z
  .object({ email: emailSchema, roleKey: systemRoleSchema })
  .strict();

/**
 * Acceptance carries the token and nothing else — in particular, not the
 * address. The invitation is bound to the address it was sent to, and the
 * server compares that stored address to the authenticated user's rather than
 * to a claim in the body. A body-supplied address would be the whole attack.
 */
export const acceptInvitationRequestSchema = z.object({ token: opaqueTokenSchema }).strict();

/**
 * NOTE WHAT IS NOT HERE: the token.
 *
 * Only a hash is stored, and the raw token reaches the invited address once. A
 * list endpoint that echoed it would hand everyone who can read the
 * organisation's invitations a working credential for somebody else's address.
 * Response schemas are not `.strict()`, so a handler that accidentally passed
 * a token-bearing row through this schema has it stripped rather than
 * serialised — `invitations.spec.ts` pins that.
 *
 * `acceptedAt` and `revokedAt` are nullable and always present, per
 * conventions.md §4: null means "not yet", absent would mean "not applicable".
 */
export const invitationResponseSchema = z.object({
  id: invitationIdSchema,
  organizationId: organizationIdSchema,
  email: emailSchema,
  roleKey: systemRoleSchema,
  invitedByUserId: userIdSchema,
  expiresAt: isoTimestampSchema,
  acceptedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});

/**
 * Accepting creates the `Membership` and consumes the invitation in one
 * transaction, so the created resource is what comes back —
 * conventions.md §4's "single resource returns the object at the top level".
 * The client needs the membership to render the organisation it has just
 * joined, and a bare acknowledgement would only force a second request.
 */
export const acceptInvitationResponseSchema = membershipResponseSchema;

/** `GET /api/v1/organizations/{id}/invitations` — bounded, like every list. */
export const listInvitationsQuerySchema = listQuerySchema;

export const invitationCollectionSchema = collectionEnvelopeSchema(invitationResponseSchema);

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
export type InvitationCollection = z.infer<typeof invitationCollectionSchema>;
