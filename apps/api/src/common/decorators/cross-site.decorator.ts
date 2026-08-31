import { SetMetadata } from '@nestjs/common';

/**
 * The metadata key a route sets to opt in to `CrossSiteGuard`.
 *
 * Its own key rather than a fourth arm of `AccessDeclaration`, for the reason
 * `access.decorator.ts` gives about `@AllowPendingMfa()`: this is orthogonal to
 * *how a route is reached*. Every route that carries it is `@Public()` — that
 * is the whole point, since a route with a session cookie is already
 * `CsrfGuard`'s — and folding the two together would make "public, and also
 * cross-site-refusing" a kind that every reader of `AccessDeclaration` has to
 * hold in mind, and would let a route acquire or lose the control by choosing a
 * different arm of a union it was thinking about for a different reason.
 */
export const REFUSE_CROSS_SITE_KEY = 'sentinel:refuse-cross-site';

/**
 * Declares that a route refuses a request a browser reports as cross-site.
 *
 * `security/authentication.md` §4's Origin/`Sec-Fetch-Site` signal, promoted to
 * the control on the narrow set of routes where the double-submit token cannot
 * be one. Carry-forward ruling 56: `CsrfGuard` skips `@Public()` routes, and
 * must — the expected token derives from the `HttpOnly` session cookie, so a
 * public route demanding it refuses every caller with no client-side remedy.
 * Login, password reset and MFA verification are all public and all unsafe, and
 * this is what covers them.
 *
 * **Opt-in, and per handler.** Two reasons, and the second is the sharper one:
 *
 * - Not every public unsafe route wants it. `register`, `verify-email` and
 *   `resend-verification` are deliberately reachable cross-site — see
 *   `auth.controller.ts` for what that buys an attacker on each — and a global
 *   default would have changed their behaviour as a side effect of adding a
 *   control for login.
 * - **`MethodDecorator`, and the guard reads `context.getHandler()` only.**
 *   `access.decorator.ts`'s `AllowPendingMfa` docblock records what class-level
 *   metadata did to the last exemption in this codebase, and carry-forward
 *   ruling 61 records that narrowing the type is only half of that control: the
 *   guard's *read* is the other half, and it is tested with a raw
 *   `@SetMetadata` on a controller, which is a thing a person can write.
 *   Here the direction is reversed — a class-level annotation would silently
 *   *extend* the guard rather than exempt from it — and the failure is the same
 *   shape either way: coverage that depends on where Nest happens to look
 *   rather than on what the route says.
 */
export const RefuseCrossSite = (): MethodDecorator =>
  SetMetadata<string, true>(REFUSE_CROSS_SITE_KEY, true);
