import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import {
  ACCESS_METADATA_KEY,
  type AccessDeclaration,
} from '../../common/decorators/access.decorator.js';
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
 * WIRING.** Nothing in Phase 2 writes `Session.activeOrganizationId` — Task 13
 * does — and there is no way to create an organisation yet, so no row can carry
 * `requireMfa = true`. `MFA_ENROLMENT_REQUIRED` therefore still has no producer
 * a caller can reach, and nothing may describe it as one until Task 13.
 *
 * # THE RULE APPLIES TO ROUTES THAT DECLARE A PERMISSION, AND TO NOTHING ELSE
 *
 * This is the Task 12 review's H-1, and the shape of the fix is the point.
 *
 * The first version registered this guard globally as an **opt-out** control:
 * it ran on every authenticated route, and the only escape was
 * `@AllowWithoutMfaEnrolment()`, which **no shipped handler carried**. A single
 * `requireMfa = true` row would then have refused the member's own enrolment
 * endpoint, their session document and their logout — total account lockout,
 * caught by no test, and predicted word for word by the paragraph that used to
 * sit here saying the exemption "is what stops the rule bricking the account".
 * A control whose safety depends on somebody remembering to decorate six
 * handlers is the failure mode this branch's ledger is a list of.
 *
 * So the safety is structural instead. `security/authorization.md` §1 makes
 * authorization the triple (user, organisation, permission), so **a route that
 * acts within an organisation is exactly a route that declares a permission**.
 * That is the set §5's "before any other action" means, and it is the set this
 * guard now governs — the same asymmetry `TenantContextGuard` uses, for the
 * same reason (carry-forward ruling 95). A member with no factor keeps the
 * routes that are about *them* rather than about a tenant: enrolment, the
 * session document, logout, and organisation switching when Task 13 ships it.
 * They can do nothing in the organisation itself, which is the whole of what
 * the control is for.
 *
 * **It reads `request.tenant`, not `request.activeOrganizationId`** — H-1's
 * second half. The raw session column says which organisation the cookie points
 * at; it says nothing about whether the caller is a member of it. Reading it
 * applied an organisation's MFA policy to somebody whose membership had not
 * resolved, which is the account-bricking case one guard further on.
 *
 * `@AllowWithoutMfaEnrolment()` survives for the case this cannot cover: a
 * *permission-guarded* route that must stay reachable without a factor. There
 * is none today, and `require-mfa.spec.ts` asserts that rather than asserting
 * nothing.
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
    if (context.getType() !== 'http') return true;

    // ONLY A ROUTE THAT DECLARES A PERMISSION. See the file docblock: this is
    // what makes the account-bricking case unreachable by construction rather
    // than by remembering to decorate every route a locked-out member needs.
    const access = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (access?.kind !== 'permission') return true;

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
      tenant?: { organizationId: string };
    }>();

    // NOT THIS GUARD'S QUESTION. `AuthenticationGuard` has already admitted or
    // refused this request; a second opinion here would put the authentication
    // rule in two places.
    const userId = request.principal?.userId;
    if (userId === undefined) return true;

    // `request.tenant`, not `request.activeOrganizationId` — H-1's second half.
    // A resolved tenant means an ACTIVE membership in an ACTIVE organisation;
    // the raw column means only that the cookie points somewhere. On a route
    // declaring a permission an unresolved tenant has already been refused with
    // 404 by `TenantContextGuard`, so `undefined` here means the pipeline is
    // not the one this file believes — and the safe answer is to decide
    // nothing and leave the refusal to the layer that owns it.
    const organizationId = request.tenant?.organizationId ?? null;
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
