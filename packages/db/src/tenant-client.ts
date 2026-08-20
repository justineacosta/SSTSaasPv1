import type { PrismaClient } from './unscoped.js';
import { MissingTenantContextError } from './errors.js';
import type { TenantContext } from './tenant-context.js';
import { decideScope } from './tenant-scope.js';

export type TenantPrismaClient = PrismaClient;

/**
 * An `id` value for building a `where` guaranteed to match nothing, for
 * every tenant-owned model and the tenant root — every one of them carries
 * a plain `id String @id`, so `{ id: NEVER_MATCHES_ID }` is always a
 * structurally valid `WhereUniqueInput`, regardless of what the caller's own
 * `where` looked like (a compound unique key included). Used to re-run
 * `findUniqueOrThrow` so Prisma's own engine raises its own not-found error
 * — see the `notFoundIsThrow` branch below for why that matters, and for why
 * this constant alone is not used as the `where` directly.
 */
export const NEVER_MATCHES_ID = '00000000000000000000000000-tenant-scope-miss';

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
                // Re-runs the SAME operation (still via `query`, so still on
                // the caller's own connection/transaction) with a where
                // guaranteed to match nothing, so Prisma's own engine raises
                // its own not-found error — byte-identical message and meta
                // to a genuine miss, on every connection, including where
                // RLS isn't engaged (migrations, seeds, the future
                // platform-admin module). findUniqueOrThrow's contract is
                // "throws P2025 when nothing matches"; a caller catching
                // that specific error to distinguish "not found" from other
                // failures must see the exact same failure whether the row
                // genuinely doesn't exist or simply belongs to another
                // tenant, or the *shape of the error itself* becomes an
                // oracle confirming another tenant's row exists. A
                // hand-constructed error would drift the moment Prisma's own
                // wording changes across versions; this can't drift, because
                // it comes from Prisma itself, not from a copy of its
                // wording — see tenant-client.integration.spec.ts, which
                // asserts message and meta against a genuine miss captured
                // at test run time rather than a hardcoded string.
                //
                // The where clause below is deliberately self-contradictory
                // — `id` equals the sentinel AND NOT `id` equals the
                // sentinel — rather than a plain `{ id: NEVER_MATCHES_ID }`
                // equality lookup. A plain equality lookup can be defeated:
                // found live in review, planting a row whose `id` literally
                // IS the sentinel string (reachable only through the
                // unscoped client — RLS and `newId()`'s Crockford format
                // both independently prevent it in normal operation) made
                // this query return THAT row's full, unrelated content
                // instead of throwing. A self-contradictory where has no
                // row that could ever satisfy it, regardless of what is in
                // the table — logically impossible, not merely unreachable
                // in practice — while still going through Prisma's own
                // engine for the not-found error, same as above.
                return query({
                  where: { id: NEVER_MATCHES_ID, NOT: { id: NEVER_MATCHES_ID } },
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
