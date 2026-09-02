import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ERROR_CODES,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRole,
  type TenantContext,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { ACCESS_METADATA_KEY, type AccessDeclaration } from '../decorators/access.decorator.js';
import { DomainError } from '../errors/domain-error.js';

/**
 * Which system roles hold a permission, precomputed once.
 *
 * Only ever used to fill in the `rolesWithPermission` hint on a 403.
 * `api/authorization.md` §4 asks a denial to say who can grant it, and is
 * explicit about the limit: "We never list *which users* hold the permission —
 * that is organisation membership detail the caller may not be entitled to.
 * Roles are safe; names are not."
 *
 * Read from the contracts constant rather than from the database, and the
 * difference is deliberate. This is a **hint**, not a decision: the decision
 * below is made against `ctx.permissions`, which came from the seeded
 * `RolePermission` rows. If the two ever disagreed, the caller would get a
 * misleading sentence and never a wrong answer — and they cannot disagree,
 * because `roles.integration.spec.ts` asserts the seeded rows expand to exactly
 * `ROLE_PERMISSIONS` for all seven roles.
 */
const ROLES_WITH_PERMISSION: ReadonlyMap<Permission, readonly SystemRole[]> = new Map(
  Object.values(ROLE_PERMISSIONS)
    .flat()
    .map((permission) => [
      permission,
      SYSTEM_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission)),
    ]),
);

/**
 * STAGE "AUTHORIZE" OF `architecture/backend.md` §3, and layer 4 of
 * `security/authorization.md` §2.
 *
 * # This is the guard `@RequirePermission()` has been waiting for
 *
 * Since Task 7 the decorator has been *read* by three things — the
 * authentication guard, the route inventory and the OpenAPI generator — and
 * **evaluated by nobody**. `security/authorization.md` §5 and
 * `architecture/backend.md` §3 both say so in as many words. This is the code
 * that makes those sentences false, and both documents move in the same change.
 *
 * # It decides nothing that `TenantContextGuard` has already decided
 *
 * §2's layers each deny and none overrides a denial, so this one starts where
 * the previous one stopped: it runs only on a route declaring a permission, and
 * on such a route `TenantContextGuard` has already refused every caller whose
 * membership or organisation did not resolve. `request.tenant` is therefore
 * present whenever this guard has work to do.
 *
 * **It fails closed anyway, with 404 rather than 403.** Reaching this guard
 * with no `tenant` means the pipeline is not the one this file believes — a
 * reordering of the `APP_GUARD` array, or a route registered outside it — and
 * the safe answer to "I cannot tell which organisation this is" is the same
 * answer a non-member gets. Answering 403 there would turn a misconfiguration
 * into an existence oracle, which is precisely what §6 spends its length on.
 *
 * # 403 says what is missing, and that is a deliberate disclosure
 *
 * `api/errors.md` §4 asks a refusal to say how to succeed, and
 * `api/authorization.md` §4 shows the exact envelope: the required permission,
 * the caller's own role, and the roles that hold it. Every one of those is a
 * fact about the caller's own organisation, which they are a member of and
 * already know they are — §6 reserves 403 for exactly that case. Nothing here
 * is reachable by a non-member, because a non-member was refused one layer up
 * with a 404 that says nothing at all.
 *
 * # It governs no shipped route today, and that must not be written otherwise
 *
 * No endpoint in this API declares `@RequirePermission()`: the eighteen routes
 * Phase 2 publishes are `@Public()` or `@AuthenticatedOnly()`, and the first
 * permission-guarded endpoints are Tasks 13–15's. The guard is proved against
 * purpose-built controllers in `authorization.guard.spec.ts` and against real
 * seeded rows over the `sentinel_app` role in
 * `authorization.integration.spec.ts` — the precedent `EmailVerifiedGuard`,
 * `CrossSiteGuard` and `@AllowPendingMfa()` all set. It is registered globally
 * so that a route which declares a permission is governed from the moment it is
 * written rather than from the moment somebody remembers to add a guard.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // `public` and `authenticated` are not this guard's business, and neither
    // is an undeclared route — `access-assertion.ts` refuses to boot one, and a
    // route with no permission to check is not a route this guard can have an
    // opinion about. The three arms are matched positively rather than by
    // excluding `public`, so a fourth arm added to `AccessDeclaration` is
    // ignored here instead of being silently authorised.
    if (access?.kind !== 'permission') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const tenant = request.tenant;
    if (tenant === undefined) {
      throw new DomainError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found.', 404);
    }

    if (tenant.permissions.has(access.permission)) return true;

    throw permissionDenied(access.permission, tenant);
  }
}

/**
 * The message names the permission in prose and the details name it as data.
 *
 * Both, because they have different readers: `api/errors.md` §4's message is
 * what a person sees, and `details` is what the frontend keys on to render
 * "ask an owner or admin" without parsing English.
 */
export function permissionDenied(required: Permission, tenant: TenantContext): DomainError {
  return new DomainError(
    ERROR_CODES.PERMISSION_DENIED,
    `You need the "${required}" permission to do this.`,
    403,
    {
      required,
      yourRole: tenant.roleKey,
      rolesWithPermission: ROLES_WITH_PERMISSION.get(required) ?? [],
    },
  );
}
