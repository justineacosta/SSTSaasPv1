import type { PrismaClient } from './unscoped.js';
import { createTenantClient } from './tenant-client.js';
import type { TenantPrismaClient } from './tenant-client.js';

/**
 * Runs `fn` inside a transaction on a tenant-scoped client, with
 * `app.organization_id` set for the duration of that transaction — which is
 * what activates the row-level security policies.
 *
 * Order matters: the base client is extended with the tenant scoping
 * *before* `$transaction` is called, not after. Prisma's documented and
 * verified behaviour is that an interactive transaction started from an
 * extended client yields extended `tx` clients — the extension's `_extensions`
 * propagate onto the transaction-bound client Prisma hands back. Doing it the
 * other way round (`base.$transaction` first, extend `tx` second) does not
 * compose: `withTenantTransaction` previously wrapped an *unscoped* `tx`,
 * meaning layer 1 (the scoping extension) and layer 2 (RLS, activated by the
 * `SET LOCAL` below) never actually ran together — every caller of
 * `withTenantTransaction` was silently getting RLS alone. This is caller code
 * receiving a client that is already both extended and inside the
 * transaction, so both layers are live for every operation `fn` performs.
 *
 * SET LOCAL is used deliberately: the setting is scoped to the transaction,
 * so a pooled connection handed to the next request cannot inherit it. A
 * session-level SET on a pooled connection is a real and well-documented way
 * to leak one tenant's context into another's request.
 *
 * Phase 1 provides this mechanism and tests it (including that both layers
 * hold together over the real `sentinel_app` role —
 * tenant-transaction.integration.spec.ts). Phase 2 wires it into the request
 * pipeline, once there are tenant-owned routes to wire it into.
 */
export async function withTenantTransaction<T>(
  base: PrismaClient,
  organizationId: string,
  fn: (tx: TenantPrismaClient) => Promise<T>,
): Promise<T> {
  const scoped = createTenantClient(base, { organizationId });
  return scoped.$transaction(async (tx) => {
    // Parameterised: set_config is a function call, not string interpolation
    // into DDL, so a hostile organizationId cannot escape it.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx as TenantPrismaClient);
  });
}
