import { describe, expect, it } from 'vitest';
import { isLocked, LOCKOUT_LADDER_SECONDS, LOCKOUT_THRESHOLD, lockedUntilFor } from './lockout.js';

/**
 * THE LADDER, AS A PURE FUNCTION, PINNED TO A FIXED INSTANT.
 *
 * Carry-forward ruling 49: an assertion between two values both derived from
 * `Date.now()` in the same test is an assertion about scheduling. `NOW` below is
 * a literal, so every expectation here is an exact `Date`, and a mutant that
 * restarts the clock cannot pass by landing in the same millisecond.
 *
 * `security/authentication.md` §7 says "progressive delay then temporary lock
 * per account". The escalating lock window IS the progressive delay — see
 * `lockout.ts` for why a `setTimeout` is not — so this table is the whole
 * mechanism and there is nothing else to test at this layer.
 */

const NOW = new Date('2026-08-31T12:00:00.000Z');

const at = (offsetSeconds: number): Date => new Date(NOW.getTime() + offsetSeconds * 1000);

describe('lockedUntilFor', () => {
  it('does not lock for the first four consecutive failures', () => {
    for (const failures of [1, 2, 3, 4]) {
      expect(lockedUntilFor(failures, NOW), `failure ${String(failures)}`).toBeNull();
    }
  });

  it('locks for one minute on the fifth', () => {
    expect(lockedUntilFor(5, NOW)).toEqual(at(60));
  });

  it('climbs to five, fifteen and thirty minutes on the sixth, seventh and eighth', () => {
    expect(lockedUntilFor(6, NOW)).toEqual(at(300));
    expect(lockedUntilFor(7, NOW)).toEqual(at(900));
    expect(lockedUntilFor(8, NOW)).toEqual(at(1800));
  });

  it('caps at thirty minutes and never climbs past it', () => {
    // A cap, not a quotation: §7 names no figure, and `lockout.ts` records the
    // decision. Without a cap the ladder becomes an indefinite lock an
    // unauthenticated caller can impose on any account they can name, which is
    // §7's "one attacker must not lock out a whole tenant" one level down.
    for (const failures of [9, 20, 500, Number.MAX_SAFE_INTEGER]) {
      expect(lockedUntilFor(failures, NOW), `failure ${String(failures)}`).toEqual(at(1800));
    }
  });

  it('never returns a lock in the past, whatever it is handed', () => {
    // Every rung is a positive offset from `now`, so a lock this function
    // produces is always in the future. A lock already elapsed is a lock that
    // does nothing, and it would be indistinguishable from a bug.
    for (const failures of [5, 6, 7, 8, 9]) {
      const until = lockedUntilFor(failures, NOW);
      expect(until?.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('treats zero and negative counts as no lock rather than throwing', () => {
    // `failedLoginCount` is an `Int` with a `@default(0)` and nothing constrains
    // it below zero in the database. Fail open on an impossible input here
    // rather than throwing: an arithmetic surprise must not turn a login into a
    // 500, and the value it fails to is "no lock", which the caller then treats
    // exactly as it treats a first failure.
    expect(lockedUntilFor(0, NOW)).toBeNull();
    expect(lockedUntilFor(-3, NOW)).toBeNull();
  });

  it('exposes the threshold and the ladder it uses, so a caller need not restate them', () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_LADDER_SECONDS).toEqual([60, 300, 900, 1800]);
  });
});

describe('isLocked', () => {
  it('is false when no lock was ever set', () => {
    expect(isLocked(null, NOW)).toBe(false);
  });

  it('is true while the lock is in the future', () => {
    expect(isLocked(at(1), NOW)).toBe(true);
  });

  it('is false at the exact instant the lock expires, not one tick later', () => {
    // The boundary, pinned. `>` rather than `>=` would leave a user locked out
    // for one extra millisecond, which is harmless — but the asymmetry is the
    // kind that gets copied into a comparison where it is not.
    expect(isLocked(NOW, NOW)).toBe(false);
    expect(isLocked(at(-1), NOW)).toBe(false);
  });
});
