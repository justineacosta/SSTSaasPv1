import { Prisma, type PrismaClient } from './unscoped.js';
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
 *
 * HOUSE RULE, tenant-owned models: write the scalar foreign key directly
 * (`organizationId: orgId`) in `create`/`upsert` payloads, never Prisma's
 * relation-connect form (`organization: { connect: { id: orgId } }`). The
 * scoping this file performs forces the scalar column into `data`, so a
 * `connect`-shaped payload fails with "Unknown argument `organizationId`" —
 * see development/coding-standards.md. Deliberately not taught to this
 * extension: normalising `connect`/`connectOrCreate` shapes would add
 * meaningfully more surface to a file that has already produced four
 * Critical review findings, and this stays small and auditable instead.
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
              if (row[plan.checkField] === plan.expected) {
                // `select`/`omit` may have been widened purely so the check
                // above had a value to read (tenant-scope.ts's
                // adjustProjectionForCheck); strip it back out so the caller
                // gets exactly the shape it asked for, not an extra field.
                if (plan.stripCheckField) delete row[plan.checkField];
                return row;
              }
              if (plan.notFoundIsThrow) {
                // Raises Prisma's own not-found shape, not
                // MissingTenantContextError: findUniqueOrThrow's contract is
                // "throws P2025 when nothing matches", and a caller catching
                // that specific error to distinguish "not found" from other
                // failures must see the same class and code whether the row
                // genuinely doesn't exist or simply belongs to another
                // tenant. A different error here would make the *response*
                // itself an existence oracle — confirming another tenant's
                // row is there by the shape of the failure alone, even
                // though its contents never leak.
                throw new Prisma.PrismaClientKnownRequestError(`No ${model ?? 'record'} found`, {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                  meta: { cause: `No ${model ?? 'record'} found` },
                });
              }
              return null;
            }
          }
        },
      },
    },
  }) as unknown as TenantPrismaClient;
}
