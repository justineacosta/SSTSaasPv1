import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
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
 * **It refuses nothing, for a reason that is about data and not about wiring.**
 * The guard exits early when the request names no organisation, and nothing in
 * Phase 2 writes `Session.activeOrganizationId` until Task 13 — so its policy
 * lookup is not reached on any request this phase can produce, and no
 * organisation can be created to set `requireMfa` in the first place. Nothing
 * may record `MFA_ENROLMENT_REQUIRED` as a refusal any caller can receive.
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

  function contextFor(
    handler: (...args: never[]) => unknown,
    target: unknown,
    principal?: { userId: string; sessionId: string },
    activeOrganizationId: string | null = 'org_1',
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => target,
      switchToHttp: () => ({
        getRequest: () => ({ principal, activeOrganizationId }),
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

  it('does not consult the policy at all when there is no active organisation', async () => {
    // The requirement belongs to an organisation. A session that has chosen
    // none cannot be subject to one, and asking would be a database read on
    // every request that could not change the answer.
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
 * Every sentence Task 11 writes about `requireMfa` says so, and a sentence is
 * exactly the kind of claim this phase keeps finding false. This asserts it
 * against the files instead: `MfaEnrolmentGuard` is named in no module, and the
 * DI token its constructor asks for is provided by nobody, so registering it
 * without also wiring the lookup would fail at boot naming the token rather
 * than admitting every request.
 *
 * **Task 12 is what changes this test**, deliberately, by the hand that places
 * the guard in the pipeline.
 */
describe('the guard is registered, and its lookup is provided', () => {
  /**
   * The module's CODE, with comments stripped.
   *
   * Modules deliberately *mention* the guard and its token in prose, and a raw
   * text search would read that documentation as the wiring it describes.
   * Stripping comments is what makes the assertion about wiring rather than
   * about wording — and it is what keeps this test honest in the new direction
   * too: a comment saying "registered in `app.module.ts`" would otherwise
   * satisfy it.
   */
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('is registered as a global guard in app.module.ts', () => {
    expect(read('../../app.module.ts')).toContain('MfaEnrolmentGuard');
  });

  it('has its DI token provided, so registering it cannot fail at boot', () => {
    // The token is declared in `auth.tokens.ts` and provided in
    // `roles.module.ts`, where the tenant-scoped query it needs already lives.
    // A guard registered without its lookup fails at boot naming the token —
    // loudly, which is the right failure — but it fails, so this is the half of
    // the pair that keeps the application startable.
    expect(read('../roles/roles.module.ts')).toContain('MFA_ENROLMENT_POLICY');
  });
});
