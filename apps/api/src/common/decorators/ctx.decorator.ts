import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '@sentinel/contracts';
import { withTenantTransaction } from '@sentinel/db';
import type { Request } from 'express';

/**
 * The organisation this request resolved to, and what the caller may do in it.
 *
 * `api/authorization.md` §1 writes every guarded handler as
 * `(@Ctx() ctx: TenantContext, ...)`, and this is that decorator.
 *
 * # It throws rather than handing back `undefined`
 *
 * A handler on a `@RequirePermission()` route cannot be reached without a
 * resolved tenant: `TenantContextGuard` refuses such a route with 404 when the
 * membership does not resolve, and `AuthorizationGuard` refuses it again if the
 * context is somehow absent. So `undefined` here means the pipeline is not the
 * one this file believes, and the alternatives are both worse than throwing —
 * a nullable type would make every handler write a branch that cannot be taken
 * and cannot be tested, and a fabricated empty context would hand a handler a
 * tenant scope of "nothing", which reads as an ordinary empty result rather
 * than as a failure.
 *
 * It is deliberately a plain `Error`, not a `DomainError`: there is no code the
 * client could act on, and `AllExceptionsFilter` maps it to `INTERNAL_ERROR`
 * with the detail kept server-side. A 500 is the correct answer to "this
 * application is wired wrong".
 *
 * # Shipped handlers use it as of Task 13
 *
 * `GET`, `PATCH` and `DELETE /api/v1/organizations/:id` declare
 * `organization.read`, `organization.update` and `organization.delete`, and
 * read their tenant through this decorator. Through Task 12 no route declared a
 * permission and this paragraph said so. It is still *also* proved against
 * purpose-built controllers in `ctx.decorator.spec.ts`, which stays the honest
 * way to prove the arms no shipped route exercises.
 */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<Request>();
    const tenant = request.tenant;
    if (tenant === undefined) {
      throw new Error(
        '@Ctx() was read on a handler with no resolved tenant. A handler taking a TenantContext ' +
          'must declare @RequirePermission(), which is what makes TenantContextGuard refuse the ' +
          'request before it reaches here.',
      );
    }
    return tenant;
  },
);

/**
 * Runs a callback against a Prisma client bound to the resolved organisation.
 *
 * # This is the plan's "hand the tenant-scoped client to the handler"
 *
 * It hands over a *runner* rather than a client because the scoping is not a
 * property of a client on its own. `security/tenant-isolation.md` §2 and
 * ADR-0006 are two layers: the client extension injects the tenant predicate
 * into top-level operations, and row-level security catches the nested reads
 * and writes the extension provably cannot see (`tenant-client.ts` states that
 * limitation and `tenant-transaction.integration.spec.ts` proves RLS covers
 * it). RLS is activated by `SET LOCAL app.organization_id` inside a
 * transaction, so a bare client handed to a handler would carry layer 1 and
 * silently drop layer 2 — which is the exact defect `withTenantTransaction`'s
 * own docblock records having shipped once already.
 *
 * # The organisation id is not a parameter, and that is the point
 *
 * The runner closes over `ctx.organizationId`, which came from
 * `Session.activeOrganizationId` by way of `TenantContextGuard`. A handler
 * cannot pass a different one, because there is no argument to pass it in. That
 * removes the whole class of defect where a handler is correct except that it
 * scoped to an id it read off the request.
 *
 * # No shipped handler uses it yet
 *
 * The same status as `@Ctx()` above, for the same reason, proved the same way.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

export type TenantRunner = <T>(fn: Parameters<typeof withTenantTransaction<T>>[2]) => Promise<T>;

export function tenantRunnerFor(base: TenantTransactionBase, ctx: TenantContext): TenantRunner {
  return (fn) => withTenantTransaction(base, ctx.organizationId, fn);
}
