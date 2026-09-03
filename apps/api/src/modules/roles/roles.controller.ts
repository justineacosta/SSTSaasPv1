import { Controller, Get, Inject } from '@nestjs/common';
import { type RoleCollection, roleCollectionSchema } from '@sentinel/contracts';
import { RequirePermission } from '../../common/decorators/access.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ROLE_CATALOG } from './roles.tokens.js';
import type { RoleCatalog } from './role-catalog.store.js';

/**
 * `GET /api/v1/roles` — the seeded system roles and their permissions, for the
 * UI's role picker.
 *
 * # Why `organization.read` and not `@AuthenticatedOnly()`
 *
 * Every system role holds `organization.read`, so the permission excludes
 * nobody who is a member of the organisation they are acting in — which is the
 * point. A role picker is a thing you use *inside* an organisation, on the way
 * to `PATCH /organizations/{id}/members/{membershipId}` or to an invitation, and
 * declaring the permission is what puts this route inside
 * `security/authorization.md` §1's triple (user, organisation, permission)
 * rather than beside it.
 *
 * The observable consequence is worth stating because it looks like a bug from
 * outside: a session that has chosen no organisation resolves no tenant, and
 * `AuthorizationGuard` fails closed as **404** rather than 403 — so this route
 * answers 404 to a signed-in caller who has not switched into an organisation
 * yet. That is the same fail-closed direction every guarded route takes and it
 * is deliberate; the alternative, `@AuthenticatedOnly()`, would publish the
 * product's authority model to anybody who could sign up.
 *
 * # Reference data, and custom roles are Phase 11
 *
 * Rows are addressed by `key`, never by the `Role` row's id — that is why `rol`
 * sits on the db-only side of `id-prefix-parity.spec.ts`'s allowlist. Handing
 * clients a row id would invite them to store one.
 */
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(@Inject(ROLE_CATALOG) private readonly roles: RoleCatalog) {}

  @RequirePermission('organization.read')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'List the roles that can be assigned in an organisation.',
    description:
      'The seeded system roles and the permissions each one grants, in the order a role picker ' +
      'should show them — `OWNER` first, `GUEST` last. Requires `organization.read`, which every ' +
      'system role holds: the list is read **inside** an organisation, so a session that has not ' +
      'switched into one resolves no tenant and receives 404. **Custom, per-organisation roles ' +
      'are Phase 11 and do not exist yet**; every row returned here has `isSystem: true`, and ' +
      'the field is published now so a client can already tell the two apart rather than needing ' +
      'it added later to a shape it depends on. Roles are addressed by `key` and never by a row ' +
      'id. The permission list is read from the seeded grant rows — the same rows the ' +
      'authorization guard decides against — so what this endpoint shows and what the API ' +
      'enforces cannot drift. The response carries the standard collection envelope; the set is ' +
      'complete and bounded, so `hasMore` is always false and `nextCursor` always null.',
    responses: [
      { status: 200, description: 'Every system role.', schema: roleCollectionSchema },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      { status: 403, description: 'The organisation is suspended.' },
      {
        status: 404,
        description: 'The session is acting in no organisation (`RESOURCE_NOT_FOUND`).',
      },
    ],
  })
  @Get()
  async list(): Promise<RoleCollection> {
    return this.roles();
  }
}
