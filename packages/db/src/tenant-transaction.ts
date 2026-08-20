import type { PrismaClient } from './unscoped.js';

/**
 * Runs `fn` inside a transaction whose `app.organization_id` setting is set,
 * which is what activates the row-level security policies.
 *
 * SET LOCAL is used deliberately: the setting is scoped to the transaction, so
 * a pooled connection handed to the next request cannot inherit it. A
 * session-level SET on a pooled connection is a real and well-documented way to
 * leak one tenant's context into another's request.
 *
 * Phase 1 provides this mechanism and tests it. Phase 2 wires it into the
 * request pipeline, once there are tenant-owned routes to wire it into.
 */
export async function withTenantTransaction<T>(
  base: PrismaClient,
  organizationId: string,
  // Prisma's own $transaction callback additionally omits `$on` and
  // `$extends` from the interactive-transaction client, on top of the three
  // administrative methods that don't make sense mid-transaction — matched
  // here so `tx` below is assignable to `fn`'s parameter without a cast.
  fn: (
    tx: Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$extends'>,
  ) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    // Parameterised: set_config is a function call, not string interpolation
    // into DDL, so a hostile organizationId cannot escape it.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
