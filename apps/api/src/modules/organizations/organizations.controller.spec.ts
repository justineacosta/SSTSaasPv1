import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { PERMISSIONS } from '@sentinel/contracts';
import {
  ACCESS_METADATA_KEY,
  ALLOW_PENDING_MFA_KEY,
  type AccessDeclaration,
} from '../../common/decorators/access.decorator.js';
import { REFUSE_CROSS_SITE_KEY } from '../../common/decorators/cross-site.decorator.js';
import { REQUIRE_VERIFIED_EMAIL_KEY } from '../../common/decorators/email-verified.decorator.js';
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_METADATA_KEY,
} from '../../common/decorators/rate-limit.decorator.js';
import type { RateLimitClass } from '../../common/guards/rate-limit.config.js';
import { OrganizationsController } from './organizations.controller.js';

/**
 * THE DECORATORS ON THE FIVE ORGANISATION HANDLERS, READ OFF THE REAL
 * CONTROLLER.
 *
 * `auth.controller.spec.ts`'s twin, for the reason that file's docblock gives:
 * before it existed, three mutations that downgraded or deleted rate-limit
 * decorators survived the entire eleven-command gate, because the config table
 * and a fixture controller were the only things anything asserted. Nothing read
 * the shipped controller.
 *
 * **Here the stakes are higher than a rate-limit class.** These are the first
 * routes in this product to declare `@RequirePermission()`, so a wrong access
 * arm is not a thinner control — it is the difference between an endpoint
 * `AuthorizationGuard` governs and one it does not look at. Downgrading
 * `DELETE :id` from `organization.delete` to `@AuthenticatedOnly()` would leave
 * every test in the integration suite passing except the ones that assert a
 * 403, and the authorization matrix would stop running three of its four arms
 * against it — silently, because a route that declares no permission is simply
 * not in the matrix's guarded set.
 *
 * Metadata is read off the prototype's handler functions, which is where
 * `SetMetadata` as a `MethodDecorator` puts it and where
 * `Reflector.getAllAndOverride(key, [handler, class])` reads it from at
 * runtime.
 */

type HandlerName = 'create' | 'list' | 'read' | 'update' | 'remove';

/**
 * A handler read off the prototype as a REFLECTION TARGET, never to be called.
 * See `auth.controller.spec.ts` for why the lint rule is disabled here.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- read as a metadata target, never invoked.
const handlerOf = (name: HandlerName): object => OrganizationsController.prototype[name];

interface RouteExpectation {
  readonly handler: HandlerName;
  readonly path: string;
  readonly method: RequestMethod;
  readonly rateLimit: RateLimitClass;
  readonly access: AccessDeclaration;
  /** Whether the handler carries `@RequireVerifiedEmail()`. */
  readonly requiresVerifiedEmail: boolean;
}

/**
 * The five routes, as an exact table. A sixth handler appearing on this
 * controller without a row here fails the exhaustiveness test at the bottom
 * rather than shipping undeclared.
 *
 * The `access` column is the whole point of this file. Two of these routes are
 * `@AuthenticatedOnly()` and three name a permission, and which is which is a
 * decision (`security/authorization.md` §1) rather than an accident:
 *
 * - `create` has no organisation to hold a permission in — it makes one. It is
 *   gated on a verified address instead, which is `authentication.md` §6's
 *   "unverified users may sign in but cannot create organisations".
 * - `list` asks which organisations the caller belongs to, which is a question
 *   about a user and about no tenant (ADR-0020).
 * - `read`, `update` and `remove` all act inside one organisation, which is
 *   exactly the set §1 says a permission governs.
 */
const ROUTES: readonly RouteExpectation[] = [
  {
    handler: 'create',
    path: '/',
    method: RequestMethod.POST,
    rateLimit: 'generalSession',
    access: { kind: 'authenticated' },
    // THE FIRST HANDLER IN THIS CODEBASE TO CARRY IT. `EmailVerifiedGuard` was
    // built in Task 8 and registered in Task 12 with no handler opting in, so
    // it had never refused anybody — a structural fact held by a test in
    // `email-verified.guard.spec.ts`. This row is what changes that, and
    // `organizations.integration.spec.ts` proves the refusal against a real
    // unverified account rather than against this assertion.
    requiresVerifiedEmail: true,
  },
  {
    handler: 'list',
    path: '/',
    method: RequestMethod.GET,
    rateLimit: 'generalSession',
    access: { kind: 'authenticated' },
    requiresVerifiedEmail: false,
  },
  {
    handler: 'read',
    path: ':id',
    method: RequestMethod.GET,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.read' },
    requiresVerifiedEmail: false,
  },
  {
    handler: 'update',
    path: ':id',
    method: RequestMethod.PATCH,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.update' },
    requiresVerifiedEmail: false,
  },
  {
    handler: 'remove',
    path: ':id',
    method: RequestMethod.DELETE,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.delete' },
    requiresVerifiedEmail: false,
  },
];

describe.each(ROUTES)('$method $path', ({ handler, path, method, rateLimit, access }) => {
  it('is registered on the expected path with the expected method', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handlerOf(handler))).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(handler))).toBe(method);
  });

  it('carries exactly the rate-limit class it is meant to', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, handlerOf(handler))).toBe(rateLimit);
  });

  it('declares its access arm in metadata rather than by omission', () => {
    const declared = Reflect.getMetadata(
      ACCESS_METADATA_KEY,
      handlerOf(handler),
    ) as AccessDeclaration;
    expect(declared).toEqual(access);
  });

  it('is not exempt from rate limiting, and refuses nothing cross-site', () => {
    // `@RateLimitExempt()` is for the liveness probe and nothing else.
    // `@RefuseCrossSite()` is login's separate mechanism for a route `CsrfGuard`
    // skips (ruling 56); every route here is cookie-authenticated and therefore
    // already covered by `CsrfGuard` on its unsafe methods, so carrying it as
    // well would be a second control nobody chose.
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handlerOf(handler))).toBeUndefined();
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, handlerOf(handler))).toBeUndefined();
  });

  it('does not admit a PENDING_MFA session', () => {
    // `@AllowPendingMfa()` is the one exemption `AuthenticationGuard` honours,
    // and it belongs to `POST /auth/mfa/verify` alone. On any route here it
    // would let a caller who has proved a password and not a second factor
    // create an organisation or rename one.
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, handlerOf(handler))).toBeUndefined();
  });
});

describe('the verified-email gate', () => {
  it('is carried by creation and by nothing else', () => {
    // Both directions. Its absence on `create` would silently re-open
    // organisation creation to unverified accounts — the guard is opt-in, so
    // nothing else would refuse them and no test outside this file and the
    // integration suite would notice. Its presence on `read` would make an
    // extra database round trip per request for a control that route does not
    // need, and would refuse a member whose address was verified when they
    // joined and later reset.
    for (const route of ROUTES) {
      expect(
        Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handlerOf(route.handler)),
        route.handler,
      ).toBe(route.requiresVerifiedEmail ? true : undefined);
    }
  });

  it('is declared on exactly one handler, so the count cannot drift', () => {
    expect(ROUTES.filter((route) => route.requiresVerifiedEmail).map((route) => route.handler)).toEqual([
      'create',
    ]);
  });
});

describe('the permissions these routes name', () => {
  it('are three distinct real permissions from the catalogue', () => {
    // `@RequirePermission()` is typed against `PERMISSIONS`, so a typo is
    // already a compile error. What this adds is that the three are *different*
    // from each other: giving `PATCH` and `DELETE` the same permission would
    // silently grant deletion to every role that may rename, and would compile.
    const named = ROUTES.flatMap((route) =>
      route.access.kind === 'permission' ? [route.access.permission] : [],
    );
    expect(named).toEqual(['organization.read', 'organization.update', 'organization.delete']);
    expect(new Set(named).size).toBe(3);
    for (const permission of named) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it('are the first permission-guarded routes in this product', () => {
    // Not a claim about the whole application — the authorization matrix owns
    // that, over the live route inventory. What this pins is the shape the
    // matrix depends on: at least one route here declares a permission, so the
    // matrix's 403 and cross-tenant-404 arms have a shipped endpoint to run
    // against. If this ever went to zero, those arms would go back to
    // exercising nothing and the matrix would still report green.
    expect(ROUTES.filter((route) => route.access.kind === 'permission')).toHaveLength(3);
  });
});

describe('the controller as a whole', () => {
  it('declares no class-level rate limit, exemption or access override', () => {
    // A class-level `@RequirePermission()` here would be the most dangerous of
    // the three: it would make `create` and `list` permission-guarded, and both
    // would then answer 404 to every caller who has no active organisation —
    // which is every caller who has not created one yet, on the endpoint they
    // use to create one.
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, OrganizationsController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, OrganizationsController)).toBeUndefined();
    expect(Reflect.getMetadata(ACCESS_METADATA_KEY, OrganizationsController)).toBeUndefined();
  });

  it('declares no class-level verified-email gate, cross-site refusal or pending-MFA exemption', () => {
    // `@RequireVerifiedEmail()` is `MethodDecorator & ClassDecorator` on
    // purpose (its failure direction is refusing too much), so a class-level
    // one would work — and would quietly gate all five routes, including the
    // read a member with a since-reset address still needs.
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, OrganizationsController)).toBeUndefined();
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, OrganizationsController)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, OrganizationsController)).toBeUndefined();
  });

  it('exposes exactly the five handlers in the table above', () => {
    const handlers = Object.getOwnPropertyNames(OrganizationsController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers.sort()).toEqual([...ROUTES].map((route) => route.handler).sort());
  });
});
