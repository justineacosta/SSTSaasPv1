import { describe, expect, it } from 'vitest';
import { Post, RequestMethod } from '@nestjs/common';
import {
  ACCESS_METADATA_KEY,
  type AccessDeclaration,
} from '../../common/decorators/access.decorator.js';
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_METADATA_KEY,
} from '../../common/decorators/rate-limit.decorator.js';
import { REQUIRE_VERIFIED_EMAIL_KEY } from '../../common/decorators/email-verified.decorator.js';
import type { RateLimitClass } from '../../common/guards/rate-limit.config.js';
import { AuthController } from './auth.controller.js';

/**
 * THE DECORATORS ON THE THREE SHIPPED HANDLERS, READ OFF THE REAL CONTROLLER.
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
 */

type HandlerName = 'register' | 'verifyEmail' | 'resendVerification';

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
  readonly rateLimit: RateLimitClass;
}

/**
 * The three routes, as an exact table. A fourth handler appearing on this
 * controller without a row here fails the exhaustiveness test below rather than
 * shipping undeclared — Task 9's login endpoint belongs on this controller.
 */
const ROUTES: readonly RouteExpectation[] = [
  { handler: 'register', path: 'register', rateLimit: 'registration' },
  { handler: 'verifyEmail', path: 'verify-email', rateLimit: 'emailVerificationConsume' },
  {
    handler: 'resendVerification',
    path: 'resend-verification',
    rateLimit: 'emailVerificationResend',
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

const POST = RequestMethod.POST;

describe.each(ROUTES)('$path', ({ handler, path, rateLimit }) => {
  it('is registered as a POST on the expected path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handlerOf(handler))).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(handler))).toBe(POST);
  });

  it('carries exactly the rate-limit class abuse-prevention.md §1 gives it', () => {
    // The assertion the three surviving mutations needed. `rate-limit.config.ts`
    // holding the right numbers is worth nothing if the route names a different
    // class, or none.
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA_KEY, handlerOf(handler))).toBe(rateLimit);
  });

  it('is @Public(), and says so in metadata rather than by omission', () => {
    // The boot-time access assertion refuses a route that declares nothing, so
    // "no metadata" would fail at startup — but it would fail as a crash, not
    // as a statement about which arm this route is on. `@AuthenticatedOnly()`
    // here would be a route nobody could reach without an account, on three
    // endpoints whose whole purpose is to serve people who have none.
    const access = Reflect.getMetadata(
      ACCESS_METADATA_KEY,
      handlerOf(handler),
    ) as AccessDeclaration;
    expect(access).toEqual({ kind: 'public' });
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

  it('exposes exactly the three handlers in the table above', () => {
    const handlers = Object.getOwnPropertyNames(AuthController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers.sort()).toEqual([...ROUTES].map((route) => route.handler).sort());
  });
});
