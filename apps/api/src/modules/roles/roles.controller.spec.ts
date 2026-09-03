import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@sentinel/contracts';
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
import { RolesController } from './roles.controller.js';

/**
 * THE ONE HANDLER ON `GET /api/v1/roles`, READ OFF THE REAL CONTROLLER.
 *
 * The interesting decision on this route is its access arm, and it is the one
 * a reviewer is most likely to want changed: `organization.read` is held by
 * every system role, so the permission refuses no member of the organisation
 * the caller is acting in, and it looks at first glance like
 * `@AuthenticatedOnly()` would be equivalent.
 *
 * It is not equivalent, and this file pins the difference. Declaring the
 * permission puts the route inside `security/authorization.md` §1's triple
 * (user, organisation, permission), which means `TenantContextGuard` must
 * resolve a membership before it runs — so a signed-in caller who belongs to no
 * organisation, or who has not switched into one, gets **404** rather than the
 * product's whole authority model.
 */

// eslint-disable-next-line @typescript-eslint/unbound-method -- read as a metadata target, never invoked.
const handler: object = RolesController.prototype.list;

describe('GET /api/v1/roles', () => {
  it('is registered on the expected path with the expected method', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RolesController)).toBe('roles');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('declares `organization.read` rather than being authenticated-only', () => {
    const declared = Reflect.getMetadata(ACCESS_METADATA_KEY, handler) as AccessDeclaration;
    expect(declared).toEqual({ kind: 'permission', permission: 'organization.read' });
  });

  it('names a permission every system role holds, which is what makes it a picker and not a gate', () => {
    // Derived from `ROLE_PERMISSIONS`, not asserted from memory. If
    // `organization.read` were ever removed from a role, this route would start
    // refusing that role and the picker would break for them — and this test is
    // what would say so, rather than a support ticket.
    const without = SYSTEM_ROLES.filter(
      (role) => !ROLE_PERMISSIONS[role].includes('organization.read'),
    );
    expect(without).toEqual([]);
  });

  it('carries the generalSession rate-limit class explicitly', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, handler)).toBe('generalSession');
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handler)).toBeUndefined();
  });

  it('carries no cross-site refusal, pending-MFA exemption or verified-email gate', () => {
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_PENDING_MFA_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handler)).toBeUndefined();
  });

  it('declares nothing at class level', () => {
    expect(Reflect.getMetadata(ACCESS_METADATA_KEY, RolesController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, RolesController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, RolesController)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, RolesController)).toBeUndefined();
  });

  it('exposes exactly one handler', () => {
    const handlers = Object.getOwnPropertyNames(RolesController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers).toEqual(['list']);
  });
});
