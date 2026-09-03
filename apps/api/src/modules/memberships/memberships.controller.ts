import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import {
  type ListMembershipsQuery,
  listMembershipsQuerySchema,
  type MembershipCollection,
  membershipCollectionSchema,
  type MembershipResponse,
  membershipResponseSchema,
  type TenantContext,
  type UpdateMembershipRequest,
  updateMembershipRequestSchema,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { RequirePermission } from '../../common/decorators/access.decorator.js';
import { Ctx } from '../../common/decorators/ctx.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { principalOf, requestContextOf } from '../auth/request-context.js';
import { decodeListCursor } from '../organizations/list-cursor.js';
import { MembershipService } from './membership.service.js';

/**
 * THE THREE MEMBERSHIP ROUTES.
 *
 * # The path is `organizations/:id/members/:membershipId`, and `:id` is checked
 * rather than read
 *
 * Task 13 established the rule and `assertPathIsActiveTenant` is the one place
 * it lives: `TenantContextGuard` resolves the organisation from
 * `Session.activeOrganizationId`, `:id` is compared **against** that, and any
 * other value is 404. Nothing here resolves the tenant from the path, because
 * that would make tenant selection an input — which is the whole thing Task
 * 12's pipeline exists to prevent. This controller writes no second copy of the
 * check; it imports the one Task 13 wrote.
 *
 * # Why the list is `organization.manage_members` and not `organization.read`
 *
 * The plan says all three membership routes require `organization.manage_members`,
 * and role changes additionally `organization.manage_roles`.
 * `packages/contracts/src/memberships.ts` carried a docblock asserting that "a
 * member list is readable by anyone with `organization.read`"; that sentence
 * was corrected in the same change as this file, because a shipped contract
 * describing a permission the API does not use is worse than no sentence.
 *
 * The reasoning, recorded so it is not re-opened: widening a route from
 * `manage_members` to `organization.read` later is additive and breaks no
 * client, while narrowing it is a breaking change to a shipped contract. And
 * the docblock's own argument — that a colleague's `lastLoginAt` and
 * `lockedUntil` are not their team's business — is *stronger* under the
 * narrower permission, not weaker. The narrow user projection stays either way.
 *
 * # Rate limiting
 *
 * All three carry `generalSession` explicitly, exactly as the five organisation
 * routes do. `abuse-prevention.md` §1's table has no membership-specific class
 * and inventing one here would put a limit in `rate-limit.config.ts` that the
 * document does not name. Carry-forward ruling 55 still applies: the class keys
 * on an authenticated principal and the limiter runs before the authentication
 * guard, so it resolves nothing and applies to no request today.
 */
@Controller({ path: 'organizations/:id/members', version: '1' })
export class MembershipsController {
  constructor(@Inject(MembershipService) private readonly memberships: MembershipService) {}

  /**
   * The organisation's live members, newest first.
   *
   * A removed member is absent, and a member removed and re-added appears once
   * — the `deletedAt: null` predicate of carry-forward ruling 99, which this
   * endpoint's own `DELETE` is what creates the need for.
   */
  @RequirePermission('organization.manage_members')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'List the members of an organisation.',
    description:
      'The live memberships of the organisation the session is currently acting in, newest ' +
      'first. Requires `organization.manage_members`. The `:id` in the path is checked ' +
      "**against** the session's active organisation rather than used to select one: any other " +
      'id answers 404, including one belonging to an organisation the caller is a member of but ' +
      'is not currently acting in. Removed members are not listed, and a member who was removed ' +
      'and later re-added appears exactly once. Each row carries only the id, email address and ' +
      "display name of the member — a colleague's sign-in history and lock state are the " +
      'account owner’s business. Cursor paginated: `limit` defaults to 50 and is **clamped** to ' +
      '100 rather than rejected, and `pagination.limit` echoes the limit that was applied. ' +
      '`pagination.nextCursor` is opaque and its encoding is not part of this contract; a cursor ' +
      'this endpoint did not issue is a 400.',
    responses: [
      { status: 200, description: 'One page of members.', schema: membershipCollectionSchema },
      { status: 400, description: 'The query did not validate, or the cursor was malformed.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.manage_members`, or the organisation is suspended.',
      },
      {
        status: 404,
        description: "The path id is not the session's active organisation (`RESOURCE_NOT_FOUND`).",
      },
    ],
  })
  @Get()
  async list(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(listMembershipsQuerySchema)) query: ListMembershipsQuery,
  ): Promise<MembershipCollection> {
    return this.memberships.list(ctx, id, {
      limit: query.limit,
      cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
    });
  }

  /**
   * Changes one member's role.
   *
   * Two refusals here are not the guard's and are worth naming at the route:
   * **403** when the role being granted holds a permission the caller does not
   * themselves hold (`security/authorization.md` §4's no-minting rule), and
   * **422** when the change would leave the organisation with no owner.
   */
  @RequirePermission('organization.manage_roles')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: "Change a member's role.",
    description:
      'Sets the role of one membership in the organisation the session is currently acting in, ' +
      'and writes a `ROLE_CHANGED` audit event in the same transaction with the before and after ' +
      'role. Requires `organization.manage_roles`. **The role granted may not hold a permission ' +
      'the caller does not hold themselves** — an `ADMIN` cannot promote anybody to `OWNER`, ' +
      'because `OWNER` holds `organization.delete` and `ADMIN` does not; that is refused with ' +
      '403 `PERMISSION_DENIED` naming the permission that is missing. **The last owner cannot ' +
      'be demoted**: a change that would leave the organisation with no `OWNER` is refused with ' +
      '422 `INVALID_STATE_TRANSITION`, decided under a row lock on the organisation so that two ' +
      'concurrent demotions cannot both succeed. Role is the only patchable field: `status` is ' +
      'deliberately absent because removal is a soft delete and a database CHECK constraint ' +
      'makes "removed" and "soft-deleted" one fact. A membership belonging to another ' +
      'organisation, one that does not exist, and one that has already been removed all answer ' +
      'the same 404. Requires `X-CSRF-Token`.',
    requestBody: {
      description: 'The new role key. The schema is strict, so an unknown key is a 400.',
      schema: updateMembershipRequestSchema,
    },
    responses: [
      { status: 200, description: 'The updated membership.', schema: membershipResponseSchema },
      {
        status: 400,
        description: 'The body did not validate (`VALIDATION_ERROR`, `UNKNOWN_FIELD`).',
      },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.manage_roles`, the granted role exceeds the caller’s own ' +
          'permissions, the organisation is suspended, or a CSRF failure.',
      },
      {
        status: 404,
        description:
          'The path id is not the session’s active organisation, or no live membership with ' +
          'that id exists in it (`RESOURCE_NOT_FOUND`).',
      },
      {
        status: 422,
        description:
          'The change would leave the organisation with no owner (`INVALID_STATE_TRANSITION`).',
      },
    ],
  })
  @Patch(':membershipId')
  async update(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @Body(new ZodValidationPipe(updateMembershipRequestSchema)) body: UpdateMembershipRequest,
    @Req() request: Request,
  ): Promise<MembershipResponse> {
    return this.memberships.updateRole(ctx, id, membershipId, {
      actorUserId: principalOf(request).userId,
      roleKey: body.roleKey,
      ...requestContextOf(request),
    });
  }

  /**
   * Removes a member — a soft delete, and their sessions for this organisation
   * with it.
   *
   * Their sessions pointed at *other* organisations, and at none, survive
   * deliberately: `permissions.md` invariant 5 says "for that organisation",
   * and carry-forward ruling 95 is why the difference matters — a member whose
   * every session was revoked would hold a credential no endpoint answers,
   * including the one that ends it.
   */
  @RequirePermission('organization.manage_members')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Remove a member from an organisation.',
    description:
      'Soft-deletes one membership in the organisation the session is currently acting in and ' +
      'writes a `MEMBER_REMOVED` audit event in the same transaction. Requires ' +
      '`organization.manage_members`. The row is retained with a `deletedAt` timestamp rather ' +
      'than deleted, which is what allows the same person to be re-added later. **The last ' +
      'owner cannot be removed**: a removal that would leave the organisation with no `OWNER` ' +
      'is refused with 422 `INVALID_STATE_TRANSITION`, decided under a row lock on the ' +
      'organisation so that two concurrent removals cannot both succeed. The removed member’s ' +
      'sessions **for this organisation** are revoked immediately, on their next request rather ' +
      'than at a cache expiry; their sessions pointed at other organisations, or at none, are ' +
      'deliberately left alone so that removal never locks somebody out of their own account. ' +
      'A membership belonging to another organisation, one that does not exist, and one that has ' +
      'already been removed all answer the same 404. Requires `X-CSRF-Token`.',
    responses: [
      { status: 204, description: 'Removed.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.manage_members`, the organisation is suspended, or a ' +
          'CSRF failure.',
      },
      {
        status: 404,
        description:
          'The path id is not the session’s active organisation, or no live membership with ' +
          'that id exists in it (`RESOURCE_NOT_FOUND`).',
      },
      {
        status: 422,
        description:
          'The removal would leave the organisation with no owner (`INVALID_STATE_TRANSITION`).',
      },
    ],
  })
  @HttpCode(204)
  @Delete(':membershipId')
  async remove(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.memberships.remove(ctx, id, membershipId, {
      actorUserId: principalOf(request).userId,
      ...requestContextOf(request),
    });
  }
}
