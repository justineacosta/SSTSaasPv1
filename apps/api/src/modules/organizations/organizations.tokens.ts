/**
 * The port token for ADR-0020's cross-organisation read.
 *
 * A token rather than a class, following `ACTIVE_ORGANIZATION_LOOKUP`: the
 * lookup is a closure over the base Prisma client, and the one place that
 * client reaches it is the factory in `organizations.module.ts`. Exposing the
 * one question rather than the client means `OrganizationService` cannot reach
 * `$queryRaw` for anything else.
 */
export const USER_ORGANIZATION_LOOKUP = 'SENTINEL_USER_ORGANIZATION_LOOKUP';
