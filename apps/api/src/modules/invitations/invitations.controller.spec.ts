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
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPE_PHASES,
  type RateLimitClass,
} from '../../common/guards/rate-limit.config.js';
import { InvitationsController } from './invitations.controller.js';

/**
 * THE DECORATORS ON THE THREE INVITATION HANDLERS, READ OFF THE REAL
 * CONTROLLER.
 *
 * `memberships.controller.spec.ts`'s twin, for the reason that file gives and
 * carry-forward ruling 64 states: **a route's rate-limit class must be asserted
 * on the shipped handler, not on the config table.** `rate-limit.config.spec.ts`
 * asserts the table value by value and `rate-limit.integration.spec.ts` drives a
 * fixture controller, and with both green the create route could be downgraded
 * to fail-open `generalSession`, or lose its decorators entirely, with the whole
 * verification gate passing.
 *
 * That matters more here than on any previous controller, because `invitations`
 * is the first class in this codebase whose limit could ever apply, and the
 * downgrade is invisible: a silently defaulted route produces no log line at the
 * default level (ruling 55).
 *
 * **The verified-email column is this file's second reason to exist.** `create`
 * carries `@RequireVerifiedEmail()` and the other two do not, and the split is
 * `security/authentication.md` §6's sentence rather than a preference — so it
 * is asserted per handler rather than per controller.
 */

type HandlerName = 'create' | 'list' | 'revoke';

/**
 * A handler read off the prototype as a REFLECTION TARGET, never to be called.
 * See `auth.controller.spec.ts` for why the lint rule is disabled here.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- read as a metadata target, never invoked.
const handlerOf = (name: HandlerName): object => InvitationsController.prototype[name];

interface RouteExpectation {
  readonly handler: HandlerName;
  readonly path: string;
  readonly method: RequestMethod;
  readonly rateLimit: RateLimitClass;
  readonly access: AccessDeclaration;
  readonly verifiedEmail: boolean;
}

/**
 * The three routes, as an exact table. A fourth handler appearing on this
 * controller without a row here fails the exhaustiveness test at the bottom
 * rather than shipping undeclared.
 *
 * **All three name the same permission, and that is deliberate.** Unlike the
 * membership routes, which split `manage_members` from `manage_roles`, there is
 * nothing here that is about *who holds authority* — an invitation offers a
 * role, and the no-minting check in `InvitationService.create` is what stops an
 * `ADMIN` offering `OWNER`. Splitting the permission would mean a role that
 * could invite a `MEMBER` but not an `OWNER`, which the permission set already
 * decides on its own and more accurately.
 */
const ROUTES: readonly RouteExpectation[] = [
  {
    handler: 'create',
    path: '/',
    method: RequestMethod.POST,
    rateLimit: 'invitations',
    access: { kind: 'permission', permission: 'organization.manage_members' },
    verifiedEmail: true,
  },
  {
    handler: 'list',
    path: '/',
    method: RequestMethod.GET,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.manage_members' },
    verifiedEmail: false,
  },
  {
    handler: 'revoke',
    path: ':invitationId',
    method: RequestMethod.DELETE,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.manage_members' },
    verifiedEmail: false,
  },
];

describe.each(ROUTES)(
  '$method $path',
  ({ handler, path, method, rateLimit, access, verifiedEmail }) => {
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

    it('is not exempt from rate limiting and refuses nothing cross-site', () => {
      expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handlerOf(handler))).toBeUndefined();
      expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, handlerOf(handler))).toBeUndefined();
    });

    it('does not admit a PENDING_MFA session', () => {
      // `@AllowPendingMfa()` belongs to `POST /auth/mfa/verify` alone. Here it
      // would let somebody who has proved a password and not a second factor
      // invite a colleague into the organisation at any role they hold.
      expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, handlerOf(handler))).toBeUndefined();
    });

    it('carries the verified-email gate if and only if it is the invite route', () => {
      const declared: unknown = Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handlerOf(handler));
      if (verifiedEmail) expect(declared).toBe(true);
      else expect(declared).toBeUndefined();
    });
  },
);

describe('the invite route’s verified-email gate', () => {
  it('is on `create` and on neither of the other two', () => {
    // `security/authentication.md` §6: an unverified user "cannot create
    // organisations, invite, or scan". Inviting is in that list because it makes
    // this product send mail to a third party on the caller's say-so.
    //
    // Both directions, because the assertion that matters is the SPLIT.
    // Applying the decorator to the controller instead would satisfy a
    // per-handler `toBe(true)` on `create` while also gating reads and
    // revocations — which would leave an owner whose address is pending
    // re-verification unable to withdraw an invitation they had already sent.
    const gated = ROUTES.filter(
      (route) => Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handlerOf(route.handler)) === true,
    ).map((route) => route.handler);
    expect(gated).toEqual(['create']);
  });
});

describe('the rate-limit class the invite route names', () => {
  it('is `invitations`, the per-organisation class from abuse-prevention.md §1', () => {
    // Ruling 64. The value is read off the shipped handler, and the shape of the
    // class it names is read off the table, so a downgrade fails here whichever
    // half it changes.
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, handlerOf('create'))).toBe('invitations');
    expect(RATE_LIMIT_CLASSES.invitations).toEqual({
      perOrganization: { limit: 50, windowSeconds: 86_400 },
      failMode: 'closed',
    });
  });

  it('is evaluated in the TENANT phase, without which this route would answer 429 to everything', () => {
    // The class declares `perOrganization` and nothing else, and that scope's
    // identifier is written by `TenantContextGuard` — after the edge pass has
    // already run. Before Task 15 split the limiter, a fail-closed class with no
    // resolvable scope applied its fail mode, so this route would have refused
    // every request. Asserting the phase here ties the route to the mechanism
    // that makes its limit reachable: moving `perOrganization` back to `'edge'`
    // turns this red beside the guard's own tests.
    expect(RATE_LIMIT_SCOPE_PHASES.perOrganization).toBe('tenant');
    expect(Object.keys(RATE_LIMIT_CLASSES.invitations)).toEqual(['perOrganization', 'failMode']);
  });
});

describe('the permissions these routes name', () => {
  it('are one real permission from the catalogue, on every route', () => {
    const named = ROUTES.flatMap((route) =>
      route.access.kind === 'permission' ? [route.access.permission] : [],
    );
    expect(named).toHaveLength(ROUTES.length);
    expect(new Set(named)).toEqual(new Set(['organization.manage_members']));
    for (const permission of named) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it('every route declares one, so none of them is `@AuthenticatedOnly()`', () => {
    // An invitation route without a permission would be reachable by any
    // signed-in member of the organisation, including a `GUEST` — who could
    // then invite anybody at any role their own permission set allows, which
    // for a `GUEST` the no-minting check would narrow but not close.
    expect(ROUTES.filter((route) => route.access.kind === 'permission')).toHaveLength(
      ROUTES.length,
    );
  });
});

describe('the controller as a whole', () => {
  it('is mounted under the organisation whose invitations it manages', () => {
    expect(Reflect.getMetadata(PATH_METADATA, InvitationsController)).toBe(
      'organizations/:id/invitations',
    );
  });

  it('declares no class-level rate limit, exemption or access override', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, InvitationsController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, InvitationsController)).toBeUndefined();
    expect(Reflect.getMetadata(ACCESS_METADATA_KEY, InvitationsController)).toBeUndefined();
  });

  it('declares no class-level verified-email gate, cross-site refusal or pending-MFA exemption', () => {
    // The verified-email one is the load-bearing assertion here: a class-level
    // `@RequireVerifiedEmail()` would make the per-handler split above vacuous
    // in the direction that matters, because `getAllAndOverride` walks to the
    // class when the handler declares nothing.
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, InvitationsController)).toBeUndefined();
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, InvitationsController)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, InvitationsController)).toBeUndefined();
  });

  it('exposes exactly the three handlers in the table above', () => {
    // **There is no `accept` handler, and its absence is a measured blocker
    // rather than an oversight** — see the controller's docblock. When it is
    // built it will live on a different controller (it is tenant-less and
    // carries no permission, D1), so this assertion is about this controller
    // staying the tenant-scoped three.
    const handlers = Object.getOwnPropertyNames(InvitationsController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers.sort()).toEqual([...ROUTES].map((route) => route.handler).sort());
  });
});
