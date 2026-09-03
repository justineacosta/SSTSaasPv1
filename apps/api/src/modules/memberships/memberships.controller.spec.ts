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
import { MembershipsController } from './memberships.controller.js';

/**
 * THE DECORATORS ON THE THREE MEMBERSHIP HANDLERS, READ OFF THE REAL
 * CONTROLLER.
 *
 * `organizations.controller.spec.ts`'s twin, for the reason that file gives:
 * before it existed, three mutations that downgraded or deleted rate-limit
 * decorators survived the whole verification gate because nothing read a
 * shipped controller.
 *
 * **The access column is what this file is for.** Downgrading `DELETE` from
 * `organization.manage_members` to `@AuthenticatedOnly()` would leave every
 * happy-path test in `memberships.integration.spec.ts` passing, and the
 * authorization matrix would stop running three of its four arms against the
 * route — silently, because a route declaring no permission is simply not in
 * the matrix's guarded set. The matrix's own downgrade sentinel catches that
 * too; this catches it one layer earlier and names the handler.
 */

type HandlerName = 'list' | 'update' | 'remove';

/**
 * A handler read off the prototype as a REFLECTION TARGET, never to be called.
 * See `auth.controller.spec.ts` for why the lint rule is disabled here.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- read as a metadata target, never invoked.
const handlerOf = (name: HandlerName): object => MembershipsController.prototype[name];

interface RouteExpectation {
  readonly handler: HandlerName;
  readonly path: string;
  readonly method: RequestMethod;
  readonly rateLimit: RateLimitClass;
  readonly access: AccessDeclaration;
}

/**
 * The three routes, as an exact table. A fourth handler appearing on this
 * controller without a row here fails the exhaustiveness test at the bottom
 * rather than shipping undeclared.
 *
 * **Two different permissions, and the split is the plan's.** Listing and
 * removing are `organization.manage_members`; changing a role is
 * `organization.manage_roles`, which is a separate permission precisely so an
 * organisation can let somebody manage the roster without letting them change
 * who holds authority. `SECURITY_LEAD` holds neither, `ADMIN` holds both.
 */
const ROUTES: readonly RouteExpectation[] = [
  {
    handler: 'list',
    path: '/',
    method: RequestMethod.GET,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.manage_members' },
  },
  {
    handler: 'update',
    path: ':membershipId',
    method: RequestMethod.PATCH,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.manage_roles' },
  },
  {
    handler: 'remove',
    path: ':membershipId',
    method: RequestMethod.DELETE,
    rateLimit: 'generalSession',
    access: { kind: 'permission', permission: 'organization.manage_members' },
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

  it('is not exempt from rate limiting and refuses nothing cross-site', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handlerOf(handler))).toBeUndefined();
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, handlerOf(handler))).toBeUndefined();
  });

  it('does not admit a PENDING_MFA session', () => {
    // `@AllowPendingMfa()` belongs to `POST /auth/mfa/verify` alone. Here it
    // would let somebody who has proved a password and not a second factor
    // change who owns the organisation.
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, handlerOf(handler))).toBeUndefined();
  });

  it('carries no verified-email gate', () => {
    // Deliberate, and the opposite choice from `POST /organizations`. That
    // route creates something and is gated on a verified address
    // (`authentication.md` §6); these act inside an organisation the caller has
    // already been admitted to, and gating them would refuse a member whose
    // address was verified when they joined and has since been changed.
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handlerOf(handler))).toBeUndefined();
  });
});

describe('the permissions these routes name', () => {
  it('are two distinct real permissions from the catalogue', () => {
    const named = ROUTES.flatMap((route) =>
      route.access.kind === 'permission' ? [route.access.permission] : [],
    );
    expect(named).toEqual([
      'organization.manage_members',
      'organization.manage_roles',
      'organization.manage_members',
    ]);
    expect(new Set(named).size).toBe(2);
    for (const permission of named) {
      expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it('every route declares one, so none of them is `@AuthenticatedOnly()`', () => {
    // Both directions of the check that matters. A membership route without a
    // permission would be reachable by any signed-in member of the
    // organisation, including a `GUEST`.
    expect(ROUTES.filter((route) => route.access.kind === 'permission')).toHaveLength(
      ROUTES.length,
    );
  });

  it('gives the role change a DIFFERENT permission from the list and the removal', () => {
    // Giving all three the same permission would compile, would leave every
    // integration test green, and would silently hand role management to every
    // role that may manage the roster.
    const roleChange = ROUTES.find((route) => route.handler === 'update');
    const others = ROUTES.filter((route) => route.handler !== 'update');
    expect(roleChange?.access).toEqual({
      kind: 'permission',
      permission: 'organization.manage_roles',
    });
    for (const route of others) {
      expect(route.access).not.toEqual(roleChange?.access);
    }
  });
});

describe('the controller as a whole', () => {
  it('is mounted under the organisation whose members it lists', () => {
    // The path shape is a decision (Task 14's brief, §2): `:id` is checked
    // against the resolved tenant by `assertPathIsActiveTenant` and never used
    // to select one. A controller mounted at a bare `members` path would have
    // no `:id` to check and would read as though the session alone decided the
    // tenant — which is true, but invisible to a client reading the URL.
    expect(Reflect.getMetadata(PATH_METADATA, MembershipsController)).toBe(
      'organizations/:id/members',
    );
  });

  it('declares no class-level rate limit, exemption or access override', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, MembershipsController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, MembershipsController)).toBeUndefined();
    // A class-level `@RequirePermission()` would override nothing here — all
    // three handlers declare their own — but it would make the two different
    // permissions above invisible to a reader, and would apply to any handler
    // added later that forgot one.
    expect(Reflect.getMetadata(ACCESS_METADATA_KEY, MembershipsController)).toBeUndefined();
  });

  it('declares no class-level verified-email gate, cross-site refusal or pending-MFA exemption', () => {
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, MembershipsController)).toBeUndefined();
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, MembershipsController)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, MembershipsController)).toBeUndefined();
  });

  it('exposes exactly the three handlers in the table above', () => {
    const handlers = Object.getOwnPropertyNames(MembershipsController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers.sort()).toEqual([...ROUTES].map((route) => route.handler).sort());
  });
});
