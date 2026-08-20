// Rewriting one operation into another (findUnique -> findFirst) requires
// indexing the client dynamically by model name, which Prisma does not expose
// a typed API for. `modelDelegate` isolates the one `unknown` cast that needs,
// behind an explicit `DelegateMethod` signature, so the rest of this file — and
// everything downstream of it — stays fully typed rather than falling back to
// `any`. No blanket eslint-disable is needed as a result; every behaviour this
// file implements is covered by tenant-client.integration.spec.ts.

import type { PrismaClient } from './unscoped.js';
import { MissingTenantContextError } from './errors.js';
import type { TenantContext } from './tenant-context.js';
import { isTenantOwnedModel } from './tenant-resources.js';

export type TenantPrismaClient = PrismaClient;

/** Operations whose `where` must carry the tenant predicate. */
const SCOPED_WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
]);

/**
 * Operations whose `where` AND `data` must both carry the tenant column.
 *
 * `where` alone is not enough here: scoping only `where` picks the right row
 * but leaves `data.organizationId` free for a caller to set, which would
 * silently re-parent that row to a different tenant on a successful update —
 * a caller can only ever match its own rows, but could still move one out.
 * `updateManyAndReturn` (Prisma 6.14+) is the same shape as `updateMany` plus
 * a returning clause, so it needs the same treatment; it is not in the
 * brief's original operation list, added here after checking the generated
 * client (`packages/db/generated/client/index.d.ts`) exposes it.
 */
const SCOPED_WHERE_AND_DATA_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

/**
 * Operations whose `data` must carry the tenant column.
 *
 * `createManyAndReturn` (Prisma 5.14+) is `createMany` plus a returning
 * clause; also not in the brief's original list, added for the same reason.
 */
const SCOPED_DATA_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

type DelegateMethod = (args: unknown) => unknown;

function modelDelegate(client: PrismaClient, model: string): Record<string, DelegateMethod> {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (client as unknown as Record<string, Record<string, DelegateMethod>>)[key] ?? {};
}

function withTenantData(data: unknown, organizationId: string): unknown {
  if (Array.isArray(data)) return data.map((row) => ({ ...(row as object), organizationId }));
  return { ...(data as object), organizationId };
}

/**
 * Binds a Prisma client to one organisation.
 *
 * Handlers only ever receive this client. It injects the tenant predicate into
 * every read and write on tenant-owned models and throws if no organisation is
 * present, so a handler cannot query another tenant's rows even if its author
 * forgets to filter. See ADR-0006 and security/tenant-isolation.md §2.
 */
export function createTenantClient(
  base: PrismaClient,
  context: TenantContext,
): TenantPrismaClient {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantOwnedModel(model)) return query(args);

          const { organizationId } = context;
          if (organizationId === '' || organizationId === undefined) {
            throw new MissingTenantContextError(model, operation);
          }

          // findUnique accepts only unique fields in `where`, so the predicate
          // cannot simply be added. It is rewritten into findFirst instead.
          // Without this, findUnique({ where: { id } }) would bypass isolation
          // entirely — the single most common multi-tenant Prisma bug.
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            const next = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            const call = modelDelegate(base, model)[next];
            const typed = args as { where?: Record<string, unknown> };
            return call?.({ ...typed, where: { ...(typed.where ?? {}), organizationId } });
          }

          if (SCOPED_WHERE_OPERATIONS.has(operation)) {
            const typed = args as { where?: Record<string, unknown> };
            return query({ ...typed, where: { ...(typed.where ?? {}), organizationId } });
          }

          if (SCOPED_WHERE_AND_DATA_OPERATIONS.has(operation)) {
            const typed = args as { where?: Record<string, unknown>; data?: unknown };
            return query({
              ...typed,
              where: { ...(typed.where ?? {}), organizationId },
              data: withTenantData(typed.data, organizationId),
            } as never);
          }

          if (SCOPED_DATA_OPERATIONS.has(operation)) {
            const typed = args as { data?: unknown };
            return query({ ...typed, data: withTenantData(typed.data, organizationId) } as never);
          }

          if (operation === 'upsert') {
            // Both branches carry a payload that could otherwise re-parent
            // the row to another tenant: `create` if no row matches, `update`
            // if one does. Both are forced, not merely `where`.
            const typed = args as {
              where?: Record<string, unknown>;
              create?: unknown;
              update?: unknown;
            };
            return query({
              ...typed,
              where: { ...(typed.where ?? {}), organizationId },
              create: withTenantData(typed.create, organizationId),
              update: withTenantData(typed.update, organizationId),
            } as never);
          }

          // Any operation not enumerated above is refused rather than passed
          // through unscoped. Failing closed is the only safe default here.
          throw new MissingTenantContextError(model, operation);
        },
      },
    },
  }) as unknown as TenantPrismaClient;
}
