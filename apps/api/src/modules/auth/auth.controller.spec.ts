import { describe, expect, it } from 'vitest';
import { Post, RequestMethod } from '@nestjs/common';
import {
  ACCESS_METADATA_KEY,
  type AccessDeclaration,
} from '../../common/decorators/access.decorator.js';
import { REFUSE_CROSS_SITE_KEY } from '../../common/decorators/cross-site.decorator.js';
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_METADATA_KEY,
} from '../../common/decorators/rate-limit.decorator.js';
import { REQUIRE_VERIFIED_EMAIL_KEY } from '../../common/decorators/email-verified.decorator.js';
import type { RateLimitClass } from '../../common/guards/rate-limit.config.js';
import { AuthController } from './auth.controller.js';

/**
 * THE DECORATORS ON THE NINE SHIPPED HANDLERS, READ OFF THE REAL CONTROLLER.
 *
 * M1. Three mutations survived the entire eleven-command gate before this file
 * existed: downgrading all three routes to `generalSession`, deleting the three
 * `@RateLimit()` decorators outright, and deleting only the one on
 * `verify-email`. `rate-limit.config.spec.ts` asserts the config **table**
 * value by value, and `rate-limit.integration.spec.ts` exercises a **fixture
 * controller** — carry-forward ruling 58's shape twice over. Nothing read
 * `AuthController`.
 *
 * That is not an unprotected endpoint: the reviewer measured `registration`'s
 * 3/hour per IP live through the real application (`200,200,200,429,429`). It
 * is a hole in assurance, and ruling D says exactly what a silent regression
 * would cost — a route that falls to `generalSession` is fail-open with one
 * unresolvable scope and produces no log line at the default level, so nothing
 * anywhere would say the limit had stopped applying.
 *
 * Metadata is read off `AuthController.prototype`'s handler functions, which is
 * where `SetMetadata` as a `MethodDecorator` puts it — the same place
 * `Reflector.get(key, context.getHandler())` reads it from at runtime.
 *
 * **Task 9's three handlers arrived through the exhaustiveness test at the
 * bottom of this file**, which went red naming them before a single row had
 * been added here. That is exactly what ruling 64 built it for, and Task 10's
 * three arrived the other way round — the rows were written first and every
 * assertion for them was red until the handlers existed.
 */

type HandlerName =
  | 'register'
  | 'verifyEmail'
  | 'resendVerification'
  | 'login'
  | 'logout'
  | 'session'
  | 'forgotPassword'
  | 'resetPassword'
  | 'changePassword';

/**
 * A handler read off the prototype as a REFLECTION TARGET, never to be called.
 *
 * `@typescript-eslint/unbound-method` is right in general and wrong here: its
 * hazard is losing `this` by detaching a method and invoking it, and nothing in
 * this file invokes anything. `Reflect.getMetadata` needs the exact function
 * object Nest's `SetMetadata` decorated, which is the one on the prototype.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- read as a metadata target, never invoked.
const handlerOf = (name: HandlerName): object => AuthController.prototype[name];

interface RouteExpectation {
  readonly handler: HandlerName;
  readonly path: string;
  readonly method: RequestMethod;
  readonly rateLimit: RateLimitClass;
  readonly access: AccessDeclaration;
  /** Whether the handler carries `@RefuseCrossSite()`. */
  readonly refusesCrossSite: boolean;
}

/**
 * The nine routes, as an exact table. A tenth handler appearing on this
 * controller without a row here fails the exhaustiveness test below rather than
 * shipping undeclared — which is how Task 9's three arrived.
 *
 * `access` is in the table rather than asserted uniformly because Task 9 is
 * where this controller stopped being all-public. A route on the wrong arm of
 * that union is either an endpoint nobody can reach or an endpoint anybody can.
 */
const ROUTES: readonly RouteExpectation[] = [
  {
    handler: 'register',
    path: 'register',
    method: RequestMethod.POST,
    rateLimit: 'registration',
    access: { kind: 'public' },
    refusesCrossSite: false,
  },
  {
    handler: 'verifyEmail',
    path: 'verify-email',
    method: RequestMethod.POST,
    rateLimit: 'emailVerificationConsume',
    access: { kind: 'public' },
    refusesCrossSite: false,
  },
  {
    handler: 'resendVerification',
    path: 'resend-verification',
    method: RequestMethod.POST,
    rateLimit: 'emailVerificationResend',
    access: { kind: 'public' },
    refusesCrossSite: false,
  },
  {
    // The per-account window keys on the body's `email` — the first time a
    // `{ bodyField }` principal source has ever resolved on a shipped route.
    // `generalSession` here would be fail-open with no resolvable scope, and
    // carry-forward ruling 55 records that nothing would say so.
    handler: 'login',
    path: 'login',
    method: RequestMethod.POST,
    rateLimit: 'login',
    access: { kind: 'public' },
    // The one route in the product that carries it. Carry-forward ruling 56:
    // `CsrfGuard` skips public routes, so login CSRF needs its own mechanism.
    refusesCrossSite: true,
  },
  {
    handler: 'logout',
    path: 'logout',
    method: RequestMethod.POST,
    // Resolves nothing today — the limiter runs before the authentication
    // guard — and is declared anyway, because a route with no decorator falls
    // to the same class SILENTLY. See the handler's docblock.
    rateLimit: 'generalSession',
    access: { kind: 'authenticated' },
    // Not needed and not carried: this route IS cookie-authenticated, so
    // `CsrfGuard` governs it — the first route in the product it ever has.
    refusesCrossSite: false,
  },
  {
    handler: 'session',
    path: 'session',
    method: RequestMethod.GET,
    rateLimit: 'generalSession',
    access: { kind: 'authenticated' },
    refusesCrossSite: false,
  },
  {
    // D7. The existing `passwordReset` class — 3/hour per address keyed on the
    // body's `email`, 10/hour per IP, fail closed. The second shipped route on
    // which a `{ bodyField }` principal source resolves, after login.
    handler: 'forgotPassword',
    path: 'forgot-password',
    method: RequestMethod.POST,
    rateLimit: 'passwordReset',
    access: { kind: 'public' },
    // D6. Public and state-changing, so `CsrfGuard` skips it (ruling 56) and
    // `@RefuseCrossSite()` is what covers it — the mechanism Task 9 built for
    // exactly this shape of route.
    refusesCrossSite: true,
  },
  {
    // D7. A class added by this task, not a row transcribed from §1: the body
    // is `{ token, password }` and carries no account, so it is per-IP only,
    // exactly as `emailVerificationConsume` is and for the same written reason.
    handler: 'resetPassword',
    path: 'reset-password',
    method: RequestMethod.POST,
    rateLimit: 'passwordResetConsume',
    access: { kind: 'public' },
    refusesCrossSite: true,
  },
  {
    // D7. Also a new class, and this one is a security control rather than
    // bookkeeping — the endpoint verifies a password, so it is a
    // credential-guessing oracle for anyone holding a stolen session.
    handler: 'changePassword',
    path: 'change-password',
    method: RequestMethod.POST,
    rateLimit: 'passwordChange',
    access: { kind: 'authenticated' },
    // D6. NOT carried, and that is the decision rather than an omission: this
    // route is cookie-authenticated, so `CsrfGuard` governs it — the same
    // reasoning `logout` carries. `auth.password.integration.spec.ts` asserts
    // that on the shipped route rather than on a fixture.
    refusesCrossSite: false,
  },
];

/**
 * Nest's own route metadata keys, hard-coded — and then proved against a probe.
 *
 * `@nestjs/common/constants` exports `PATH_METADATA` and `METHOD_METADATA`, but
 * the package ships no `exports` map, so under `nodenext` the subpath does not
 * type-resolve (TS2307). Hard-coding the two strings is the alternative, and a
 * hard-coded metadata key has one dangerous failure mode: if Nest ever renames
 * it, `Reflect.getMetadata` returns `undefined` and every assertion below
 * becomes an assertion about nothing while still printing green. That is this
 * codebase's most-repeated defect (rulings 13, 49, 58).
 *
 * So the keys are checked against a throwaway controller decorated with the
 * same `@Post()` this file is asserting about. If the probe stops seeing its own
 * path, this file fails here rather than going quietly vacuous.
 */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

class ProbeController {
  // `this: void` so the same unbound-method rule has nothing to complain about:
  // this method exists to be decorated and read, never to be called.
  @Post('probe')
  probe(this: void): void {}
}

describe('the metadata keys this file reads', () => {
  it('are the keys Nest actually writes', () => {
    const probe = ProbeController.prototype.probe;
    expect(Reflect.getMetadata(PATH_METADATA, probe)).toBe('probe');
    expect(Reflect.getMetadata(METHOD_METADATA, probe)).toBe(RequestMethod.POST);
  });
});

describe.each(ROUTES)('$path', ({ handler, path, method, rateLimit, access, refusesCrossSite }) => {
  it('is registered on the expected path with the expected method', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handlerOf(handler))).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(handler))).toBe(method);
  });

  it('carries exactly the rate-limit class abuse-prevention.md §1 gives it', () => {
    // The assertion the three surviving mutations needed. `rate-limit.config.ts`
    // holding the right numbers is worth nothing if the route names a different
    // class, or none.
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, handlerOf(handler))).toBe(rateLimit);
  });

  it('declares its access arm in metadata rather than by omission', () => {
    // The boot-time access assertion refuses a route that declares nothing, so
    // "no metadata" would fail at startup — but it would fail as a crash, not
    // as a statement about which arm this route is on. `@AuthenticatedOnly()`
    // on `register` would be a route nobody could reach without an account, on
    // an endpoint whose whole purpose is to serve people who have none; and
    // `@Public()` on `logout` or `session` would be an endpoint anybody can
    // reach, which is the same mistake pointing the other way.
    const declared = Reflect.getMetadata(
      ACCESS_METADATA_KEY,
      handlerOf(handler),
    ) as AccessDeclaration;
    expect(declared).toEqual(access);
  });

  it('carries the cross-site refusal only if it is meant to', () => {
    // Both directions matter. On `login` its absence would leave login CSRF
    // uncovered, because `CsrfGuard` skips public routes by design (ruling 56)
    // and would say nothing about it. On the other five its presence would be a
    // control nobody chose: on the three Task 8 routes it changes behaviour
    // that was reasoned about and accepted, and on `logout` and `session` it is
    // redundant with a stronger control that already governs them.
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, handlerOf(handler))).toBe(
      refusesCrossSite ? true : undefined,
    );
  });

  it('is not exempt from rate limiting and carries no email-verified gate', () => {
    // `@RateLimitExempt()` is for the liveness probe and nothing else; on an
    // unauthenticated write endpoint it would remove the only bound there is.
    // `@RequireVerifiedEmail()` on a public route is a contradiction — the
    // guard needs a principal, and these routes are reachable with no account.
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handlerOf(handler))).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_VERIFIED_EMAIL_KEY, handlerOf(handler))).toBeUndefined();
  });
});

describe('the controller as a whole', () => {
  it('declares no class-level rate limit, exemption or access override', () => {
    // A class-level `@RateLimit()` would silently govern a handler that forgot
    // its own, which is the failure mode `rate-limit.decorator.ts` records for
    // `@RateLimitExempt()` — one line at the top of a controller disabling every
    // limit beneath it.
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, AuthController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, AuthController)).toBeUndefined();
    expect(Reflect.getMetadata(ACCESS_METADATA_KEY, AuthController)).toBeUndefined();
  });

  it('declares no class-level cross-site refusal', () => {
    // `CrossSiteGuard` reads `getHandler()` only, so a class-level annotation
    // opts nothing in — but it would read as though it did, which is the
    // failure `cross-site.guard.spec.ts` proves the guard against.
    expect(Reflect.getMetadata(REFUSE_CROSS_SITE_KEY, AuthController)).toBeUndefined();
  });

  it('exposes exactly the nine handlers in the table above', () => {
    const handlers = Object.getOwnPropertyNames(AuthController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers.sort()).toEqual([...ROUTES].map((route) => route.handler).sort());
  });
});
