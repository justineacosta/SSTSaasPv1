import { describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import { CrossSiteGuard } from './common/guards/cross-site.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';

/**
 * THE GUARD HALF OF `architecture/backend.md` §3'S PIPELINE.
 *
 * Nest runs global guards in the order their `APP_GUARD` providers are declared,
 * and **nothing else makes that order visible**: a reordering is a one-line diff
 * to an array, it changes no type, and every guard still runs. `app-setup.spec.ts`
 * asserts the middleware half the same way and for the same reason.
 *
 * Ruling A: "whatever ordering you end up with must be asserted by a test."
 */
interface GuardProvider {
  readonly provide?: unknown;
  readonly useClass?: unknown;
}

function globalGuardClasses(): unknown[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as GuardProvider[];
  return providers
    .filter((provider) => provider.provide === APP_GUARD)
    .map((provider) => provider.useClass);
}

describe('the global guard pipeline', () => {
  it('runs rate limiting, then authentication, then CSRF, then the cross-site refusal', () => {
    expect(globalGuardClasses()).toEqual([
      RateLimitGuard,
      AuthenticationGuard,
      CsrfGuard,
      CrossSiteGuard,
    ]);
  });

  it('puts the rate limiter FIRST, ahead of anything that touches a backing service', () => {
    // Ruling A, and backend.md §3's own table. An unauthenticated flood carrying
    // a garbage cookie would otherwise buy a Redis read and a Postgres read each
    // before anything refused it — the limiter exists to be the cheapest refusal
    // in the pipeline, and a limiter that runs after two lookups is not.
    expect(globalGuardClasses()[0]).toBe(RateLimitGuard);
  });

  it('puts CSRF after authentication, so an anonymous caller gets 401 and not 403', () => {
    const classes = globalGuardClasses();
    expect(classes.indexOf(CsrfGuard)).toBeGreaterThan(classes.indexOf(AuthenticationGuard));
  });

  it('puts the cross-site refusal LAST, after the two controls it does not replace', () => {
    // It is the narrowest of the four: it governs only handlers carrying
    // `@RefuseCrossSite()`, and every such handler is `@Public()` — which is
    // exactly the set `CsrfGuard` skips (carry-forward ruling 56). Position is
    // therefore almost free, and last is the honest place for it: a caller whose
    // credential or CSRF token is wrong should hear about that first, and a
    // route that opts in has already passed everything else.
    const classes = globalGuardClasses();
    expect(classes.at(-1)).toBe(CrossSiteGuard);
    expect(classes.indexOf(CrossSiteGuard)).toBeGreaterThan(classes.indexOf(CsrfGuard));
  });

  it('registers exactly four global guards', () => {
    // A fifth arriving unnoticed is a stage nobody chose the position of. Tenant
    // resolution and authorization are Task 12's and will move this number.
    expect(globalGuardClasses()).toHaveLength(4);
  });
});
