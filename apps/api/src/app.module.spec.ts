import { describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import { AuthorizationGuard } from './common/guards/authorization.guard.js';
import { CrossSiteGuard } from './common/guards/cross-site.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { EmailVerifiedGuard } from './common/guards/email-verified.guard.js';
import { EntitlementGuard } from './common/guards/entitlement.guard.js';
import { RateLimitGuard, TenantRateLimitGuard } from './common/guards/rate-limit.guard.js';
import { TenantContextGuard } from './common/guards/tenant-context.js';
import { MfaEnrolmentGuard } from './modules/auth/require-mfa.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { RolesModule } from './modules/roles/roles.module.js';

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
  it('runs the ten stages of backend.md §3 in the documented order', () => {
    expect(globalGuardClasses()).toEqual([
      RateLimitGuard,
      AuthenticationGuard,
      TenantContextGuard,
      CsrfGuard,
      CrossSiteGuard,
      EmailVerifiedGuard,
      MfaEnrolmentGuard,
      AuthorizationGuard,
      TenantRateLimitGuard,
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

  it('runs the limiter twice, and the second pass is after the permission check', () => {
    // Task 15. `perOrganization`'s identifier is `Session.activeOrganizationId`,
    // which `TenantContextGuard` resolves, so the edge pass cannot see it — a
    // fail-closed class whose only scope is `perOrganization` refuses every
    // request with 429 from there. Both bounds are asserted, because each is a
    // separate decision: after the tenant resolves is what makes the identifier
    // available at all, and after `AuthorizationGuard` is what stops a caller
    // the organisation's own rules refuse from spending the organisation's
    // window.
    expect(positionOf(TenantRateLimitGuard)).toBeGreaterThan(positionOf(TenantContextGuard));
    expect(positionOf(TenantRateLimitGuard)).toBeGreaterThan(positionOf(AuthorizationGuard));
    expect(positionOf(TenantRateLimitGuard)).toBeLessThan(positionOf(EntitlementGuard));
  });

  it('registers the two limiter passes as two DIFFERENT classes', () => {
    // Nest resolves an `APP_GUARD` by class, so registering `RateLimitGuard`
    // twice would be one instance in two positions running the same phase
    // twice — every `perIp` window charged twice per request, and
    // `perOrganization` still never evaluated. The distinct subclass is what
    // makes the two positions two behaviours.
    expect(TenantRateLimitGuard).not.toBe(RateLimitGuard);
    expect(Object.getPrototypeOf(TenantRateLimitGuard)).toBe(RateLimitGuard);
  });

  it('registers exactly ten global guards', () => {
    // An eleventh arriving unnoticed is a stage nobody chose the position of.
    // Phase 10's real entitlement check replaces the stub rather than adding to
    // this number; Phase 3's audit stage is service-level and is not a guard.
    // The tenth is Task 15's second limiter pass.
    expect(globalGuardClasses()).toHaveLength(10);
  });
});

/**
 * THE MODULES THE COMPOSITION ROOT IMPORTS, ASSERTED THE WAY RULING 103 SAYS TO.
 *
 * L-2 again, in its other form: `toContain` over a module's **source text** is
 * satisfied by the import line, so deleting an entry from the `imports` array
 * while leaving its `import` statement leaves such a test green. Measured in
 * Task 12 — removing the `APP_GUARD` provider for `MfaEnrolmentGuard` left
 * `require-mfa.spec.ts` at 14 passed, exit 0.
 *
 * Reading `Reflect.getMetadata('imports', AppModule)` reads the array Nest
 * actually consumes.
 *
 * `OrganizationsModule` is the entry this block was added for. Without it in
 * the array, none of the five organisation routes is registered — and the
 * failure is silent in exactly the wrong direction: `pnpm check:openapi` would
 * report a smaller document, the authorization matrix would find no
 * permission-guarded route and go back to running its 403 and cross-tenant-404
 * arms against nothing, and every one of those checks would still exit 0.
 */
function importedModules(): unknown[] {
  return (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
}

describe('the modules AppModule composes', () => {
  it('registers OrganizationsModule, without which no organisation route exists', () => {
    expect(importedModules()).toContain(OrganizationsModule);
  });

  it('registers AuthModule and RolesModule, which the guards depend on', () => {
    // `RolesModule` provides `TENANT_RESOLVER` and `MFA_ENROLMENT_POLICY`, and
    // an `APP_GUARD`'s dependencies are resolved from the module that declares
    // it — so its absence is a boot failure rather than a silent one. Asserted
    // anyway, because `AuthModule`'s absence is *not*: `OrganizationSwitchService`
    // lives there, and losing it would remove `POST /auth/switch-org` and with
    // it the only writer of `Session.activeOrganizationId`.
    expect(importedModules()).toContain(AuthModule);
    expect(importedModules()).toContain(RolesModule);
  });
});
