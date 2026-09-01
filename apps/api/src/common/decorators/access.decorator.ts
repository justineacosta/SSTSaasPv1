import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@sentinel/contracts';

/**
 * The single metadata key under which every route declares how it is reached.
 *
 * One key, not two, and one shape, not a boolean plus a string: a route either
 * declares itself public or names the permission it requires, and "neither" is
 * a third state that a boot-time assertion refuses to start on. Two independent
 * keys would make "public AND permission-guarded" and "no declaration at all"
 * indistinguishable from each other at the point where it matters — see
 * architecture/backend.md §3, "a route without an explicit access declaration
 * fails a startup assertion".
 */
export const ACCESS_METADATA_KEY = 'sentinel:access';

export type AccessDeclaration =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: Permission };

/**
 * Declares a route reachable without authentication.
 *
 * Deliberately explicit rather than a default: the boot assertion that Task 11
 * adds treats an undeclared route as a defect, so forgetting the decorator
 * crashes startup instead of quietly shipping an open endpoint.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_METADATA_KEY, { kind: 'public' });

/**
 * Declares a route that requires a signed-in user and nothing more.
 *
 * `security/authorization.md` §5 has named this alongside `@Public()` since
 * Phase 1 — "unless it is explicitly marked `@Public()` or
 * `@AuthenticatedOnly()`" — and Phase 1 did not build it. This is the task that
 * makes that sentence true.
 *
 * It is a **third arm, not a relaxation.** The boot assertion still refuses a
 * route that declares nothing; what changes is that there are now three ways to
 * declare rather than two. `access-assertion.spec.ts` keeps the undeclared-route
 * crash alongside the new arm precisely so the check cannot start passing
 * vacuously because it learned a new word.
 *
 * The routes it is for are the ones where "which organisation" has no answer
 * yet: reading your own session, completing MFA, listing the organisations you
 * belong to, switching between them. Every one of those is about the user and
 * about no tenant, which is `security/authentication.md` §1's separation
 * expressed at the route.
 */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_METADATA_KEY, { kind: 'authenticated' });

/**
 * Declares the permission a caller must hold. The permission string is typed
 * against `PERMISSIONS` in `@sentinel/contracts`, so a typo is a compile error
 * rather than a guard that silently never matches.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_METADATA_KEY, { kind: 'permission', permission });

/**
 * The one route a `PENDING_MFA` session may reach.
 *
 * `security/authentication.md` §5: MFA is checked "against a short-lived,
 * unprivileged pending session that can do nothing but complete MFA". The
 * enforcement is `AuthenticationGuard`'s — every authenticated route refuses a
 * pending session with 401 `MFA_REQUIRED` unless the handler carries this — and
 * this decorator is the exception's only expression.
 *
 * **Separate from `AccessDeclaration`, deliberately.** The MFA verification
 * endpoint is `@AuthenticatedOnly()` *and* this; folding them into one arm
 * would make "authenticated, and pending is fine" a fourth kind that every
 * reader of `AccessDeclaration` has to hold in mind, and would let a route
 * carry the exception by choosing the wrong arm of a union it was thinking
 * about for a different reason.
 *
 * **Handler-level only, and the type is what enforces it.** This is an
 * *exemption*, and `rate-limit.guard.ts` records what happened to the last one
 * in this codebase: `@RateLimitExempt()` was narrowed to `MethodDecorator`, but
 * the guard still honoured class-level metadata, so a single
 * `@SetMetadata(RATE_LIMIT_EXEMPT_KEY, true)` on a controller disabled every
 * limit beneath it. The guard here reads `context.getHandler()` and nothing
 * else, so a class-level annotation — however it is written — exempts nothing.
 *
 * **Task 11 built the endpoint that carries it, and it is `POST /auth/mfa/verify`
 * — where it currently enforces nothing.** That route is `@Public()`, because
 * no session cookie authenticates it (the pending token travels in the body,
 * ADR-0018), and `AuthenticationGuard` exits at the `@Public()` check before it
 * ever reads this key. The decorator is on the handler as documentation the
 * typechecker keeps honest, and so that the day the pending token moves into a
 * cookie the exemption is already in the right place rather than being
 * remembered. The mechanism itself is still proved against test controllers in
 * `authentication.guard.spec.ts`, which remains the only honest way to prove a
 * rule about routes that no shipped route exercises.
 */
export const ALLOW_PENDING_MFA_KEY = 'sentinel:allow-pending-mfa';

export const AllowPendingMfa = (): MethodDecorator =>
  SetMetadata<string, true>(ALLOW_PENDING_MFA_KEY, true);
