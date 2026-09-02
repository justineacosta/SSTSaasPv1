import { describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import { AuthorizationGuard } from './common/guards/authorization.guard.js';
import { CrossSiteGuard } from './common/guards/cross-site.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { EmailVerifiedGuard } from './common/guards/email-verified.guard.js';
import { EntitlementGuard } from './common/guards/entitlement.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { TenantContextGuard } from './common/guards/tenant-context.js';
import { MfaEnrolmentGuard } from './modules/auth/require-mfa.js';

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

/**
 * The index of a guard in the pipeline, refusing `-1`.
 *
 * The Task 12 review's L-2: two of the four "decision" assertions below were
 * written as `indexOf(A) < indexOf(B)`, which is **vacuously true when A is
 * absent** — `indexOf` returns `-1`, and `-1` is less than everything. The
 * reviewer deleted `MfaEnrolmentGuard`'s provider entirely and watched
 * `forces MFA enrolment before it evaluates a permission` pass. Only the
 * full-array assertions held the line.
 */
function positionOf(guard: unknown): number {
  const index = globalGuardClasses().indexOf(guard);
  if (index === -1) {
    throw new Error(
      `${String((guard as { name?: string }).name ?? guard)} is not registered as a global guard. ` +
        'An ordering assertion about a guard that is absent is vacuously true, which is how a ' +
        'stage disappears with the order still "asserted".',
    );
  }
  return index;
}

function globalGuardClasses(): unknown[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as GuardProvider[];
  return providers
    .filter((provider) => provider.provide === APP_GUARD)
    .map((provider) => provider.useClass);
}

describe('the global guard pipeline', () => {
  it('runs the nine stages of backend.md §3 in the documented order', () => {
    expect(globalGuardClasses()).toEqual([
      RateLimitGuard,
      AuthenticationGuard,
      TenantContextGuard,
      CsrfGuard,
      CrossSiteGuard,
      EmailVerifiedGuard,
      MfaEnrolmentGuard,
      AuthorizationGuard,
      EntitlementGuard,
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
    expect(positionOf(CsrfGuard)).toBeGreaterThan(positionOf(AuthenticationGuard));
  });

  it('resolves the tenant after authentication and before authorization', () => {
    // `security/authorization.md` §2 evaluates its layers in order and
    // `architecture/overview.md` §4 requires tenant resolution to precede
    // authorization, so that a permission is always evaluated against a
    // specific organisation. Both directions are asserted: a tenant resolved
    // before there is a principal would key its query on `undefined`, and a
    // permission evaluated before the tenant would be evaluated against no
    // organisation at all — which `security/authorization.md` §1 calls
    // meaningless in a multi-tenant product.
    expect(positionOf(TenantContextGuard)).toBeGreaterThan(positionOf(AuthenticationGuard));
    expect(positionOf(TenantContextGuard)).toBeLessThan(positionOf(AuthorizationGuard));
  });

  it('forces MFA enrolment before it evaluates a permission', () => {
    // `security/authentication.md` §5: a member of an organisation that
    // requires MFA is forced into enrolment "before any other action". A caller
    // with no factor must hear MFA_ENROLMENT_REQUIRED rather than
    // PERMISSION_DENIED, which would send them to ask an owner for a permission
    // that would not have helped.
    expect(positionOf(MfaEnrolmentGuard)).toBeLessThan(positionOf(AuthorizationGuard));
  });

  it('puts both database-reading gates after the two forgery checks', () => {
    // A cross-site forged request should be refused by a header comparison
    // rather than pay for two database reads on the way to the same refusal.
    for (const gate of [EmailVerifiedGuard, MfaEnrolmentGuard]) {
      expect(positionOf(gate)).toBeGreaterThan(positionOf(CsrfGuard));
      expect(positionOf(gate)).toBeGreaterThan(positionOf(CrossSiteGuard));
    }
  });

  it('puts the cross-site refusal after the two controls it does not replace', () => {
    // It is the narrowest of the forgery checks: it governs only handlers
    // carrying `@RefuseCrossSite()`, and every such handler is `@Public()` —
    // exactly the set `CsrfGuard` skips (carry-forward ruling 56). A caller
    // whose credential or CSRF token is wrong should hear about that first.
    //
    // It is **no longer last in the array**, and that is not a demotion: Task 12
    // added four stages behind it, every one of which needs a principal and a
    // resolved tenant that a `@Public()` route does not have. The property that
    // mattered is unchanged and is what is asserted — it runs after
    // authentication and CSRF.
    expect(positionOf(CrossSiteGuard)).toBeGreaterThan(positionOf(CsrfGuard));
    expect(positionOf(CrossSiteGuard)).toBeGreaterThan(positionOf(AuthenticationGuard));
  });

  it('puts the entitlement stub LAST, so 402 can never precede 403', () => {
    // `entitlement.guard.ts`: the stub allows everything, so its position is
    // the only decision it currently records — and it is a real one. A caller
    // who was never permitted the action must not learn what the
    // organisation's plan includes.
    expect(globalGuardClasses().at(-1)).toBe(EntitlementGuard);
    expect(positionOf(EntitlementGuard)).toBeGreaterThan(positionOf(AuthorizationGuard));
  });

  it('registers exactly nine global guards', () => {
    // A tenth arriving unnoticed is a stage nobody chose the position of.
    // Phase 10's real entitlement check replaces the stub rather than adding to
    // this number; Phase 3's audit stage is service-level and is not a guard.
    expect(globalGuardClasses()).toHaveLength(9);
  });
});
