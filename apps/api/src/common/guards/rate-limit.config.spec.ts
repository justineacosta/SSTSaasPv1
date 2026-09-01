import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_CLASSES, type RateLimitClassConfig } from './rate-limit.config.js';

const windowsOf = (config: RateLimitClassConfig) =>
  [config.perIp, config.perPrincipal, config.perOrganization].filter((w) => w !== undefined);

describe('RATE_LIMIT_CLASSES', () => {
  it('declares at least one window for every class', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      // A class with no window is a route that believes it is rate limited and
      // is not. The guard cannot detect this at runtime — every scope would
      // simply be absent rather than unresolvable — so it is caught here.
      expect(windowsOf(config).length, name).toBeGreaterThan(0);
    }
  });

  it('uses positive, integral limits and windows throughout', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      for (const window of windowsOf(config)) {
        expect(window.limit, name).toBeGreaterThan(0);
        expect(Number.isInteger(window.limit), `${name} limit is an integer`).toBe(true);
        expect(window.windowSeconds, name).toBeGreaterThan(0);
        expect(Number.isInteger(window.windowSeconds), `${name} window is an integer`).toBe(true);
      }
    }
  });

  it('fails closed on every authentication class', () => {
    // abuse-prevention.md §1: a Redis outage must not become a window for
    // credential stuffing. Getting this backwards is the single most costly
    // mistake available in this file.
    for (const name of [
      'login',
      'registration',
      'passwordReset',
      'emailVerificationResend',
      'emailVerificationConsume',
      // Task 10's two. `passwordResetConsume` is an unauthenticated write
      // channel that pays an Argon2id hash per request; `passwordChange`
      // verifies a password and is therefore a credential-guessing oracle for
      // anyone holding a stolen session. Neither may become unbounded because
      // Redis is unreachable.
      'passwordResetConsume',
      'passwordChange',
      // Task 11's two. `mfaVerify` checks a six-digit secret, and
      // `mfaManagement` verifies the current password on three of its four
      // routes — including the one that turns the second factor OFF. An outage
      // must not open a window for either.
      'mfaVerify',
      'mfaManagement',
    ] as const) {
      expect(RATE_LIMIT_CLASSES[name].failMode, name).toBe('closed');
    }
  });

  it('fails open on the general read classes', () => {
    // The other half of the same trade: an outage must not lock every customer
    // out of reading their own data.
    expect(RATE_LIMIT_CLASSES.generalSession.failMode).toBe('open');
    expect(RATE_LIMIT_CLASSES.generalApiKey.failMode).toBe('open');
  });

  it('transcribes abuse-prevention.md §1 exactly', () => {
    // The table is the authority and this is the transcription check. Asserting
    // the numbers individually rather than in a loop, because a loop over the
    // same object cannot tell the difference between the table and itself.
    expect(RATE_LIMIT_CLASSES.login.perPrincipal).toEqual({ limit: 5, windowSeconds: 900 });
    expect(RATE_LIMIT_CLASSES.login.perIp).toEqual({ limit: 20, windowSeconds: 900 });
    expect(RATE_LIMIT_CLASSES.registration.perIp).toEqual({ limit: 3, windowSeconds: 3600 });
    expect(RATE_LIMIT_CLASSES.passwordReset.perPrincipal).toEqual({
      limit: 3,
      windowSeconds: 3600,
    });
    expect(RATE_LIMIT_CLASSES.passwordReset.perIp).toEqual({ limit: 10, windowSeconds: 3600 });
    expect(RATE_LIMIT_CLASSES.emailVerificationResend.perPrincipal).toEqual({
      limit: 3,
      windowSeconds: 3600,
    });
    // Not transcribed from the table's per-class row — added from §1's opening
    // rule that limits apply per IP AND per principal, because without it one
    // caller naming a fresh address each time has no bound at all. Asserted
    // here so the figure and the table row stay in step.
    expect(RATE_LIMIT_CLASSES.emailVerificationResend.perIp).toEqual({
      limit: 10,
      windowSeconds: 3600,
    });
    // Task 8's row. §1's table had no line for submitting a verification token;
    // the line was added to the document in the same change as this class, and
    // this assertion is what keeps the two in step from here on.
    expect(RATE_LIMIT_CLASSES.emailVerificationConsume.perIp).toEqual({
      limit: 30,
      windowSeconds: 3600,
    });
    // Per IP ONLY. `verifyEmailRequestSchema` is `{ token }` — there is no
    // account in the body to key a per-account window on, and a class that
    // declared one would resolve nothing on every request.
    const consume: RateLimitClassConfig = RATE_LIMIT_CLASSES.emailVerificationConsume;
    expect(consume.perPrincipal).toBeUndefined();
    expect(consume.perOrganization).toBeUndefined();
    // Task 10's two rows. Neither was transcribed from §1's table: §1 had a
    // line for requesting a reset and none for completing one or for changing a
    // password, so both figures are DECISIONS made in this codebase and written
    // into that document in the same change. These assertions are what keep the
    // figures and the document in step from here on.
    expect(RATE_LIMIT_CLASSES.passwordResetConsume.perIp).toEqual({
      limit: 20,
      windowSeconds: 3600,
    });
    // Per IP ONLY, and for `emailVerificationConsume`'s reason exactly:
    // `resetPasswordRequestSchema` is `{ token, password }`, so there is no
    // account in the body to key a per-account window on. Deriving one from the
    // token would mean a database read bought by an unauthenticated caller
    // BEFORE the limiter has decided anything, which is the thing the limiter
    // runs first to prevent.
    const resetConsume: RateLimitClassConfig = RATE_LIMIT_CLASSES.passwordResetConsume;
    expect(resetConsume.perPrincipal).toBeUndefined();
    expect(resetConsume.perOrganization).toBeUndefined();

    expect(RATE_LIMIT_CLASSES.passwordChange.perIp).toEqual({ limit: 10, windowSeconds: 3600 });
    // Per IP only, and this one is a control rather than bookkeeping — see the
    // class's own docblock. The per-PRINCIPAL half would be the right key and
    // resolves nothing today, because the limiter runs before the
    // authentication guard (`architecture/backend.md` §3). Declaring it anyway
    // would be carry-forward ruling 55's defect deliberately: an unresolvable
    // scope that nothing reports at the default log level.
    const change: RateLimitClassConfig = RATE_LIMIT_CLASSES.passwordChange;
    expect(change.perPrincipal).toBeUndefined();
    expect(change.perOrganization).toBeUndefined();

    // Task 11's two, and both are decisions written into §1 in the same change
    // rather than quotations from it — §1 had no MFA row at all.
    expect(RATE_LIMIT_CLASSES.mfaVerify.perIp).toEqual({ limit: 60, windowSeconds: 3600 });
    expect(RATE_LIMIT_CLASSES.mfaManagement.perIp).toEqual({ limit: 10, windowSeconds: 3600 });
    // Per IP only on BOTH, and for two different reasons that land in the same
    // place. `mfa/verify` is unauthenticated and its body is
    // `{ pendingToken, code }`, so there is no account to key on and resolving
    // one from the token would be a database read bought before the limiter
    // decides. The four management routes DO have a principal, and it resolves
    // nothing: the limiter runs before the authentication guard
    // (`architecture/backend.md` §3), so declaring `perPrincipal` would be
    // carry-forward ruling 55's defect deliberately.
    for (const name of ['mfaVerify', 'mfaManagement'] as const) {
      const config: RateLimitClassConfig = RATE_LIMIT_CLASSES[name];
      expect(config.perPrincipal, name).toBeUndefined();
      expect(config.perOrganization, name).toBeUndefined();
      expect(config.failMode, name).toBe('closed');
    }

    expect(RATE_LIMIT_CLASSES.invitations.perOrganization).toEqual({
      limit: 50,
      windowSeconds: 86_400,
    });
    expect(RATE_LIMIT_CLASSES.scanCreate.perOrganization).toEqual({ limit: 10, windowSeconds: 60 });
    expect(RATE_LIMIT_CLASSES.evidenceUpload.perOrganization).toEqual({
      limit: 100,
      windowSeconds: 3600,
    });
    expect(RATE_LIMIT_CLASSES.reportGeneration.perOrganization).toEqual({
      limit: 10,
      windowSeconds: 3600,
    });
    expect(RATE_LIMIT_CLASSES.generalSession.perPrincipal).toEqual({
      limit: 1000,
      windowSeconds: 60,
    });
    expect(RATE_LIMIT_CLASSES.generalApiKey.perPrincipal).toEqual({
      limit: 600,
      windowSeconds: 60,
    });
  });

  it('declares a failMode on every class, including ones no endpoint reaches yet', () => {
    // Most of these classes are configuration waiting for their endpoints. A
    // typo in one must not lie dormant until Phase 10, when the endpoint that
    // reads it finally ships.
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      expect(['open', 'closed'], name).toContain(config.failMode);
    }
  });

  it('bounds every unauthenticated class by IP, not only by account', () => {
    // An unauthenticated class keyed ONLY by an account identifier the caller
    // supplies has no upper bound at all: the caller names a fresh account each
    // time and every request is the first in its own window. For
    // emailVerificationResend that is an outbound-email amplifier aimed at
    // people who are not our customers, plus unbounded Redis keys. §1's opening
    // sentence — per IP AND per principal — is the rule; the table's per-class
    // rows are the figures.
    for (const name of [
      'login',
      'registration',
      'passwordReset',
      'emailVerificationResend',
      // Task 10's two are unauthenticated as far as the limiter is concerned —
      // `passwordChange` sits behind `@AuthenticatedOnly()` but the limiter runs
      // ahead of the guard, so per-IP is the only bound either of them has.
      'passwordResetConsume',
      'passwordChange',
      // Task 11's two. `mfaVerify` checks a six-digit secret, and
      // `mfaManagement` verifies the current password on three of its four
      // routes — including the one that turns the second factor OFF. An outage
      // must not open a window for either.
      'mfaVerify',
      'mfaManagement',
    ] as const) {
      expect(RATE_LIMIT_CLASSES[name].perIp, `${name} must declare a per-IP bound`).toBeDefined();
    }
  });

  it('names a principal source for every class that limits per principal', () => {
    // The type already makes this a compile error. Asserted at runtime too,
    // because the type is the thing a future refactor might loosen, and this is
    // the defect that shipped once already: a per-account class silently
    // keyed off an authenticated principal that unauthenticated endpoints
    // never have.
    for (const [name, config] of Object.entries<RateLimitClassConfig>(RATE_LIMIT_CLASSES)) {
      if (config.perPrincipal === undefined) continue;
      expect(
        config.principalSource,
        `${name} must say where its principal comes from`,
      ).toBeDefined();
    }
  });

  it('keys the unauthenticated per-account classes off the request body', () => {
    for (const name of ['login', 'passwordReset', 'emailVerificationResend'] as const) {
      expect(RATE_LIMIT_CLASSES[name].principalSource, name).toEqual({ bodyField: 'email' });
    }
    // And the authenticated ones off the principal, which is the whole
    // distinction.
    expect(RATE_LIMIT_CLASSES.generalSession.principalSource).toBe('authenticated');
    expect(RATE_LIMIT_CLASSES.generalApiKey.principalSource).toBe('authenticated');
  });
});
