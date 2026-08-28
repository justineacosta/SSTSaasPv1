import { SetMetadata } from '@nestjs/common';

export const REQUIRE_VERIFIED_EMAIL_KEY = 'sentinel:require-verified-email';

/**
 * Declares a route that an unverified account may not reach.
 *
 * `security/authentication.md` §6: "Unverified users may sign in but cannot
 * create organisations, invite, or scan." Signing in is the part that still
 * works, which is why this is a per-route requirement rather than something
 * `AuthenticationGuard` could decide for every route at once.
 *
 * **`MethodDecorator & ClassDecorator`, and that is the opposite of
 * `@AllowPendingMfa()` and `@RateLimitExempt()` on purpose.** Those two are
 * *exemptions*, and the danger of a class-level exemption is that one line at
 * the top of a controller silently switches a control off for everything
 * beneath it — this codebase shipped exactly that bug once
 * (`@RateLimitExempt()`), which is why both are narrowed to `MethodDecorator`.
 * This decorator is a *requirement*: a class-level annotation switches the
 * control **on** for everything beneath it, so the failure direction of a
 * misplaced one is a route that refuses more than intended, not one that
 * refuses less.
 *
 * Carry-forward ruling 61 still binds the tests rather than the type:
 * `EmailVerifiedGuard` reads `getAllAndOverride([handler, class])`, which walks
 * the prototype chain, so `email-verified.guard.spec.ts` covers the handler
 * case, the class case, **and** a controller that inherits the annotation from
 * a base class.
 *
 * **NOTHING CARRIES THIS DECORATOR TODAY.** Task 8 ships the mechanism; Task 13
 * applies it to organisation creation, and Tasks 14–15 to inviting. See
 * `EmailVerifiedGuard`'s docblock for what that means for the roadmap.
 */
export const RequireVerifiedEmail = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, true>(REQUIRE_VERIFIED_EMAIL_KEY, true);
