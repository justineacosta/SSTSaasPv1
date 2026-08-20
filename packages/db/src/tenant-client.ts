import type { PrismaClient } from './unscoped.js';
import { MissingTenantContextError } from './errors.js';
import type { TenantContext } from './tenant-context.js';
import { decideScope } from './tenant-scope.js';

export type TenantPrismaClient = PrismaClient;

/**
 * Binds a Prisma client to one organisation.
 *
 * Handlers only ever receive this client. It injects the tenant predicate
 * into every top-level read and write on tenant-owned models and the tenant
 * root, and throws if no organisation is present, so a handler cannot query
 * another tenant's rows even if its author forgets to filter. See ADR-0006
 * and security/tenant-isolation.md §2.
 *
 * LIMITATION, BY DESIGN: this only scopes the *top-level* operation. Prisma's
 * `$allOperations` hook fires once per top-level call; it has no visibility
 * into the nested operations the query engine generates for relations — a
 * nested `include`, or a nested write under `data.someRelation.create` /
 * `update` / `updateMany` / `deleteMany`. There is no supported way to
 * intercept those from a client extension (verified against this Prisma
 * version's actual extension callback signature — it receives only
 * `{ model, operation, args, query }`, with no reference to the invoking
 * client). This is precisely the class of case row-level security exists to
 * catch (ADR-0006: "catches ... mistakes in the extension itself"); RLS is
 * therefore mandatory, not optional, and `withTenantTransaction` is what
 * activates it. See tenant-transaction.integration.spec.ts for the proof
 * that nested reads and nested writes are caught by RLS even though this
 * file cannot see them.
 */
export function createTenantClient(
  base: PrismaClient,
  context: TenantContext,
): TenantPrismaClient {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const plan = decideScope(model, operation, args, context.organizationId);

          switch (plan.kind) {
            case 'passthrough':
              return query(args);

            case 'refuse':
              throw new MissingTenantContextError(model ?? '(unknown model)', operation);

            case 'run':
              return query(plan.args as never);

            case 'run-and-check': {
              // Deliberately does NOT rewrite to a different operation (see the
              // file-level comment on why): runs the original findUnique/
              // findUniqueOrThrow unmodified, which is what keeps it on the
              // caller's own connection/transaction, then checks the scope
              // column on the result before deciding what the caller sees.
              const result = await query(plan.args as never);
              if (result === null || result === undefined) return result;
              const row = result as Record<string, unknown>;
              if (row[plan.checkField] === plan.expected) return result;
              if (plan.notFoundIsThrow) {
                throw new MissingTenantContextError(model ?? '(unknown model)', operation);
              }
              return null;
            }
          }
        },
      },
    },
  }) as unknown as TenantPrismaClient;
}
