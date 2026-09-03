import { globSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_METADATA_KEY,
  type AccessDeclaration,
} from '../../common/decorators/access.decorator.js';
import {
  ALLOW_WITHOUT_MFA_ENROLMENT_KEY,
  AllowWithoutMfaEnrolment,
  MfaEnrolmentGuard,
  MfaEnrolmentRequiredError,
  requireMfaDecision,
} from './require-mfa.js';

/**
 * D8, AS OF TASK 12: THE MECHANISM IS BUILT HERE AND NOW REGISTERED, AND WHAT
 * IT GOVERNS IS STILL NOTHING.
 *
 * `security/authentication.md` §5 requires a member of an organisation with
 * `requireMfa` to be forced into enrolment **on every request, not only at
 * login**. Task 11 built the rule and left it wired nowhere; Task 12 placed it
 * in `app.module.ts` as a global guard and provided the lookup its constructor
 * asks for, so the check now runs on every authenticated request.
 *
 * **It can refuse as of Task 13, and this paragraph said the opposite until
 * then.** Through Task 12 the guard refused nobody for a reason about data
 * rather than wiring: it exits early when the request names no organisation,
 * nothing wrote `Session.activeOrganizationId`, and no organisation could be
 * created to set `requireMfa` in the first place. Task 13 shipped both the
 * endpoint that creates an organisation and the first routes that declare a
 * permission — but `MFA_ENROLMENT_REQUIRED` STILL HAS NO PRODUCER, because
 * nothing writes `Organization.requireMfa`. It defaults to `false` and the
 * update contract deliberately omits it (carry-forward ruling 15). Task 13
 * supplied one of the guard's two preconditions and not the other, and the
 * sentence here claiming otherwise was false until 2026-09-03. The
 * early exit is unchanged and is still what keeps a member with no factor able
 * to reach their own enrolment, session document and logout.
 *
 * The last describe block in this file is what keeps that honest in the other
 * direction: it asserts the registration exists, so removing it is a failing
 * test rather than a silent loss of the control.
 */
describe('requireMfaDecision', () => {
  const base = {
    organizationRequiresMfa: true,
    hasConfirmedFactor: false,
    routeIsExempt: false,
  } as const;

  it('refuses a member with no confirmed factor in an organisation that requires MFA', () => {
    expect(requireMfaDecision(base)).toBe('enrolment-required');
  });

  it('allows the same member once a factor is confirmed', () => {
    expect(requireMfaDecision({ ...base, hasConfirmedFactor: true })).toBe('allow');
  });

  it('allows a member with no factor when the organisation does not require MFA', () => {
    expect(requireMfaDecision({ ...base, organizationRequiresMfa: false })).toBe('allow');
  });

  it('allows an exempt route, which is what stops the rule bricking the account', () => {
    // A user forced into enrolment must still be able to REACH enrolment, sign
    // out, and read their own session document. Without the exemption the rule
    // would lock a member out of the only endpoints that could satisfy it — a
    // control that cannot be complied with is an outage, not a control.
    expect(requireMfaDecision({ ...base, routeIsExempt: true })).toBe('allow');
  });

  it('is decided on the CONFIRMED factor and never on a row existing', () => {
    // Carry-forward ruling 7 and `schema.prisma`: an abandoned unconfirmed
    // enrolment is a row that exists. The decision's input is named
    // `hasConfirmedFactor` rather than `hasFactor` so a caller cannot pass a
    // row count, which is the wrong query.
    const keys = Object.keys(base);
    expect(keys).toContain('hasConfirmedFactor');
    expect(keys).not.toContain('hasFactor');
  });
});

describe('MfaEnrolmentGuard', () => {
  class ExemptTarget {
    @AllowWithoutMfaEnrolment()
    exempt(): void {}

    guarded(): void {}
  }

  /**
   * The handler FUNCTION, fetched dynamically off the prototype.
   *
   * `target.exempt` would read the method without calling it, which
   * `@typescript-eslint/unbound-method` refuses — and the guard needs the exact
   * function object, because `@AllowWithoutMfaEnrolment()` defines its metadata
   * on that object and `Reflector.get(key, handler)` looks it up there.
   */
  function handlerOf(prototype: object, name: string): (...args: never[]) => unknown {
    return Reflect.get(prototype, name) as (...args: never[]) => unknown;
  }

  /**
   * The fake context carries a **permission** declaration by default, because
   * after the Task 12 review's H-1 that is the only kind of route this guard
   * acts on at all. A fixture that declared nothing would make every assertion
   * below pass through the first early return, which is carry-forward ruling
   * 58's shape — every fixture on one side of the branch under test.
   *
   * `getType` is part of it now: the guard exits non-HTTP contexts, and a fake
   * without the method threw `TypeError` rather than exercising the rule.
   */
  function contextFor(
    handler: (...args: never[]) => unknown,
    target: unknown,
    principal?: { userId: string; sessionId: string },
    // `null` means "no tenant resolved", NOT `undefined`: passing `undefined`
    // for an optional parameter selects the DEFAULT, so the no-tenant test read
    // as asserting one thing and exercised another. Caught by the test failing.
    tenant: { organizationId: string } | null = { organizationId: 'org_1' },
    access: AccessDeclaration | undefined = {
      kind: 'permission',
      permission: 'organization.read',
    },
  ): ExecutionContext {
    // The declaration is read through a real `Reflector`, so it has to live in
    // real metadata rather than being handed over as a value.
    if (access === undefined) {
      Reflect.deleteMetadata(ACCESS_METADATA_KEY, handler);
    } else {
      Reflect.defineMetadata(ACCESS_METADATA_KEY, access, handler);
    }
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => target,
      switchToHttp: () => ({
        getRequest: () => ({ principal, tenant: tenant ?? undefined }),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(policy: { requireMfa: boolean; hasConfirmedFactor: boolean }): {
    guard: MfaEnrolmentGuard;
    lookup: ReturnType<typeof vi.fn>;
  } {
    const lookup = vi.fn().mockResolvedValue(policy);
    return {
      guard: new MfaEnrolmentGuard(new Reflector(), lookup as never),
      lookup,
    };
  }

  it('refuses a guarded handler for a member who must enrol', async () => {
    const { guard } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(handlerOf(ExemptTarget.prototype, 'guarded'), ExemptTarget, {
          userId: 'usr_1',
          sessionId: 's',
        }),
      ),
    ).rejects.toBeInstanceOf(MfaEnrolmentRequiredError);
  });

  it('admits the same member on a handler carrying the exemption', async () => {
    const { guard } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(handlerOf(ExemptTarget.prototype, 'exempt'), ExemptTarget, {
          userId: 'usr_1',
          sessionId: 's',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('does not consult the policy at all when no tenant resolved', async () => {
    // The requirement belongs to an ORGANISATION THE CALLER IS A MEMBER OF.
    // H-1's second half: this used to read `request.activeOrganizationId`, the
    // raw session column, which says only that the cookie points somewhere —
    // so an organisation's MFA policy was applied to somebody whose membership
    // had not resolved. On a permission route an unresolved tenant has already
    // been refused with 404 one guard earlier.
    const { guard, lookup } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(
          handlerOf(ExemptTarget.prototype, 'guarded'),
          ExemptTarget,
          { userId: 'usr_1', sessionId: 's' },
          null,
        ),
      ),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * H-1, AT THE UNIT LEVEL. The guard must not act on a route that declares no
   * permission — that is what stops a member with no factor being locked out of
   * enrolment, logout and their own session document.
   */
  it('does not consult the policy on an @AuthenticatedOnly() route', async () => {
    const { guard, lookup } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(
          handlerOf(ExemptTarget.prototype, 'guarded'),
          ExemptTarget,
          { userId: 'usr_1', sessionId: 's' },
          { organizationId: 'org_1' },
          { kind: 'authenticated' },
        ),
      ),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not consult the policy on a @Public() route', async () => {
    const { guard, lookup } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(
          handlerOf(ExemptTarget.prototype, 'guarded'),
          ExemptTarget,
          { userId: 'usr_1', sessionId: 's' },
          { organizationId: 'org_1' },
          { kind: 'public' },
        ),
      ),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('admits an unauthenticated request rather than deciding for it', async () => {
    // Not this guard's question. `AuthenticationGuard` has already refused or
    // admitted; a second opinion here would be a second place for the
    // authentication rule to live.
    const { guard, lookup } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(contextFor(handlerOf(ExemptTarget.prototype, 'guarded'), ExemptTarget)),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * CARRY-FORWARD RULING 61, AND IT IS HALF THE CONTROL.
   *
   * `@AllowWithoutMfaEnrolment()` is an EXEMPTION, and this codebase has
   * shipped an exemption that honoured class-level metadata once already:
   * `@RateLimitExempt()` was typed `MethodDecorator` while the guard still read
   * `getAllAndOverride([handler, class])`, so one line on a controller disabled
   * every limit beneath it. Narrowing the type is the other half; without this
   * test, widening the guard's read leaves every test green.
   *
   * The inheritance case is here because `getAllAndOverride` walks the
   * prototype chain, so a subclass of an annotated class is the shape that
   * catches a partial fix.
   */
  it('ignores the exemption when it is set at the class level', async () => {
    @Controller()
    class ClassLevel {
      @Get()
      handler(): void {}
    }
    Reflect.defineMetadata(ALLOW_WITHOUT_MFA_ENROLMENT_KEY, true, ClassLevel);

    const { guard } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(handlerOf(ClassLevel.prototype, 'handler'), ClassLevel, {
          userId: 'usr_1',
          sessionId: 's',
        }),
      ),
    ).rejects.toBeInstanceOf(MfaEnrolmentRequiredError);
  });

  it('ignores the exemption when it is inherited from an annotated base class', async () => {
    class AnnotatedBase {
      handler(): void {}
    }
    Reflect.defineMetadata(ALLOW_WITHOUT_MFA_ENROLMENT_KEY, true, AnnotatedBase);
    class Derived extends AnnotatedBase {}

    const { guard } = guardWith({ requireMfa: true, hasConfirmedFactor: false });
    await expect(
      guard.canActivate(
        contextFor(handlerOf(Derived.prototype, 'handler'), Derived, {
          userId: 'usr_1',
          sessionId: 's',
        }),
      ),
    ).rejects.toBeInstanceOf(MfaEnrolmentRequiredError);
  });
});

describe('MfaEnrolmentRequiredError', () => {
  it('is a 403 naming enrolment, not a 401 naming a challenge', () => {
    // The caller IS authenticated — they hold a full session and have proved a
    // password. What is refused is the action, which is `conventions.md` §2's
    // 403. A 401 would tell the frontend to show a sign-in form, which is
    // exactly the wrong instruction: signing in again changes nothing.
    const error = new MfaEnrolmentRequiredError();
    expect(error.status).toBe(403);
    expect(error.code).toBe('MFA_ENROLMENT_REQUIRED');
    expect(error.message).not.toContain('sign in');
  });
});

/**
 * THE HONESTY TEST. D8: the guard is written here and ENFORCES NOTHING.
 *
 * Every sentence written about `requireMfa` says so, and a sentence is exactly
 * the kind of claim this phase keeps finding false. This asserts it against the
 * wiring instead: the guard is registered, its DI token is provided, and the
 * set of routes it can act on is empty.
 *
 * **Task 13 is what changes the last of those**, on the day it ships the first
 * permission-guarded endpoint.
 */
describe('the guard is registered, and what it can refuse is bounded', () => {
  /**
   * REWRITTEN AFTER THE TASK 12 REVIEW, TWICE OVER.
   *
   * M-4: the Task 12 report claimed this block asserted "the registration
   * **plus** the absence of any decorated handler". It did not — it had two
   * `toContain` assertions over file text and nothing else. That sentence was
   * what would have made a reader believe H-1 was held by a test.
   *
   * L-2: `toContain('MfaEnrolmentGuard')` over `app.module.ts` is satisfied by
   * the **import line**. Measured by the reviewer: deleting the `APP_GUARD`
   * provider while leaving the import left this file at 14 passed, exit 0. The
   * registration is now asserted against the module's actual provider
   * metadata, which an import cannot satisfy.
   */
  const globalGuards = (): unknown[] => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as {
      provide?: unknown;
      useClass?: unknown;
    }[];
    return providers
      .filter((provider) => provider.provide === APP_GUARD)
      .map((provider) => provider.useClass);
  };

  it('is registered as a global guard, by provider metadata and not by an import', () => {
    expect(globalGuards()).toContain(MfaEnrolmentGuard);
  });

  it('has its DI token provided, so registering it cannot fail at boot', () => {
    // The token is declared in `auth.tokens.ts` and provided in
    // `roles.module.ts`, where the tenant-scoped query it needs already lives.
    // A guard registered without its lookup fails at boot naming the token —
    // loudly, which is the right failure — but it fails, so this is the half of
    // the pair that keeps the application startable.
    const source = readFileSync(
      fileURLToPath(new URL('../roles/roles.module.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).toContain('MFA_ENROLMENT_POLICY');
  });

  /**
   * H-1, AS AN ASSERTION RATHER THAN A DOCBLOCK — AND THE DAY IT PREDICTED HAS
   * ARRIVED.
   *
   * The guard acts only on a route declaring a permission. Through Task 12 no
   * shipped route did, so it could refuse nobody, and this assertion said so
   * over the controller files rather than over a sentence. It also said: "on the
   * day Task 13 ships a permission-guarded endpoint this goes red, and whoever
   * ships it has to decide deliberately whether a member with no factor may
   * reach it."
   *
   * **THE DECISION, RECORDED HERE BECAUSE THIS IS WHERE IT WAS ASKED FOR.**
   * `GET`, `PATCH` and `DELETE /api/v1/organizations/:id` are gated: a member of
   * an organisation with `requireMfa = true` who has no confirmed factor is
   * refused with 403 `MFA_ENROLMENT_REQUIRED` and must enrol first. That is
   * `security/authentication.md` §5's rule applied without exception — "a member
   * without a confirmed factor is forced into enrolment before any other
   * action" — and it is the whole reason the guard exists.
   *
   * Nothing needs `@AllowWithoutMfaEnrolment()`. The routes a member in that
   * state must still reach — their own session document, logout, and the four
   * MFA management routes — are all `@AuthenticatedOnly()`, which is outside
   * this guard's reach by construction (ruling 98's structural fix). So is
   * `POST /auth/switch-org`, which means a member can always switch to a
   * different organisation rather than being stranded, and so are
   * `POST /organizations` and `GET /organizations`: neither acts inside an
   * organisation that could require anything.
   *
   * `MFA_ENROLMENT_REQUIRED` therefore has a producer a caller can reach for the
   * first time, and it is proved against a real `requireMfa = true` row in
   * `organizations.scoped.integration.spec.ts` rather than asserted here.
   *
   * What replaces the old assertion is its inverse, for the reason the
   * authorization matrix's sentinel gives: the failure mode has flipped. The
   * danger was a guard that governed nothing; it is now a guarded set silently
   * going back to empty, after which this guard would refuse nobody again and
   * every test would still pass.
   *
   * The count is pinned rather than merely non-zero (L-3, and the
   * wrong-directory glob that shipped once in `email-verified.guard.spec.ts`):
   * a glob that found nothing would make either claim true forever.
   */
  it('governs the permission-guarded routes, and there is at least one', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const controllers = globSync('**/*.controller.ts', { cwd: root }).map((relative) =>
      join(root, relative),
    );
    // Auth, health, invitation-acceptance, invitations, memberships, OpenAPI,
    // organizations, roles.
    expect(controllers).toHaveLength(8);

    const declaring = controllers.filter((file) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .includes('@RequirePermission('),
    );
    // Named and sorted, not counted. Task 14 added two of these four:
    // `memberships.controller.ts` (three routes) and `roles.controller.ts`
    // (one), which grew the set this guard governs from three routes to seven.
    // Task 15 added `invitations.controller.ts` (three), taking it to ten —
    // recomputed from `EXPECTED_GUARDED_ROUTES` in
    // `authorization-matrix.integration.spec.ts`, which holds exactly those ten
    // entries, rather than carried forward.
    //
    // `invitation-acceptance.controller.ts` is the eighth controller file and
    // declares no permission at all: `POST /invitations/accept` is
    // `@AuthenticatedOnly()`, because the acceptor is a member of nothing and
    // any `@RequirePermission()` would deny by construction (D1). That is why
    // the count above moved and this list did not.
    expect(declaring.map((file) => basename(file)).sort()).toEqual([
      'invitations.controller.ts',
      'memberships.controller.ts',
      'organizations.controller.ts',
      'roles.controller.ts',
    ]);
  });

  it('is not exempted by any handler, so the gate applies to every guarded route', () => {
    // The other direction, and the one ruling 98 was about: an opt-out control
    // whose exemption is applied to nothing is an outage, but an exemption
    // applied to the *wrong* route is a silent hole. Zero handlers carry
    // `@AllowWithoutMfaEnrolment()` and that is a decision — see the docblock
    // above for why nothing needs it.
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const controllers = globSync('**/*.controller.ts', { cwd: root }).map((relative) =>
      join(root, relative),
    );
    const exempted = controllers.filter((file) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .includes('@AllowWithoutMfaEnrolment('),
    );
    expect(exempted).toEqual([]);
  });
});
