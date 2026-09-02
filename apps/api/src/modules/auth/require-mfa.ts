import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { MFA_ENROLMENT_POLICY } from './auth.tokens.js';

/**
 * D8. `Organization.requireMfa`, PLACED IN THE PIPELINE BY TASK 12 AND
 * REFUSING NOBODY.
 *
 * # What this file is, and what it is not
 *
 * `security/authentication.md` §5 requires that a member of an organisation
 * with `requireMfa` be forced into enrolment "before any other action ...
 * enforced server-side on every request, not only at login". Every word of that
 * is a decision this file makes correctly.
 *
 * The check needed two things Task 11 did not have: tenant resolution (which
 * organisation is this request acting in?) and organisation membership (is this
 * user a member of it, and does it require MFA?). Both were Task 12's, and both
 * now exist — `MfaEnrolmentGuard` is registered as a global guard in
 * `app.module.ts`, ahead of `AuthorizationGuard` so that a member with no
 * factor hears this rather than `PERMISSION_DENIED`, and `MFA_ENROLMENT_POLICY`
 * is provided in `roles.module.ts` where the tenant-scoped query lives.
 *
 * **AND IT REFUSES NOBODY, WHICH IS A FACT ABOUT DATA RATHER THAN ABOUT
 * WIRING.** The guard returns early when the request names no organisation, and
 * nothing in Phase 2 writes `Session.activeOrganizationId` — Task 13 does — so
 * the policy lookup below is not reached on any request this phase can produce.
 * There is also no way to create an organisation yet, so no row can carry
 * `requireMfa = true`. `MFA_ENROLMENT_REQUIRED` therefore still has no producer
 * a caller can reach, and nothing may describe it as one until Task 13.
 *
 * # The exemption is not a convenience, it is what stops the rule bricking the
 * account
 *
 * A member forced into enrolment must still be able to REACH enrolment, sign
 * out, and read their own session document. A rule with no exemption refuses
 * the only endpoints that could satisfy it, and a control that cannot be
 * complied with is an outage wearing a control's name.
 *
 * `@AllowWithoutMfaEnrolment()` is **handler-level only**, and the type is only
 * half of that. Carry-forward ruling 61: `@RateLimitExempt()` was narrowed to
 * `MethodDecorator` while the guard still read
 * `getAllAndOverride([handler, class])`, so one `@SetMetadata` line on a
 * controller disabled every limit beneath it, with every test green. The guard
 * below reads `context.getHandler()` and nothing else, and the spec holds it
 * there with a class-level case and an inheritance case — because
 * `getAllAndOverride` walks the prototype chain, so a subclass of an annotated
 * base is the shape that catches a partial fix.
 */

export const ALLOW_WITHOUT_MFA_ENROLMENT_KEY = 'sentinel:allow-without-mfa-enrolment';

export const AllowWithoutMfaEnrolment = (): MethodDecorator =>
  SetMetadata<string, true>(ALLOW_WITHOUT_MFA_ENROLMENT_KEY, true);

/**
 * 403, and deliberately not `MFA_REQUIRED`.
 *
 * `MFA_REQUIRED` is 401 and means "you hold a pending session, finish the
 * challenge". This caller holds a **full** session and has proved everything
 * this product asked them to; what is refused is the action, which is
 * `api/conventions.md` §2's 403. Answering 401 would tell the frontend to show
 * a sign-in form, and signing in again would change nothing.
 *
 * The message says what to do, per `api/errors.md` §4: a refusal that does not
 * say how to succeed generates a support ticket.
 */
export class MfaEnrolmentRequiredError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.MFA_ENROLMENT_REQUIRED,
      'This organisation requires two-factor authentication. Set it up in your security settings to continue.',
      403,
    );
    this.name = 'MfaEnrolmentRequiredError';
  }
}

export interface RequireMfaInput {
  readonly organizationRequiresMfa: boolean;
  /**
   * `confirmedAt IS NOT NULL`, never a row count.
   *
   * Carry-forward ruling 7 and `schema.prisma`: an abandoned unconfirmed
   * enrolment is a row that exists, and counting rows would let a user satisfy
   * an organisation's MFA requirement by starting an enrolment and closing the
   * tab. The field is named for the predicate so a caller cannot pass the wrong
   * question and have it typecheck.
   */
  readonly hasConfirmedFactor: boolean;
  readonly routeIsExempt: boolean;
}

export type RequireMfaDecision = 'allow' | 'enrolment-required';

/**
 * The whole rule, as a pure function, so it can be read and tested without a
 * request, a guard, an organisation or a database.
 */
export function requireMfaDecision(input: RequireMfaInput): RequireMfaDecision {
  if (input.routeIsExempt) return 'allow';
  if (!input.organizationRequiresMfa) return 'allow';
  if (input.hasConfirmedFactor) return 'allow';
  return 'enrolment-required';
}

/**
 * "Does this organisation require MFA, and has this member confirmed a factor?"
 *
 * A port rather than a Prisma client, for the reason every other narrow port in
 * this module gives, plus one specific to this file: the query behind it needs
 * organisation membership under tenant scoping, which was Task 12's, and
 * guessing its shape here would have pinned a guess into the module that had to
 * implement it. `MFA_ENROLMENT_POLICY` is now provided in `roles.module.ts`, by
 * `mfaEnrolmentPolicy` in `tenant-resolver.store.ts`.
 */
export interface MfaEnrolmentPolicy {
  (input: { userId: string; organizationId: string }): Promise<{
    requireMfa: boolean;
    hasConfirmedFactor: boolean;
  }>;
}

@Injectable()
export class MfaEnrolmentGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MFA_ENROLMENT_POLICY) private readonly policy: MfaEnrolmentPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // `get` on the HANDLER alone. Not `getAllAndOverride`. See the file
    // docblock and carry-forward ruling 61.
    const routeIsExempt =
      this.reflector.get<true | undefined>(
        ALLOW_WITHOUT_MFA_ENROLMENT_KEY,
        context.getHandler(),
      ) === true;
    if (routeIsExempt) return true;

    const request = context.switchToHttp().getRequest<{
      principal?: { userId: string };
      activeOrganizationId?: string | null;
    }>();

    // NOT THIS GUARD'S QUESTION. `AuthenticationGuard` has already admitted or
    // refused this request; a second opinion here would put the authentication
    // rule in two places.
    const userId = request.principal?.userId;
    if (userId === undefined) return true;

    // The requirement belongs to an ORGANISATION. A session that has chosen
    // none cannot be subject to one, and asking would be a database read on
    // every such request that could not change the answer.
    const organizationId = request.activeOrganizationId ?? null;
    if (organizationId === null) return true;

    const { requireMfa, hasConfirmedFactor } = await this.policy({ userId, organizationId });
    if (
      requireMfaDecision({
        organizationRequiresMfa: requireMfa,
        hasConfirmedFactor,
        routeIsExempt: false,
      }) === 'allow'
    ) {
      return true;
    }
    // Thrown rather than `false`. `false` from a Nest guard is a bare
    // `ForbiddenException` with no code, and `api/errors.md` §4 requires a
    // refusal to say how to succeed.
    throw new MfaEnrolmentRequiredError();
  }
}
