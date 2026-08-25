import { z } from 'zod';
import { emailSchema } from './auth.js';
import { membershipIdSchema, organizationIdSchema, userIdSchema } from './ids.js';
import { collectionEnvelopeSchema, listQuerySchema } from './pagination.js';
import { PERMISSIONS, SYSTEM_ROLES } from './permissions.js';
import { isoTimestampSchema } from './timestamps.js';

/**
 * Roles come from `permissions.ts` and are never re-declared as a string list.
 *
 * `ROLE_PERMISSIONS` in that file is the canonical role -> permission mapping
 * and `product/permissions.md` is its rendering; a second copy of the role
 * names here would be a second thing to forget when a role is added, and the
 * forgotten one would silently reject a role the rest of the system honours.
 */
export const systemRoleSchema = z.enum(SYSTEM_ROLES);

/**
 * The Prisma `MembershipStatus` enum, restated for the wire for the same reason
 * `ORGANIZATION_STATUSES` is: contracts must not depend on the database
 * package.
 *
 * `memberships.spec.ts` pins this list against a literal beside it, which
 * catches an edit here and nothing else. The cross-check against
 * `schema.prisma` is `packages/db/src/enum-parity.spec.ts` — the db package is
 * the only side that can read both. See the note on `ORGANIZATION_STATUSES`.
 */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INVITED', 'REMOVED'] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);

/**
 * Just enough of the user to render a member row. Deliberately not the whole
 * `User`: a member list is readable by anyone with `organization.read`, and
 * fields like `lastLoginAt`, `failedLoginCount` and `lockedUntil` are the
 * account owner's business, not their colleagues'.
 */
export const membershipUserSchema = z.object({
  id: userIdSchema,
  email: emailSchema,
  name: z.string().nullable(),
});

export const membershipResponseSchema = z.object({
  id: membershipIdSchema,
  organizationId: organizationIdSchema,
  user: membershipUserSchema,
  roleKey: systemRoleSchema,
  status: membershipStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

/**
 * A member's role, and nothing else.
 *
 * `status` is NOT settable. Removal is a soft delete, and the database CHECK
 * constraint `Membership_status_deletedAt_agree_check` makes "REMOVED" and
 * "soft-deleted" one fact rather than two — a bare `status: 'REMOVED'` is an
 * invalid write. Exposing the column here would invite a client to ask for
 * half of a two-column invariant; removal is its own endpoint.
 */
export const updateMembershipRequestSchema = z.object({ roleKey: systemRoleSchema }).strict();

/** `GET /api/v1/organizations/{id}/members` — bounded, like every list. */
export const listMembershipsQuerySchema = listQuerySchema;

export const membershipCollectionSchema = collectionEnvelopeSchema(membershipResponseSchema);

/**
 * `GET /api/v1/roles` — the seeded system roles and their permissions, for the
 * UI's role picker.
 *
 * Addressed by `key`, never by the `Role` row's ID. That is why `rol` appears
 * on the db-only side of `id-prefix-parity.spec.ts`'s allowlist: a role is
 * reference data identified by a stable enum value, and handing clients a row
 * ID for it would invite them to store one.
 *
 * `isSystem` is on the response because custom per-organisation roles are
 * Phase 11: a client can already tell the two apart, so the field does not need
 * adding later to a shape clients have started depending on.
 */
export const roleResponseSchema = z.object({
  key: systemRoleSchema,
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.enum(PERMISSIONS)),
  isSystem: z.boolean(),
});

export const roleCollectionSchema = collectionEnvelopeSchema(roleResponseSchema);

export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
export type MembershipUser = z.infer<typeof membershipUserSchema>;
export type MembershipResponse = z.infer<typeof membershipResponseSchema>;
export type UpdateMembershipRequest = z.infer<typeof updateMembershipRequestSchema>;
export type ListMembershipsQuery = z.infer<typeof listMembershipsQuerySchema>;
export type MembershipCollection = z.infer<typeof membershipCollectionSchema>;
export type RoleResponse = z.infer<typeof roleResponseSchema>;
export type RoleCollection = z.infer<typeof roleCollectionSchema>;
