import { z } from 'zod';
import { organizationIdSchema } from './ids.js';
import { collectionEnvelopeSchema, listQuerySchema } from './pagination.js';
import { isoTimestampSchema } from './timestamps.js';

/**
 * The Prisma `OrganizationStatus` enum, restated for the wire.
 *
 * It has to be restated: `packages/contracts` must not depend on
 * `packages/db` — the dependency runs the other way, and the frontend imports
 * this package without a Prisma client anywhere near it. The values are
 * therefore duplicated ON PURPOSE and must match the enum exactly.
 *
 * The thing that HOLDS them equal is `packages/db/src/enum-parity.spec.ts`,
 * which reads the generated DMMF. `organizations.spec.ts` cannot: it has no
 * access to the schema, so all it does is pin this list against a literal
 * beside it, which catches an edit here and is blind to an edit in
 * `schema.prisma`. An earlier version of this comment claimed that spec made
 * "a change on one side without the other visible"; it did not, and a review
 * proved it by adding `ARCHIVED` to the Prisma enum and watching every
 * contracts-side spec stay green.
 */
export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export const organizationStatusSchema = z.enum(ORGANIZATION_STATUSES);

export const organizationNameSchema = z.string().trim().min(1).max(200);

/**
 * Lowercase kebab-case, and normalised rather than merely validated.
 *
 * `Organization.slug` is `@unique`, and as with `emailSchema` the database does
 * not case-fold: without the `.toLowerCase()` here, `Acme` and `acme` are two
 * organisations whose slugs collide the moment either is used in a URL. The
 * pattern refuses leading, trailing and doubled hyphens so a slug is stable
 * under any reasonable normalisation a proxy or a browser might apply.
 */
export const organizationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Use lowercase letters, digits and single hyphens, e.g. "acme-security".',
  });

export const createOrganizationRequestSchema = z
  .object({ name: organizationNameSchema, slug: organizationSlugSchema })
  .strict();

/**
 * `PATCH` takes the name and nothing else in Phase 2.
 *
 * `slug` is deliberately absent: it appears in URLs a customer has bookmarked
 * and in links already sent by email, so renaming it is a redirect problem
 * before it is a validation problem, and that design belongs to the task that
 * ships the endpoint. `requireMfa` and `enforcedEmailDomain` are absent for a
 * sharper reason — nothing enforces either until Task 12, and a security
 * setting a customer can switch on while no code reads it is worse than one
 * that is not offered at all.
 *
 * Adding an optional field to a `.strict()` request schema later is additive
 * under conventions.md §8; removing one is a breaking change. Absent is the
 * reversible direction.
 *
 * The refinement rejects `{}`. An empty patch is a request that cannot be
 * satisfied or refused meaningfully, and answering 200 to it teaches a client
 * that its no-op update worked.
 *
 * CONSTRAINT FOR WHOEVER ADDS THE NEXT FIELD: `.refine()` makes this a
 * `ZodEffects`, not a `ZodObject`, so `.extend()`, `.partial()` and `.merge()`
 * do not exist on it. Task 13 adding `requireMfa` or `enforcedEmailDomain`
 * must rebuild the object literal above and re-apply `.strict().refine(...)`,
 * not extend this export. Do NOT drop the refinement to make `.extend()`
 * available — that would silently re-admit the empty patch this rejects.
 */
export const updateOrganizationRequestSchema = z
  .object({ name: organizationNameSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const organizationResponseSchema = z.object({
  id: organizationIdSchema,
  slug: z.string(),
  name: z.string(),
  status: organizationStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

/**
 * `GET /api/v1/organizations` lists the caller's organisations.
 *
 * A named alias of the shared list query rather than the shared schema itself:
 * this endpoint's query is its own contract and will grow filters that the
 * membership and invitation lists do not want, and a named export lets that
 * happen without every call site changing.
 */
export const listOrganizationsQuerySchema = listQuerySchema;

export const organizationCollectionSchema = collectionEnvelopeSchema(organizationResponseSchema);

export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;
export type OrganizationCollection = z.infer<typeof organizationCollectionSchema>;
