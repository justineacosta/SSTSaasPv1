import { createHmac } from 'node:crypto';

/**
 * A TOTP code generator that plays the part of the user's phone.
 *
 * # Why this is reimplemented rather than imported from the API
 *
 * `apps/api/src/modules/auth/totp.ts` exports `totpCode`, and importing it
 * would be less code. It would also make the journey's second-factor step
 * tautological: the API would be verifying codes against its own generator, and
 * an error shared by both — the wrong byte order, a mis-decoded secret, the
 * wrong step length — would cancel out and the test would pass. The step exists
 * to prove that **a third-party authenticator app can sign in**, and the only
 * way to test that is with an implementation that shares no code with the one
 * under test.
 *
 * So this is RFC 6238 (RFC 4226's HOTP over a time counter) written from the
 * specification: SHA-1, 30-second step, six digits — matching `TOTP_PRODUCTION`
 * and `security/authentication.md` §5. If the API's parameters ever change,
 * this file must be changed deliberately, which is the intended cost.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes the base32 secret the enrolment screen displays.
 *
 * Padding is stripped and case is normalised because that is what a real
 * authenticator does with a hand-typed secret. Any character outside the RFC
 * 4648 alphabet is an error rather than something to skip: silently ignoring a
 * stray byte would decode a *different* secret and the failure would surface as
 * "the code was rejected", which is the least informative possible message.
 */
function decodeBase32(secret: string): Buffer {
  const normalised = secret.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`"${character}" is not a base32 character; the secret was misread.`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * The code an authenticator would show for `secret` at `atMs`.
 *
 * The counter is written big-endian into eight bytes with `writeBigUInt64BE`
 * rather than assembled by hand — RFC 4226 §5.1 specifies an 8-byte big-endian
 * counter, and hand-assembly with 32-bit arithmetic is where implementations
 * usually go wrong.
 *
 * `atMs` is a parameter rather than an implicit `Date.now()` so a spec can
 * generate a code for a *neighbouring* step deliberately. The drift window is
 * ±1 step, so the natural "wrong code" for a negative test is one from far
 * outside it, not a random six digits that might collide.
 */
export function totpCodeAt(secret: string, atMs: number = Date.now()): string {
  const counter = BigInt(Math.floor(atMs / 1000 / STEP_SECONDS));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest();

  // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte selects
  // the offset, and the high bit of the selected word is masked off so the
  // result is a positive 31-bit integer on every platform.
  //
  // `readUInt8`/`readUInt32BE` rather than index access and hand-assembled
  // shifts. `noUncheckedIndexedAccess` types `digest[i]` as possibly undefined,
  // and the honest alternatives are five non-null assertions or five guards on
  // reads that cannot fail — a SHA-1 digest is twenty bytes and the offset is
  // at most fifteen. The Buffer readers are typed as returning a number, do
  // their own bounds checking, and say what the bytes mean rather than
  // reconstructing big-endian arithmetic by hand.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * A code that is validly formed but certainly wrong: one from far outside the
 * ±1 drift window.
 *
 * Six random digits would be wrong with probability 1 − 10⁻⁶, which is a flake
 * per million runs for no benefit. This is wrong with certainty.
 */
export function staleTotpCode(secret: string, atMs: number = Date.now()): string {
  return totpCodeAt(secret, atMs - 60 * 60 * 1000);
}
