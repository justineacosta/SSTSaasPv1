import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type CreateOrganizationRequest,
  createOrganizationRequestSchema,
  type ListOrganizationsQuery,
  listOrganizationsQuerySchema,
  type OrganizationCollection,
  organizationCollectionSchema,
  type OrganizationResponse,
  organizationResponseSchema,
  type TenantContext,
  type UpdateOrganizationRequest,
  updateOrganizationRequestSchema,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { AuthenticatedOnly, RequirePermission } from '../../common/decorators/access.decorator.js';
import { Ctx } from '../../common/decorators/ctx.decorator.js';
import { RequireVerifiedEmail } from '../../common/decorators/email-verified.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { principalOf, requestContextOf } from '../auth/request-context.js';
import { decodeListCursor } from './list-cursor.js';
import { OrganizationService } from './organization.service.js';

/**
 * THE FIVE ORGANISATION ROUTES, AND THE FIRST THREE IN THIS PRODUCT TO DECLARE
 * A PERMISSION.
 *
 * Until this file, every one of the eighteen shipped routes was `@Public()` or
 * `@AuthenticatedOnly()`, so layers 2–4 of `security/authorization.md` §2
 * governed nothing — carry-forward ruling 93 and the Task 12 pause state both
 * say so in as many words. `GET`, `PATCH` and `DELETE` on `:id` are where
 * `AuthorizationGuard` begins deciding real requests.
 *
 * # Why two of them are NOT permission-guarded, and that is not an inconsistency
 *
 * `security/authorization.md` §1: a permission is always
 * (user, organisation, permission). Two of these routes have no organisation to
 * hold one in.
 *
 * - `POST /organizations` creates the organisation the permission would live
 *   in. There is nothing to be an `OWNER` of yet, so it is `@AuthenticatedOnly()`
 *   and gated on a **verified email** instead — `security/authentication.md` §6,
 *   "unverified users may sign in but cannot create organisations".
 * - `GET /organizations` asks which organisations the caller belongs to, which
 *   is a question about a user and about no tenant. `access.decorator.ts`
 *   already names it as an `@AuthenticatedOnly()` case in its own docblock:
 *   *"listing the organisations you belong to, switching between them"*.
 *   ADR-0020 restates it.
 *
 * # `@RequireVerifiedEmail()` fires here for the first time
 *
 * `EmailVerifiedGuard` was built in Task 8, registered in Task 12, and carried
 * by **no handler** — an opt-in control that had never refused anybody. `create`
 * below is the first handler to carry it, which means this is also the first
 * task in which an unverified caller can be refused by it. That is proved
 * against a real unverified account in `organizations.integration.spec.ts`
 * rather than asserted here.
 *
 * # The path id is never the tenant
 *
 * `TenantContextGuard` resolves the organisation from
 * `Session.activeOrganizationId`. `:id` is checked *against* that and a
 * mismatch is 404 — see `assertPathIsActiveTenant` in `organization.service.ts`
 * for the full argument. Nothing here reads the path to decide which tenant to
 * act in, because that would make tenant selection an input.
 *
 * # Rate limiting
 *
 * All five carry `generalSession` explicitly. `abuse-prevention.md` §1's table
 * has no organisation-specific class and inventing one here would put a limit
 * in `rate-limit.config.ts` that the document does not name — the transcription
 * runs document-to-code, not the other way. Declaring the class rather than
 * letting the route fall to it silently is the same bookkeeping `logout` and
 * `session` do, and it is what lets an exhaustiveness test say somebody chose.
 * Carry-forward ruling 55 still applies: `generalSession` keys on an
 * authenticated principal, the limiter runs before the authentication guard,
 * and so it resolves nothing and applies to no request.
 */
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(@Inject(OrganizationService) private readonly organizations: OrganizationService) {}

  /**
   * Creates an organisation, the caller's `OWNER` membership in it, and the
   * audit event — in one transaction.
   *
   * **201, with no `Location` header.** `api/conventions.md` §2 gives 201 to a
   * creation; the header is omitted because the resource it would point at,
   * `/api/v1/organizations/:id`, answers 404 to this very caller until they
   * switch into the new organisation. A `Location` a client cannot follow is
   * worse than none, and the body already carries the id the client needs for
   * `POST /auth/switch-org`.
   */
  @AuthenticatedOnly()
  @RequireVerifiedEmail()
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Create an organisation.',
    description:
      'Creates the organisation, the caller as its `OWNER`, and an `ORGANIZATION_CREATED` audit ' +
      'event, in one transaction. Requires a **verified** email address: an account that has ' +
      'signed in but not confirmed its address is refused with 403 `EMAIL_NOT_VERIFIED`. The ' +
      'slug must be unique across the whole product and is normalised to lower case before it ' +
      'is checked; a collision answers 409 `DUPLICATE_RESOURCE`. Creating an organisation does ' +
      'not switch into it — the session still names whatever organisation it named before, and ' +
      '`POST /api/v1/auth/switch-org` is what changes that. Requires `X-CSRF-Token`.',
    requestBody: {
      description:
        'The slug is trimmed and lower-cased, and must be 3–63 characters of lowercase letters, ' +
        'digits and single hyphens. The schema is strict, so an unknown key is a 400.',
      schema: createOrganizationRequestSchema,
    },
    responses: [
      { status: 201, description: 'The new organisation.', schema: organizationResponseSchema },
      {
        status: 400,
        description: 'The body did not validate (`VALIDATION_ERROR`, `UNKNOWN_FIELD`).',
      },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'Address not verified (`EMAIL_NOT_VERIFIED`), or a CSRF failure (`CSRF_TOKEN_INVALID`).',
      },
      { status: 409, description: 'The slug is already taken (`DUPLICATE_RESOURCE`).' },
    ],
  })
  @HttpCode(201)
  @Post()
  async create(
    @Body(new ZodValidationPipe(createOrganizationRequestSchema)) body: CreateOrganizationRequest,
    @Req() request: Request,
  ): Promise<OrganizationResponse> {
    return this.organizations.create({
      userId: principalOf(request).userId,
      name: body.name,
      slug: body.slug,
      ...requestContextOf(request),
    });
  }

  /**
   * The organisations the caller is an active member of, newest first.
   *
   * `userId` comes from `principalOf(request)` — the session
   * `AuthenticationGuard` resolved — and from nowhere else. Carry-forward
   * ruling 9's rule for a user-owned read, and ADR-0020 states it as a
   * requirement rather than a preference: there is no path parameter, query
   * field or body key on this endpoint that could reach that argument.
   */
  @AuthenticatedOnly()
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'List the organisations you belong to.',
    description:
      'The organisations in which the caller holds an `ACTIVE`, non-removed membership, newest ' +
      'first. Not permission-guarded, because the question is about a user and about no ' +
      'organisation — a permission is always (user, organisation, permission). Cursor ' +
      'paginated: `limit` defaults to 50 and is **clamped** to 100 rather than rejected, and ' +
      '`pagination.limit` echoes the limit that was applied. `pagination.nextCursor` is opaque ' +
      'and its encoding is not part of this contract; a cursor this endpoint did not issue is a ' +
      '400. Suspended organisations are listed — membership is what this answers, not ' +
      'entitlement to act.',
    responses: [
      {
        status: 200,
        description: 'One page of organisations.',
        schema: organizationCollectionSchema,
      },
      { status: 400, description: 'The query did not validate, or the cursor was malformed.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
    ],
  })
  @Get()
  async list(
    @Query(new ZodValidationPipe(listOrganizationsQuerySchema)) query: ListOrganizationsQuery,
    @Req() request: Request,
  ): Promise<OrganizationCollection> {
    return this.organizations.list({
      userId: principalOf(request).userId,
      limit: query.limit,
      cursor: query.cursor === undefined ? null : decodeListCursor(query.cursor),
    });
  }

  /**
   * The organisation this session is acting in.
   *
   * `@Ctx()` throws when no tenant resolved, and on a `@RequirePermission()`
   * route that is unreachable: `TenantContextGuard` has already answered 404,
   * and `AuthorizationGuard` refuses again if the context is somehow absent.
   */
  @RequirePermission('organization.read')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Read one organisation.',
    description:
      'Returns the organisation the session is currently acting in. The `:id` in the path is ' +
      "checked **against** the session's active organisation rather than used to select one: " +
      'any other id answers 404, including an id that does not exist, one belonging to another ' +
      'tenant, and one belonging to an organisation the caller is a member of but is not ' +
      'currently acting in. Switch with `POST /api/v1/auth/switch-org` first. 404 rather than ' +
      '403 for the cross-tenant case, because a 403 would confirm the resource exists.',
    responses: [
      { status: 200, description: 'The organisation.', schema: organizationResponseSchema },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description: 'The role lacks `organization.read`, or the organisation is suspended.',
      },
      {
        status: 404,
        description: "The path id is not the session's active organisation (`RESOURCE_NOT_FOUND`).",
      },
    ],
  })
  @Get(':id')
  async read(@Ctx() ctx: TenantContext, @Param('id') id: string): Promise<OrganizationResponse> {
    return this.organizations.read(ctx, id);
  }

  /**
   * Renames the organisation this session is acting in.
   *
   * Phase 2 patches the name and nothing else. `slug` is absent because it
   * appears in URLs a customer has bookmarked; `requireMfa` and
   * `enforcedEmailDomain` are absent for the sharper reason
   * `organizations.ts`'s docblock gives — a security setting a customer can
   * switch on while no code reads it is worse than one that is not offered.
   */
  @RequirePermission('organization.update')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Update one organisation.',
    description:
      'Patches the organisation the session is currently acting in, and writes an ' +
      '`ORGANIZATION_UPDATED` audit event in the same transaction with the before and after ' +
      'values. The name is the only patchable field in this version: `slug` is deliberately ' +
      'absent because it appears in URLs customers have bookmarked, and `requireMfa` and ' +
      '`enforcedEmailDomain` are absent because nothing would read them yet. An empty patch is ' +
      'a 400 — answering 200 to a no-op teaches a client that its update worked. Path id ' +
      'handling is the same as the read above. Requires `X-CSRF-Token`.',
    requestBody: {
      description: 'At least one field. The schema is strict and refuses `{}`.',
      schema: updateOrganizationRequestSchema,
    },
    responses: [
      { status: 200, description: 'The updated organisation.', schema: organizationResponseSchema },
      { status: 400, description: 'The body did not validate, or was empty.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.update`, the organisation is suspended, or a CSRF failure.',
      },
      {
        status: 404,
        description: "The path id is not the session's active organisation (`RESOURCE_NOT_FOUND`).",
      },
    ],
  })
  @Patch(':id')
  async update(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
    @Req() request: Request,
  ): Promise<OrganizationResponse> {
    return this.organizations.update(ctx, id, {
      userId: principalOf(request).userId,
      name: body.name,
      ...requestContextOf(request),
    });
  }

  /**
   * Deletes the organisation this session is acting in — and in practice always
   * refuses.
   *
   * `AuditEvent.organizationId` is `onDelete: Restrict` and every organisation
   * this API created carries an `ORGANIZATION_CREATED` row, so the foreign key
   * refuses the delete and the answer is 409. `organization.service.ts` has the
   * measurement and the reason the constraint is not weakened.
   */
  @RequirePermission('organization.delete')
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Delete one organisation.',
    description:
      'Deletes the organisation the session is currently acting in. **In this version it always ' +
      'answers 409.** `AuditEvent.organizationId` is `ON DELETE RESTRICT`, and every ' +
      'organisation created through this API carries an `ORGANIZATION_CREATED` event from the ' +
      'transaction that created it — so the database refuses the deletion while that history ' +
      'exists, which is the intended Phase 2 behaviour rather than a defect. Audit history is ' +
      'not discarded to satisfy a delete request; purging an organisation and its records is a ' +
      'platform-administration operation in a later phase. Path id handling is the same as the ' +
      "read above, and the 404 arm is checked first: a caller naming somebody else's " +
      'organisation learns nothing about whether it exists. Requires `X-CSRF-Token`.',
    responses: [
      { status: 204, description: 'Deleted. Unreachable for any organisation this API created.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      {
        status: 403,
        description:
          'The role lacks `organization.delete`, the organisation is suspended, or a CSRF failure.',
      },
      {
        status: 404,
        description: "The path id is not the session's active organisation (`RESOURCE_NOT_FOUND`).",
      },
      {
        status: 409,
        description: 'The organisation has an audit history (`INVALID_STATE_TRANSITION`).',
      },
    ],
  })
  @HttpCode(204)
  @Delete(':id')
  async remove(@Ctx() ctx: TenantContext, @Param('id') id: string): Promise<void> {
    await this.organizations.remove(ctx, id);
  }
}
