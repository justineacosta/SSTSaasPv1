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
