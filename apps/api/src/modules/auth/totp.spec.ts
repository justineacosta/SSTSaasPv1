import { describe, expect, it } from 'vitest';
import {
  TOTP_DRIFT_STEPS,
  TOTP_PRODUCTION,
  otpauthUri,
  stepAt,
  totpCode,
  verifyTotpCode,
} from './totp.js';

/**
 * RFC 6238 APPENDIX B, AND IT IS THE REQUIREMENT RATHER THAN A NICE-TO-HAVE.
 *
 * A hand-rolled TOTP that passes only its own round trip — generate a code,
 * verify it — proves nothing at all: it passes for any self-consistent wrong
 * implementation, and a wrong implementation is a coin flip against a real
 * authenticator app. The published table is what says this is the same
 * algorithm Google Authenticator, 1Password and Aegis compute.
 *
 * **Two traps in the RFC that have sunk hand-rolled implementations before, both
 * of which this file exists to walk into deliberately:**
 *
 * 1. **The table is 8-digit.** Production is 6, so `digits` has to be a
 *    parameter or the table cannot be run at all. A hard-coded 6 makes this
 *    file impossible to write, which is why the parameter exists.
 * 2. **The three algorithm columns use three DIFFERENT seeds.** RFC 6238
 *    §1's reference implementation seeds each HMAC with the ASCII string
 *    `12345678901234567890` *truncated or repeated to the algorithm's key
 *    length* — 20 bytes for SHA-1, 32 for SHA-256, 64 for SHA-512. Reusing the
 *    20-byte seed for all three makes the SHA-256 and SHA-512 rows "fail" for a
 *    reason that is not the implementation.
 *
 * All three algorithms are implemented and all eighteen rows are executed.
 */
const RFC_6238_SEED_ASCII = '12345678901234567890';

function seedFor(byteLength: number): Buffer {
  return Buffer.from(RFC_6238_SEED_ASCII.repeat(4), 'ascii').subarray(0, byteLength);
}

const SEEDS = {
  SHA1: seedFor(20),
  SHA256: seedFor(32),
  SHA512: seedFor(64),
} as const;

/**
 * Appendix B, transcribed verbatim. T0 = 0, step = 30 seconds, 8 digits.
 *
 * The `T` column of the RFC is the step counter in hexadecimal; it is derived
 * here from the seconds column rather than transcribed, because deriving it is
 * the arithmetic under test (`stepAt`) and a transcription would let a broken
 * `stepAt` pass.
 */
const RFC_6238_VECTORS: readonly (readonly [
  seconds: number,
  sha1: string,
  sha256: string,
  sha512: string,
])[] = [
  [59, '94287082', '46119246', '90693936'],
  [1_111_111_109, '07081804', '68084774', '25091201'],
  [1_111_111_111, '14050471', '67062674', '99943326'],
  [1_234_567_890, '89005924', '91819424', '93441116'],
  [2_000_000_000, '69279037', '90698825', '38618901'],
  [20_000_000_000, '65353130', '77737706', '47863826'],
];

describe('totpCode against RFC 6238 Appendix B', () => {
  for (const [seconds, sha1, sha256, sha512] of RFC_6238_VECTORS) {
    const step = stepAt(seconds * 1000, 30);

    it(`SHA1 at T=${String(seconds)}s is ${sha1}`, () => {
      expect(totpCode(SEEDS.SHA1, step, { algorithm: 'SHA1', digits: 8, stepSeconds: 30 })).toBe(
        sha1,
      );
    });

    it(`SHA256 at T=${String(seconds)}s is ${sha256}`, () => {
      expect(
        totpCode(SEEDS.SHA256, step, { algorithm: 'SHA256', digits: 8, stepSeconds: 30 }),
      ).toBe(sha256);
    });

    it(`SHA512 at T=${String(seconds)}s is ${sha512}`, () => {
      expect(
        totpCode(SEEDS.SHA512, step, { algorithm: 'SHA512', digits: 8, stepSeconds: 30 }),
      ).toBe(sha512);
    });
  }
});

describe('stepAt', () => {
  it('is the floor of unix seconds over the step', () => {
    expect(stepAt(0, 30)).toBe(0);
    expect(stepAt(29_999, 30)).toBe(0);
    expect(stepAt(30_000, 30)).toBe(1);
    expect(stepAt(59_000, 30)).toBe(1);
    // Appendix B's own T column: 59s -> 0x1, 1111111109s -> 0x23523EC.
    expect(stepAt(59_000, 30)).toBe(0x1);
    expect(stepAt(1_111_111_109_000, 30)).toBe(0x23523ec);
    expect(stepAt(20_000_000_000_000, 30)).toBe(0x27bc86aa);
  });

  it('stays inside a signed 32-bit range for as long as anyone can plan for', () => {
    // D6's replay column stores this number, so its magnitude is what chose the
    // column type. At a 30-second step, Postgres `integer` (2^31-1) is not
    // exhausted until step 2147483647, which is 64424509410 seconds after the
    // epoch — the year 4011. The assertions pin the arithmetic rather than the
    // date: the counter is comfortably inside int4 in 2100, and the exhaustion
    // point is where that calculation says it is.
    expect(stepAt(Date.UTC(2100, 0, 1), 30)).toBeLessThan(2 ** 31 - 1);
    expect(stepAt(Date.UTC(2100, 0, 1), 30)).toBeGreaterThan(100_000_000);
    expect(new Date((2 ** 31 - 1) * 30 * 1000).getUTCFullYear()).toBe(4011);
  });
});

describe('the production parameters', () => {
  it('are SHA-1, six digits, a thirty-second step, and a one-step drift window', () => {
    expect(TOTP_PRODUCTION).toEqual({ algorithm: 'SHA1', digits: 6, stepSeconds: 30 });
    expect(TOTP_DRIFT_STEPS).toBe(1);
  });

  it('produces exactly six digits, zero-padded', () => {
    // A code whose dynamic truncation lands below 100000 must still be six
    // characters. Scanning a range guarantees at least one such step rather
    // than hoping the single sample is a low one.
    const secret = seedFor(20);
    const codes = Array.from({ length: 200 }, (_, index) =>
      totpCode(secret, index, TOTP_PRODUCTION),
    );
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });
});

describe('verifyTotpCode drift window', () => {
  const secret = seedFor(20);
  const now = 1_700_000_000_000;
  const current = stepAt(now, 30);

  it('accepts the current step and reports it', () => {
    expect(
      verifyTotpCode({ secret, code: totpCode(secret, current, TOTP_PRODUCTION), atMs: now }),
    ).toBe(current);
  });

  it('accepts one step behind and one step ahead', () => {
    expect(
      verifyTotpCode({ secret, code: totpCode(secret, current - 1, TOTP_PRODUCTION), atMs: now }),
    ).toBe(current - 1);
    expect(
      verifyTotpCode({ secret, code: totpCode(secret, current + 1, TOTP_PRODUCTION), atMs: now }),
    ).toBe(current + 1);
  });

  it('rejects two steps behind and two steps ahead', () => {
    expect(
      verifyTotpCode({ secret, code: totpCode(secret, current - 2, TOTP_PRODUCTION), atMs: now }),
    ).toBeNull();
    expect(
      verifyTotpCode({ secret, code: totpCode(secret, current + 2, TOTP_PRODUCTION), atMs: now }),
    ).toBeNull();
  });

  it('rejects a code of the wrong length, a non-numeric code and an empty code', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '  1234']) {
      expect(verifyTotpCode({ secret, code, atMs: now })).toBeNull();
    }
  });

  it('rejects a code computed from a different secret', () => {
    const other = Buffer.from('this is a different twenty', 'ascii').subarray(0, 20);
    expect(
      verifyTotpCode({ secret, code: totpCode(other, current, TOTP_PRODUCTION), atMs: now }),
    ).toBeNull();
  });

  it('refuses every step at or below the replay floor', () => {
    // D6. The primitive reports which step was accepted; the floor is applied
    // here so a caller cannot forget it, and the ATOMIC half lives in the
    // database (see `mfa-verification.service.ts`).
    expect(
      verifyTotpCode({
        secret,
        code: totpCode(secret, current, TOTP_PRODUCTION),
        atMs: now,
        minimumStep: current + 1,
      }),
    ).toBeNull();
    expect(
      verifyTotpCode({
        secret,
        code: totpCode(secret, current, TOTP_PRODUCTION),
        atMs: now,
        minimumStep: current,
      }),
    ).toBe(current);
  });
});

describe('otpauthUri', () => {
  it('carries the label, issuer and every parameter an authenticator reads', () => {
    const uri = otpauthUri({ email: 'ada@example.com', secret: Buffer.from('foobar', 'ascii') });
    expect(uri).toBe(
      'otpauth://totp/Sentinel:ada%40example.com' +
        '?secret=MZXW6YTBOI&issuer=Sentinel&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('percent-encodes an address that would otherwise break the label', () => {
    const uri = otpauthUri({ email: 'a+b/c?d@example.com', secret: Buffer.alloc(20) });
    expect(uri).toContain('Sentinel:a%2Bb%2Fc%3Fd%40example.com');
    // The label separator itself must survive: an authenticator splits on the
    // first unencoded colon to find the issuer prefix.
    expect(uri.startsWith('otpauth://totp/Sentinel:')).toBe(true);
  });

  it('emits an unpadded secret', () => {
    expect(otpauthUri({ email: 'a@b.test', secret: Buffer.from('f', 'ascii') })).toContain(
      'secret=MY&',
    );
  });
});
