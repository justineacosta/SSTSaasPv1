import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ERROR_CODES,
  PERMISSIONS,
  type Permission,
  type SystemRole,
  type TenantContext,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { ACCESS_METADATA_KEY, type AccessDeclaration } from '../decorators/access.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import { TENANT_RESOLVER } from '../../modules/roles/roles.tokens.js';

declare module 'express' {
  interface Request {
    /**
     * The organisation this request is acting in, straight off
     * `Session.activeOrganizationId`, set on every authenticated request
     * whether or not a membership resolved behind it.
     *
     * Separate from `tenant` below, and both are needed. This one answers
     * "which organisation was asked for" and is what `MfaEnrolmentGuard`
     * reads; `tenant` answers "which organisation this caller is entitled to
     * act in, and with what", and is absent whenever the membership did not
     * resolve. Collapsing them would make "you asked for an organisation you
     * are not a member of" indistinguishable from "you asked for none".
     */
    activeOrganizationId?: string | null;
    /**
     * Set only when every layer of `security/authorization.md` §2 that this
     * guard owns passed: an `ACTIVE` membership in an `ACTIVE` organisation.
     * `undefined` otherwise, including for a suspended organisation — a
     * caller in one is a member, and is still entitled to do nothing.
     *
     * **Never set on a `@Public()` route**, which this guard exits before
     * reading anything.
     */
    tenant?: TenantContext;
  }
}

/**
 * What the database says about (this user, this organisation), before any
 * layer has judged it.
 *
 * `roleKey` and `permissions` are read even when the membership is not
 * `ACTIVE` and the organisation is not: a decision function that receives only
 * the fields it is allowed to act on cannot be tested for acting on the wrong
 * one.
 */
export interface TenantResolutionInput {
  readonly activeOrganizationId: string | null;
  readonly membership: {
    readonly id: string;
    readonly isActive: boolean;
    readonly roleKey: SystemRole;
    readonly permissions: readonly Permission[];
  } | null;
  readonly organizationIsActive: boolean;
}

/**
 * Layers 2 and 3 of `security/authorization.md` §2, and the two ways they say
 * no.
 *
 * `no-active-organization` and `not-a-member` are separate outcomes that map
 * onto **one** wire response — 404 `RESOURCE_NOT_FOUND`, byte-identical — for
 * the reason `api/authorization.md` §3 gives. They are distinguished here and
 * nowhere else because the difference decides what `GET /auth/session` reports
 * about itself, which is a document the caller is entitled to.
 */
export type TenantResolution =
  | { readonly outcome: 'resolved'; readonly context: TenantContext }
  | { readonly outcome: 'no-active-organization' }
  | { readonly outcome: 'not-a-member' }
  | { readonly outcome: 'organization-suspended' };

/**
 * THE LAYER ORDER, AS A PURE FUNCTION, SO THE ORDER IS TESTABLE WITHOUT A
 * REQUEST.
 *
 * `security/authorization.md` §2 numbers six layers and says "evaluated in
 * order; every layer can deny, none can override a denial". Two of them are
 * this function's — membership (2) and organisation state (3) — and the order
 * between them is not cosmetic. A caller who is not a member must not learn
 * that the organisation is suspended, which is a fact about somebody else's
 * tenancy; reversing these two branches would leak it to every non-member who
 * guessed an id. That the id here came from the caller's own session narrows
 * the leak to nearly nothing today, and the order still goes the documented way
 * because the day a later phase resolves the organisation from anywhere else is
 * not the day anyone will re-derive this argument.
 *
 * A membership that is `INVITED` or `REMOVED` is `not-a-member`. §2's layer 2
 * asks two questions — "does the principal belong to this organisation, **and
 * is the membership active**" — and an invitation that has not been accepted is
 * exactly the case where the row exists and the answer is no.
 */
export function resolveTenant(input: TenantResolutionInput): TenantResolution {
  if (input.activeOrganizationId === null) return { outcome: 'no-active-organization' };

  const membership = input.membership;
  if (membership === null || !membership.isActive) return { outcome: 'not-a-member' };

  if (!input.organizationIsActive) return { outcome: 'organization-suspended' };

  return {
    outcome: 'resolved',
    context: {
      organizationId: input.activeOrganizationId,
      membershipId: membership.id,
      roleKey: membership.roleKey,
      // A `ReadonlySet`, per `packages/contracts/src/tenant-context.ts`: the hot
      // operation is `has()` on every authorization check, and a `ReadonlySet`
      // has no `add`, so a handler cannot widen its own permissions mid-request.
      permissions: new Set(membership.permissions),
    },
  };
}

/**
 * The set of permission keys this product recognises, for filtering what comes
 * back from `Permission.key` — which is a plain `String` column, not an enum.
 */
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Narrows database rows to the permission union, dropping anything unknown.
 *
 * **Dropping is safe and widening would not be.** `@RequirePermission()` is
 * typed against `PERMISSIONS`, so a key that is not in that list cannot be
 * required by any route and can therefore never grant anything — carrying it
 * would only put an unvalidated database string into a type that claims to be
 * the union. The reverse direction is the one that matters and it is asserted
 * elsewhere: `authorization.integration.spec.ts` proves the seeded rows expand
 * to exactly `ROLE_PERMISSIONS`, so a *missing* grant fails a test rather than
 * silently narrowing somebody's authority here.
 */
export function knownPermissions(keys: readonly string[]): Permission[] {
  return keys.filter((key): key is Permission => KNOWN_PERMISSIONS.has(key));
}

/** The port this guard resolves through. One question, one answer. */
export interface TenantResolver {
  (input: {
    userId: string;
    organizationId: string;
  }): Promise<Omit<TenantResolutionInput, 'activeOrganizationId'>>;
}

/**
 * The refusal for both membership arms.
 *
 * **One function, called from two places, because the two responses must be
 * indistinguishable.** `api/authorization.md` §3 maps "not a member of the
 * target organisation" and "resource belongs to another tenant" onto the same
 * row — 404 `RESOURCE_NOT_FOUND` — and §6 of `security/authorization.md` says
 * why: a 403 confirms the resource exists. Two constructors with the same
 * arguments is how the two drift apart in a later edit; one is how they cannot.
 */
function notFound(): DomainError {
  return new DomainError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found.', 404);
}

/**
 * STAGE "TENANT RESOLVE" OF `architecture/backend.md` §3, and layers 2 and 3 of
 * `security/authorization.md` §2.
 *
 * # It resolves on every authenticated route and denies only on a guarded one
 *
 * This is the asymmetry that keeps the control from bricking an account, and it
 * is the same argument `require-mfa.ts` makes about its own exemption. A member
 * who has just been removed from their only organisation must still be able to
 * read their own session document, sign out, and manage their factors — every
 * one of those is `@AuthenticatedOnly()`, about the *user* and about no tenant
 * (`security/authentication.md` §1). If an unresolvable tenant refused those,
 * the user would hold a valid credential and have no endpoint that would answer
 * it, including the one that ends the session.
 *
 * So: a route declaring `@RequirePermission()` is refused when the tenant does
 * not resolve, because a permission without an organisation is meaningless
 * (`security/authorization.md` §1). A route declaring `@AuthenticatedOnly()`
 * proceeds with `request.tenant` left `undefined`, and every consumer of that
 * field has to handle its absence — which the type makes unavoidable.
 *
 * # It reads the organisation from the session and from nowhere else
 *
 * `Session.activeOrganizationId`, per the plan's Task 12 and
 * `architecture/overview.md` §4: never a path parameter, never a header, never
 * a body field. A request-supplied organisation id would make tenant selection
 * an input, and every membership check downstream a check on something the
 * caller chose. The column is written by this application alone.
 *
 * **NOTHING IN PHASE 2 WRITES THAT COLUMN — Task 13 does.** So in production
 * today this guard performs no query on any request: `activeOrganizationId` is
 * NULL for every session that exists, the first branch short-circuits, and no
 * shipped route declares a permission for the denial arm to fire on. That is
 * the honest description of what is live, and it is why the denial arms are
 * proved against purpose-built controllers in `tenant-context.spec.ts` and
 * against real seeded rows in `authorization.integration.spec.ts` rather than
 * against a shipped endpoint. Nothing may record this as governing a route
 * until one carries `@RequirePermission()`.
 *
 * # The query runs under the tenant-scoped client, and that is not optional
 *
 * `Membership` is tenant-owned and carries RLS; `Organization` carries
 * `FORCE ROW LEVEL SECURITY` keyed on `id`. The `PRISMA` token is the unscoped
 * client connecting as `sentinel_app`, so a plain `prisma.membership.findFirst`
 * here would compile, pass review, and return zero rows in production for every
 * caller — the trap `active-organization.store.ts` documents with the measured
 * transcript. The resolver behind `TENANT_RESOLVER` runs inside
 * `withTenantTransaction`; carry-forward ruling 75 is why its integration spec
 * drives the application over the `sentinel_app` role rather than the harness's
 * schema owner, because under the owner this whole distinction is invisible.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TENANT_RESOLVER) private readonly resolve: TenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // A public route resolves nothing, exactly as it authenticates nothing.
    // There is no principal to resolve a membership for, and a query keyed on
    // `undefined` is the shape that quietly returns somebody else's row.
    if (access?.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal;

    // NOT THIS GUARD'S QUESTION — the same rule `require-mfa.ts` follows.
    // `AuthenticationGuard` has already admitted or refused this request, and a
    // second opinion here would put the authentication rule in two places. An
    // undeclared route is the only way to arrive here with no principal, and
    // `access-assertion.ts` refuses to boot one.
    if (principal === undefined) return true;

    const organizationId = request.activeOrganizationId ?? null;
    const resolution =
      organizationId === null
        ? // No query. The answer cannot depend on the database, and today this
          // is every request: nothing writes the column until Task 13.
          resolveTenant({
            activeOrganizationId: null,
            membership: null,
            organizationIsActive: false,
          })
        : resolveTenant({
            activeOrganizationId: organizationId,
            ...(await this.resolve({ userId: principal.userId, organizationId })),
          });

    if (resolution.outcome === 'resolved') {
      request.tenant = resolution.context;
      return true;
    }

    // Every arm below denies ONLY a route that named a permission. See the
    // docblock: refusing an `@AuthenticatedOnly()` route here would leave a
    // removed member holding a credential with no endpoint that answers it.
    if (access?.kind !== 'permission') return true;

    switch (resolution.outcome) {
      case 'no-active-organization':
      case 'not-a-member':
        throw notFound();
      case 'organization-suspended':
        throw new DomainError(
          ERROR_CODES.ORGANIZATION_SUSPENDED,
          'This organisation is suspended. Contact your organisation owner or Sentinel support to restore access.',
          403,
        );
      default: {
        // Exhaustiveness: a fifth outcome fails the build here rather than
        // falling into a default that admits the request.
        const unhandled: never = resolution;
        throw new Error(`Unhandled tenant resolution: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}
