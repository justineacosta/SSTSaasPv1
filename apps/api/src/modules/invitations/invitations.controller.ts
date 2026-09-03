import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type CreateInvitationRequest,
  createInvitationRequestSchema,
  type InvitationCollection,
  invitationCollectionSchema,
  type InvitationResponse,
  invitationResponseSchema,
  type ListInvitationsQuery,
  listInvitationsQuerySchema,
  type TenantContext,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { RequirePermission } from '../../common/decorators/access.decorator.js';
import { Ctx } from '../../common/decorators/ctx.decorator.js';
import { RequireVerifiedEmail } from '../../common/decorators/email-verified.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { principalOf, requestContextOf } from '../auth/request-context.js';
import { decodeListCursor } from '../organizations/list-cursor.js';
import { InvitationService } from './invitation.service.js';

/**
 * THE THREE TENANT-SCOPED INVITATION ROUTES.
 *
 * # `POST /api/v1/invitations/accept` IS NOT HERE, AND IT IS BLOCKED RATHER
 * THAN FORGOTTEN
 *
 * The plan and this task's brief both ask for a fourth route: an authenticated,
 * tenant-less `POST /api/v1/invitations/accept` taking the token in the body
 * (D1). It is not shipped, and the reason is a measurement rather than a
 * preference.
 *
 * The acceptor is not a member of anything yet, so `TenantContextGuard`
 * resolves no organisation and `withTenantTransaction` has no id to set
 * `app.organization_id` to. `Invitation` carries `FORCE ROW LEVEL SECURITY`
 * with `USING ("organizationId" = current_setting('app.organization_id',
 * true))` (`20260820121229_row_level_security`), and `sentinel_app` is neither
 * a superuser nor `BYPASSRLS` (`pg_roles`: `rolsuper = f`, `rolbypassrls = f`).
 * So the handler cannot read the invitation its own token names.
 *
 * Measured against the compose Postgres on 2026-09-04, one transaction,
 * `SET LOCAL ROLE sentinel_app`, `SELECT count(*) FROM "Invitation" WHERE
 * "tokenHash" = '<a known hash>'`:
 *
 *     no app.organization_id set  -> 0
 *     owning organisation set     -> 1
 *     a different organisation set-> 0
 *
 * There is no query this endpoint can make. The two ways out both need a
 * decision this task was not given: a second migration adding a
 * `SECURITY DEFINER` lookup beside `user_organizations()` (ADR-0021), which the
 * operator reviews as SQL before it is applied (execution protocol §5); or
 * changing the invitation token's format so the organisation id travels in it,
 * which makes one endpoint's tenant context derive from client input and
 * changes a credential shape ruling 41 already fixed. Handed up rather than
 * chosen.
 *
 * Everything the acceptance path would consume is in place and unused:
 * `acceptInvitationRequestSchema`, `acceptInvitationResponseSchema`,
 * `INVITATION_ACCEPTED` in `AUDIT_ACTIONS`, and the `LIVE_INVITATION` predicate.
 *
 * # D10 — `MembershipStatus.INVITED` GETS NO PRODUCER, DELIBERATELY
 *
 * The plan says acceptance creates the `Membership`, so no `Membership` row
 * exists while an invitation is pending and nothing here writes `'INVITED'`.
 * `grep -rn "'INVITED'" apps/api/src packages` finds it only in type unions,
 * test fixtures and `assertOrganizationKeepsAnOwner`'s reasoning about it. The
 * value stays in the enum because the schema defines it and
 * `enum-parity.spec.ts` requires the restatements to agree; it is not started
 * here because a status nothing sets is cheaper than a status two paths set
 * differently.
 *
 * # The path is `organizations/:id/invitations`, and `:id` is checked rather
 * than read
 *
 * Task 13's rule, and `assertPathIsActiveTenant` is the one place it lives:
 * `TenantContextGuard` resolves the organisation from
 * `Session.activeOrganizationId`, `:id` is compared **against** that, and any
 * other value is 404. Nothing here resolves the tenant from the path, because
 * that would make tenant selection an input.
 *
 * # Rate limiting
 *
 * `create` carries `invitations` — `abuse-prevention.md` §1's 50/day per
 * organisation, fail-closed. **That class could not be applied to any route
 * before this task.** `perOrganization` is its only scope, its identifier comes
 * from `TenantContextGuard`, and the limiter ran once, before authentication —
 * so a route carrying it answered 429 to everything. Task 15 split the limiter
 * into two stages (`RATE_LIMIT_SCOPE_PHASES`, `TenantRateLimitGuard`); this is
 * the first route that class has ever governed.
 *
 * The cost of that class having no `perIp` window is worth stating: an
 * unauthenticated flood at this route pays authentication, tenant resolution
 * and the permission check before anything refuses it. That is no worse than
 * the `generalSession` default, which is fail-open and (carry-forward ruling
 * 55) resolves nothing — but it is not better either, and the per-IP stage that
 * would bound it is the one §1 does not give this row.
 *
 * `list` and `revoke` carry `generalSession` explicitly, exactly as the
 * membership and organisation routes do.
 */
@Controller({ path: 'organizations/:id/invitations', version: '1' })
export class InvitationsController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  /**
   * Invites an address to this organisation at a role.
   *
   * **`@RequireVerifiedEmail()` fires here, and it does not on the membership
   * routes.** `security/authentication.md` §6: an unverified user "cannot create
   * organisations, invite, or scan". Inviting is in that sentence's list, and
   * this route makes this product send mail to a third party on the caller's
   * say-so — which is precisely the capability an unverified account must not
   * have.
   *
   * Two refusals here are not the guard's and are worth naming at the route:
   * **403** when the role being offered holds a permission the caller does not
   * themselves hold (`security/authorization.md` §4's no-minting rule, at its
   * third call site), and **409** when the address is already a live member.
   */
  @RequirePermission('organization.manage_members')
  @RequireVerifiedEmail()
  @RateLimit('invitations')
  @ApiDoc({
    summary: 'Invite an address to an organisation.',
    description:
      'Creates an invitation to the organisation the session is currently acting in and emails ' +
      'a single-use link to the address named. Requires `organization.manage_members` **and a ' +
      'verified email address** — `security/authentication.md` §6 says an unverified account ' +
      'cannot invite. Writes a `MEMBER_INVITED` audit event in the same transaction. The ' +
      'invitation is bound to the address it names, expires in 7 days, and only a SHA-256 hash ' +
      'of its token is stored: **the raw token appears in the email and nowhere else, including ' +
      'in this response**. **The role offered may not hold a permission the caller does not hold ' +
      'themselves** — an `ADMIN` cannot invite an `OWNER`, because `OWNER` holds ' +
      '`organization.delete` and `ADMIN` does not; that is refused with 403 `PERMISSION_DENIED` ' +
      'naming the permission that is missing. **Re-inviting an address supersedes**: any ' +
      'invitation to that address in this organisation that has not been accepted or revoked is ' +
      'revoked in the same transaction, including an expired one, and the new invitation records ' +
      'the superseded id in its audit metadata. That is what makes re-inviting somebody who was ' +
      'removed from the organisation work. An address that is already a live member is refused ' +
      'with 409 `DUPLICATE_RESOURCE`. Rate limited to 50 per day per organisation. Requires ' +
      '`X-CSRF-Token`.',
    requestBody: {
      description:
        'The address to invite and the role to offer. The schema is strict, so an unknown key ' +
        'is a 400 — in particular there is no `expiresAt` and no `token`, both of which are the ' +
        "server's.",
      schema: createInvitationRequestSchema,
    },
    responses: [
      { status: 201, description: 'The invitation.', schema: invitationResponseSchema },
      {
        status: 400,
        description: 'The body did not validate (`VALIDATION_ERROR`, `UNKNOWN_FIELD`).',
      },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.manage_members`, the caller’s own address is unverified ' +
          '(`EMAIL_NOT_VERIFIED`), the role offered exceeds the caller’s own permissions ' +
          '(`PERMISSION_DENIED`), the organisation is suspended, or a CSRF failure.',
      },
      {
        status: 404,
        description: "The path id is not the session's active organisation (`RESOURCE_NOT_FOUND`).",
      },
      {
        status: 409,
        description: 'That address is already a live member (`DUPLICATE_RESOURCE`).',
      },
      { status: 429, description: 'More than 50 invitations in a day (`RATE_LIMITED`).' },
    ],
  })
  @HttpCode(201)
  @Post()
  async create(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
    @Req() request: Request,
  ): Promise<InvitationResponse> {
    return this.invitations.create(ctx, id, {
      actorUserId: principalOf(request).userId,
      email: body.email,
      roleKey: body.roleKey,
      ...requestContextOf(request),
    });
  }

  /**
   * The organisation's invitations, newest first.
   *
   * **The response never carries a token.** `invitationResponseSchema` has no
   * such field, the `select` in `invitation.service.ts` never reads the column,
   * and `invitations.spec.ts` in `packages/contracts` pins the schema-stripping
   * half.
   */
  @RequirePermission('organization.manage_members')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'List an organisation’s invitations.',
    description:
      'Every invitation the organisation the session is currently acting in has issued, newest ' +
      'first — pending, accepted, revoked and expired alike, so that a reader can answer "was ' +
      'this address ever invited". A client rendering pending invitations filters on ' +
      '`acceptedAt === null && revokedAt === null && expiresAt` in the future. Requires ' +
      '`organization.manage_members`. **No row carries a token**: only a SHA-256 hash of it is ' +
      'ever stored, and neither the hash nor the token is published here. The `:id` in the path ' +
      "is checked **against** the session's active organisation rather than used to select one. " +
      'Cursor paginated: `limit` defaults to 50 and is **clamped** to 100 rather than rejected, ' +
      'and `pagination.limit` echoes the limit that was applied. `pagination.nextCursor` is ' +
      'opaque and its encoding is not part of this contract; a cursor this endpoint did not ' +
      'issue is a 400.',
    responses: [
      { status: 200, description: 'One page of invitations.', schema: invitationCollectionSchema },
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
    @Query(new ZodValidationPipe(listInvitationsQuerySchema)) query: ListInvitationsQuery,
  ): Promise<InvitationCollection> {
    return this.invitations.list(ctx, id, {
      limit: query.limit,
      cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
    });
  }

  /**
   * Revokes a pending invitation. The link in that email stops working.
   *
   * An invitation that has already been accepted, has already been revoked, or
   * belongs to another organisation all answer the same 404 — the byte-identical
   * refusal `organization.service.ts`'s `notFound()` builds, because a 403 would
   * confirm the resource exists (`security/authorization.md` §6).
   */
  @RequirePermission('organization.manage_members')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Revoke a pending invitation.',
    description:
      'Marks one invitation in the organisation the session is currently acting in as revoked ' +
      'and writes an `INVITATION_REVOKED` audit event in the same transaction. The link that ' +
      'was emailed stops working immediately. Requires `organization.manage_members`. The row ' +
      'is retained with a `revokedAt` timestamp rather than deleted, which is what keeps the ' +
      'trail of who was invited and what happened to it. An invitation that has already been ' +
      'accepted, one that has already been revoked, one that does not exist and one belonging ' +
      'to another organisation all answer the same 404. **Superseding is not revoking**: ' +
      'inviting the same address again also clears the older invitation, and records that as ' +
      'metadata on the new `MEMBER_INVITED` event rather than as a second `INVITATION_REVOKED` ' +
      'event with no actor. Requires `X-CSRF-Token`.',
    responses: [
      { status: 204, description: 'Revoked.' },
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
          'The path id is not the session’s active organisation, or no live invitation with ' +
          'that id exists in it (`RESOURCE_NOT_FOUND`).',
      },
    ],
  })
  @HttpCode(204)
  @Delete(':invitationId')
  async revoke(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.invitations.revoke(ctx, id, invitationId, {
      actorUserId: principalOf(request).userId,
      ...requestContextOf(request),
    });
  }
}
