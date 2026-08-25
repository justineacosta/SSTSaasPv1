import type { Permission, SystemRole } from './permissions.js';

/**
 * WHICH TENANT THIS REQUEST IS ACTING IN, and what the caller may do inside it.
 *
 * A `Principal` says who; this says where and what. Authorization in this
 * product is always the triple (user, organization, permission) and never the
 * pair (user, permission) — `architecture/database.md` §2 — so the two are
 * resolved by two different pipeline stages and modelled as two different
 * types. Handlers receive this, and the tenant-scoped Prisma client is bound to
 * its `organizationId`.
 *
 * A PLAIN TYPE, NOT A ZOD SCHEMA, for the reason given at the top of
 * `principal.ts`: it is built server-side from trusted database state and never
 * parsed from an external input. There is a second, mechanical reason here.
 * `z.set()` produces a mutable `Set`, so a schema for this shape would infer
 * `permissions: Set<Permission>` and silently drop the read-only guarantee
 * below — the schema would weaken the type it was supposed to describe.
 *
 * `permissions` is a `ReadonlySet` and not an array: the hot operation is
 * `has()` on every authorization check, and `ReadonlySet` has no `add`, so a
 * handler cannot widen its own permissions mid-request. `readonly Permission[]`
 * would allow neither the O(1) lookup nor the same guarantee — an array's
 * `readonly` stops reassignment of the property, not mutation through a
 * widening cast, and `includes` is linear.
 *
 * NOT THE SAME TYPE AS `TenantContext` IN `@sentinel/db`. That one is
 * deliberately the single field the tenant-scoped client needs
 * (`organizationId`) and nothing else, so the database layer cannot start
 * depending on authorization state. This one is the request-pipeline shape. A
 * file importing both must alias one of them.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly roleKey: SystemRole;
  readonly permissions: ReadonlySet<Permission>;
}
