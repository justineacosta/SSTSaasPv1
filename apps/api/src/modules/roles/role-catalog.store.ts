import {
  LIST_LIMIT_MAX,
  PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type RoleCollection,
  type SystemRole,
} from '@sentinel/contracts';
import { knownPermissions } from '../../common/guards/tenant-context.js';
import type { TenantTransactionBase } from './tenant-resolver.store.js';

/**
 * The port `GET /api/v1/roles` reads through. One question, one answer — the
 * same shape `TENANT_RESOLVER` takes, for the same reason: the controller
 * receives a function, not the base Prisma client.
 */
export interface RoleCatalog {
  (): Promise<RoleCollection>;
}

/**
 * THE SEEDED SYSTEM ROLES, READ FROM THE SEEDED ROWS.
 *
 * # Not from `ROLE_PERMISSIONS`, deliberately
 *
 * `ROLE_PERMISSIONS` in `@sentinel/contracts` is the source `pnpm db:seed`
 * builds the `RolePermission` rows *from*, and reading it here instead would
 * make those rows decorative — a drift between the two would be invisible to
 * this endpoint while `AuthorizationGuard` went on deciding against the rows.
 * That is carry-forward rulings 5, 13 and 27's family, and it is the same
 * choice `tenant-resolver.store.ts` makes one layer down.
 *
 * The two are kept in step by `authorization.integration.spec.ts`, which
 * asserts the seeded rows expand to exactly `ROLE_PERMISSIONS` for all seven
 * system roles, so a drift fails a test rather than reaching a role picker.
 *
 * # `Role`, `Permission` and `RolePermission` are deliberately-global
 *
 * They carry no `organizationId`, no row-level security and no tenant scoping —
 * `tenant-resources.ts` registers them as global, which is exactly what exempts
 * them from the CI tenant-scoping check (carry-forward ruling 9). They are
 * reference data every organisation reads the same answer from, so this runs on
 * the base client rather than inside `withTenantTransaction`. **That is not a
 * hole**: the route still declares `organization.read`, so the caller has been
 * resolved into an organisation before it runs, and there is no tenant-owned
 * row in the answer for a tenant predicate to protect.
 *
 * # Two orderings, both imposed here rather than left to Postgres
 *
 * Roles come back in `SYSTEM_ROLES` order — `OWNER` first, `GUEST` last — which
 * is the order a role picker wants and the order `product/permissions.md`'s
 * table is written in. Permissions come back in `PERMISSIONS` order. Neither is
 * the order the database returns rows in, and a response whose array order
 * varies run to run is one no client can diff and no test can pin.
 *
 * # Custom roles are Phase 11
 *
 * Every row here is `isSystem: true`, and the field is on the response so a
 * client can already tell the two apart rather than needing a new field added
 * to a shape it has started depending on.
 */
export function roleCatalog(base: TenantTransactionBase): RoleCatalog {
  return async (): Promise<RoleCollection> => {
    const rows = await base.role.findMany({
      select: {
        key: true,
        name: true,
        description: true,
        isSystem: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });

    const rank = (role: SystemRole): number => SYSTEM_ROLES.indexOf(role);
    const permissionRank = (permission: Permission): number => PERMISSIONS.indexOf(permission);

    const data = rows
      .map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        // `knownPermissions` filters to the union the contract publishes. A
        // seeded key this build does not know about is dropped rather than
        // returned, because `roleResponseSchema` is a `z.enum(PERMISSIONS)` and
        // publishing a value outside it would be a document that lies about
        // itself.
        permissions: knownPermissions(row.permissions.map((grant) => grant.permission.key)).sort(
          (a, b) => permissionRank(a) - permissionRank(b),
        ),
        isSystem: row.isSystem,
      }))
      .sort((a, b) => rank(a.key) - rank(b.key));

    return {
      data,
      // A complete, bounded set: there are only ever as many system roles as
      // `SYSTEM_ROLES` has entries, so there is no next page and no cursor.
      // `limit` reports the bound that was applied rather than the number of
      // rows returned — `paginationSchema`'s own docblock calls it "the APPLIED
      // limit", and reporting seven would tell a client the page was full.
      pagination: { nextCursor: null, hasMore: false, limit: LIST_LIMIT_MAX },
    };
  };
}
