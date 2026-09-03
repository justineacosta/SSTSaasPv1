import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  type AcceptInvitationRequest,
  acceptInvitationRequestSchema,
  type AcceptInvitationResponse,
  acceptInvitationResponseSchema,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { AuthenticatedOnly } from '../../common/decorators/access.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { principalOf, requestContextOf } from '../auth/request-context.js';
import { InvitationService } from './invitation.service.js';

/**
 * `POST /api/v1/invitations/accept`, ALONE ON ITS OWN CONTROLLER.
 *
 * # Why it is not on `InvitationsController`
 *
 * D1. That controller is mounted at `organizations/:id/invitations` and every
 * route on it declares `organization.manage_members`. This one is **tenant-less
 * and permission-less by construction**: the acceptor is a member of nothing,
 * so `TenantContextGuard` resolves no organisation and any
 * `@RequirePermission()` would deny every request — there is no organisation in
 * which the caller could hold the permission. Mounting it under
 * `organizations/:id` would additionally make the caller name the organisation
 * they are joining, which is a fact the token already carries and which a
 * client could then get wrong or lie about.
 *
 * A second controller rather than a second `@Controller()` decorator on one
 * class, because the two have different mount paths and different access arms,
 * and `invitations.controller.spec.ts` asserts the shape of each.
 *
 * # D2 — NO `@RequireVerifiedEmail()`, AND THE OMISSION IS THE DECISION
 *
 * `security/authentication.md` §6 says an unverified user "cannot create
 * organisations, invite, or scan". Accepting is not in that sentence's list,
 * and it must not be added to it: **possession of a token delivered to that
 * address is the same proof of address control the verification guard exists to
 * obtain.** Requiring the guard here would demand that proof twice and lock out
 * the exact person the invitation was for — somebody invited to a product they
 * have just registered on, whose verification mail and whose invitation mail
 * both went to the same inbox. `create` does carry the guard, because inviting
 * *is* in that sentence's list.
 *
 * `invitations.controller.spec.ts` asserts the absence per handler, in both
 * directions, so this cannot be "fixed" by a later reader who reads the guard's
 * name and not this paragraph.
 *
 * # F-3 — IT CANNOT CARRY ANY `perOrganization` RATE-LIMIT CLASS, AND THIS IS
 * WHERE THAT IS RECORDED
 *
 * The `invitations` class (`rate-limit.config.ts`) declares `perOrganization`
 * and nothing else, and `RATE_LIMIT_SCOPE_PHASES` puts that scope in the
 * `'tenant'` phase — evaluated by `TenantRateLimitGuard`, which keys on
 * `request.organizationId`. That property is written only in
 * `TenantContextGuard`'s `resolution.outcome === 'resolved'` arm, and **no
 * tenant resolves before this handler runs**: that is the whole premise of D1.
 * The tenant pass would therefore see `declared === 1`, `decisions.length ===
 * 0` and `failMode: 'closed'`, and answer **429 to every request** — precisely
 * the pre-split failure ADR-0023 exists to remove.
 *
 * So the route carries `generalSession`, and the cost of that is stated rather
 * than glossed: `generalSession`'s only scope is `perPrincipal` with
 * `principalSource: 'authenticated'`, and carry-forward rulings 55 and 90 leave
 * that unresolvable at the edge — the limiter's first pass runs before
 * `AuthenticationGuard`. **This endpoint therefore ships with no rate limit
 * applied to it**, exactly as `logout`, `session` and `switch-org` do.
 *
 * The bound on what that costs: the token is 256 bits of `randomBytes`
 * (`secret-token.ts`), so there is nothing to brute-force. What is unmetered is
 * an authenticated caller's ability to spend one `SECURITY DEFINER` lookup and
 * one short transaction per request. Closing it needs a `perPrincipal` window
 * that resolves after authentication, which is the second half of the split
 * ADR-0023 began and is not this route's to build.
 */
@Controller({ path: 'invitations', version: '1' })
export class InvitationAcceptanceController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  /**
   * Accepts an invitation and returns the membership it created.
   *
   * **The body carries the token and nothing else.** D11:
   * `acceptInvitationRequestSchema` is `.strict()` and has no field for an
   * address, because the server compares the invited address to the
   * *authenticated* user's — the schema's own docblock calls a body-supplied
   * address "the whole attack". The user id comes from `request.principal`,
   * which `AuthenticationGuard` resolved from the session cookie, and from
   * nowhere else.
   *
   * **Every unredeemable token is one 422 `TOKEN_INVALID` with one message** —
   * unknown, expired, revoked, already accepted, superseded, and belonging to
   * somebody else. See `InvitationService.accept` for the argument and
   * `error-codes.ts` for the rule.
   *
   * 201, because a `Membership` is created and the response is that resource.
   */
  @AuthenticatedOnly()
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Accept an invitation.',
    description:
      'Consumes a single-use invitation token and creates the caller’s membership of the ' +
      'organisation that issued it, in one transaction, with an `INVITATION_ACCEPTED` audit ' +
      'event. **The invitation must have been sent to the address the caller is signed in as** ' +
      '— the server compares the stored address to the authenticated user’s and never to ' +
      'anything in the body, which is why the body carries the token alone. This route is ' +
      'authenticated but names no organisation and requires no permission: the caller is not a ' +
      'member of anything yet, which is exactly what accepting fixes. It does **not** require a ' +
      'verified email address — holding a token that was emailed to that address is the same ' +
      'proof the verification step exists to obtain. An unknown token, an expired one, a revoked ' +
      'one, one that has already been accepted, one superseded by a newer invitation to the same ' +
      'address, and one issued to somebody else all answer the **same 422 `TOKEN_INVALID` with ' +
      'the same message**, so the endpoint is not an oracle for whether a given token exists. ' +
      'Accepting does not change which organisation the session is acting in — call ' +
      '`POST /api/v1/auth/switch-org` afterwards. Requires `X-CSRF-Token`.',
    requestBody: {
      description:
        'The raw token from the emailed link. The schema is strict, so an unknown key is a 400 ' +
        '— in particular there is no `email` and no `organizationId`, both of which the server ' +
        'derives from the token itself.',
      schema: acceptInvitationRequestSchema,
    },
    responses: [
      {
        status: 201,
        description: 'The membership just created.',
        schema: acceptInvitationResponseSchema,
      },
      {
        status: 400,
        description: 'The body did not validate (`VALIDATION_ERROR`, `UNKNOWN_FIELD`).',
      },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      { status: 403, description: 'A CSRF failure (`CSRF_TOKEN_INVALID`).' },
      {
        status: 409,
        description:
          'The caller is already a live member of that organisation (`DUPLICATE_RESOURCE`).',
      },
      {
        status: 422,
        description:
          'The token is not redeemable (`TOKEN_INVALID`). One code and one message for unknown, ' +
          'expired, revoked, already accepted, superseded, and issued to a different address.',
      },
    ],
  })
  @HttpCode(201)
  @Post('accept')
  async accept(
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
    @Req() request: Request,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept({
      actorUserId: principalOf(request).userId,
      token: body.token,
      ...requestContextOf(request),
    });
  }
}
