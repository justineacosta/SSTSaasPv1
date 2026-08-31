import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import type { Request } from 'express';
import { PRISMA } from '../../infrastructure/tokens.js';
import { REQUIRE_VERIFIED_EMAIL_KEY } from '../decorators/email-verified.decorator.js';
import { DomainError } from '../errors/domain-error.js';

/**
 * The narrow slice of Prisma this guard uses: one column of one row.
 *
 * The same narrow-port shape `TokenService` and `AuthenticationGuard` use. A
 * guard typed against the whole client is a guard whose every spec is either a
 * mock of the world or an integration test.
 */
export interface VerifiedEmailLookup {
  user: {
    findUnique(args: { where: { id: string } }): Promise<{ emailVerifiedAt: Date | null } | null>;
  };
}

/**
 * REFUSES A GATED ROUTE TO AN ACCOUNT THAT HAS NOT PROVEN ITS EMAIL ADDRESS.
 *
 * `security/authentication.md` §6's table: "Unverified users may sign in but
 * cannot create organisations, invite, or scan." `api/authentication.md` §6 and
 * `api/errors.md` §3 both already give the refusal its code and status — 403
 * `EMAIL_NOT_VERIFIED` — so nothing new is added to either error list here
 * (carry-forward ruling 27's two-list problem does not land on this task).
 *
 * # THIS GUARD GOVERNS ZERO ROUTES TODAY, AND SAYING SO IS THE POINT
 *
 * Task 8's three routes are all `@Public()` and all reachable by someone with
 * no account at all, so there is no route in existence for this to guard:
 * `GET /auth/session` is Task 9's and organisation creation is Task 13's. It is
 * therefore **registered in no module** and no handler carries
 * `@RequireVerifiedEmail()`. It is proved against purpose-built controllers
 * through `testing/routing-app.ts`, which is the harness Task 7 used for exactly
 * this, and Task 13 both registers it and applies the decorator.
 *
 * This is the precedent Task 7 set with `@AllowPendingMfa()` and Phase 1 set
 * with the rate limiter: a control built correctly ahead of the endpoints it
 * will govern, described as such, and **never described as in force**. Nothing
 * may record `EMAIL_NOT_VERIFIED` as enforced until a real route carries the
 * decorator.
 *
 * # It reads the database rather than the principal
 *
 * `UserPrincipal` is `{ kind, userId, sessionId }` and deliberately carries no
 * account state (`packages/contracts/src/principal.ts`; carry-forward ruling
 * 16). Verification is a fact that changes *during* a session's life — that is
 * the entire point of the resend endpoint — so a value copied onto the
 * principal at sign-in would let a user who verified two minutes ago keep
 * getting 403 until their cookie rotated. One indexed primary-key read on the
 * routes that carry the decorator is the honest cost of that.
 *
 * # It asks about verification and about nothing else
 *
 * The lookup selected `status` and never read it (L7, Task 8 review). Dropped
 * rather than checked, and the choice is worth writing down because the other
 * reading is defensible: a `LOCKED` or `DISABLED` account arguably should not
 * pass a gated route either. But that refusal is not this control's. An account
 * whose status is not `ACTIVE` must fail at *authentication*, on every route,
 * including the ones that carry no decorator — making a gate named
 * `@RequireVerifiedEmail()` the place that also enforces account status would
 * mean the enforcement disappeared the moment a route did not need verification.
 * `EmailVerificationService` checks `status` because it acts on a token rather
 * than on a session (carry-forward ruling 37); a session-bearing route has
 * `AuthenticationGuard` in front of it, and Task 9's lockout work is where that
 * check belongs. A selected column nobody reads is worse than an absent one: the
 * next reader assumes it is load-bearing.
 *
 * # It refuses an unauthenticated caller rather than admitting one
 *
 * A gated route with no principal on the request means `AuthenticationGuard`
 * did not run or did not set one, which on a correctly declared route cannot
 * happen — `access-assertion.ts` refuses to boot a route that declares no
 * access requirement, and a `@Public()` route carrying `@RequireVerifiedEmail()`
 * is a contradiction. Reaching that state means the pipeline is not what this
 * guard believes, and the safe answer to "I cannot tell who this is" on a route
 * that requires a verified account is refusal.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: VerifiedEmailLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    // `getAllAndOverride`, so a class-level annotation covers every handler
    // beneath it and a handler-level one wins over the class. Ruling 61: this
    // walks the prototype chain, so an inherited class-level annotation applies
    // too — asserted in the spec rather than left to be discovered.
    const required = this.reflector.getAllAndOverride<true | undefined>(
      REQUIRE_VERIFIED_EMAIL_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required !== true) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal;
    if (principal === undefined) throw refusal();

    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    // A principal whose user row is gone is not a verified user. Failing closed
    // here rather than throwing an internal error keeps the refusal one the
    // client can act on.
    if (user === null) throw refusal();
    if (user.emailVerifiedAt === null) throw refusal();

    return true;
  }
}

/**
 * One message for every arm, because every arm means the same thing to the
 * caller: confirm your address and try again. `api/errors.md` §4 asks a refusal
 * to say how to succeed, and this one can.
 */
function refusal(): DomainError {
  return new DomainError(
    ERROR_CODES.EMAIL_NOT_VERIFIED,
    'Confirm your email address before using this feature. ' +
      'Request a new confirmation link if the last one has expired.',
    403,
  );
}
