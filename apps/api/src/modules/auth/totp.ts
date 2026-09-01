import { createHmac, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32.js';

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, on `node:crypto`.
 *
 * # Hand-rolled, and proved against the RFC's own vectors
 *
 * The primitive is forty lines of HMAC and modular arithmetic. ADR-0013 puts a
 * 24-hour release-age cooldown on every dependency, so adding one for forty
 * lines is a gamble against CI for something this small — and the reason a TOTP
 * library is usually worth having (constant-time comparison, drift handling,
 * base32) is met here explicitly rather than assumed.
 *
 * What makes hand-rolling safe is `totp.spec.ts`: it executes **RFC 6238
 * Appendix B in full**, all six time values across all three HMAC algorithms.
 * A round-trip test would prove only that this file agrees with itself, and a
 * self-consistent wrong implementation is a coin flip against a real
 * authenticator app.
 *
 * # SHA-1 is correct here, and this comment exists so nobody "fixes" it
 *
 * `TOTP_PRODUCTION` is SHA-1, and that is not a weakness in this construction.
 * TOTP uses HMAC, whose security does not rest on collision resistance — the
 * property SHA-1 lost — and HMAC-SHA1 has no practical attack. More to the
 * point, **it is what every authenticator app implements**: the `algorithm`
 * parameter of `otpauth://` is widely ignored, and several popular apps
 * silently compute SHA-1 whatever the URI says. Switching to SHA-256 here would
 * produce codes a user's phone does not agree with, which presents as "MFA is
 * broken" rather than as a configuration mistake.
 *
 * # `digits` and `algorithm` are parameters because the vectors need them
 *
 * Appendix B's table is **8-digit** across three algorithms. Hard-coding six
 * digits would make the table impossible to execute, which is the difference
 * between a tested implementation and an asserted one. Production passes
 * `TOTP_PRODUCTION`; only the spec passes anything else.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParameters {
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly stepSeconds: number;
}

/**
 * `security/authentication.md` §5: 30-second step, ±1 window, and six digits
 * because that is what a user reads off a phone.
 */
export const TOTP_PRODUCTION: TotpParameters = {
  algorithm: 'SHA1',
  digits: 6,
  stepSeconds: 30,
};

/**
 * §5's "±1 window for clock drift" — steps `t-1`, `t` and `t+1` are accepted.
 *
 * **The window is why the replay defence exists.** A code accepted at step `t`
 * stays computable for ~90 seconds, so an attacker who observes one has that
 * long to use it. The window does not defend against that and nothing else in
 * the drift design does; `mfa-verification.service.ts` stores the accepted step
 * and refuses anything at or below it.
 */
export const TOTP_DRIFT_STEPS = 1;

/** The number of bytes of entropy in a generated secret. */
export const TOTP_SECRET_BYTES = 20;

const NODE_HASH: Readonly<Record<TotpAlgorithm, string>> = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA512: 'sha512',
};

/** RFC 6238's `T = (unixtime - T0) / X`, with `T0 = 0`. Floored, never rounded. */
export function stepAt(atMs: number, stepSeconds: number): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/**
 * RFC 4226 §5.3's dynamic truncation, applied to the HMAC of the step counter.
 *
 * The counter is eight bytes, big-endian. `writeBigUInt64BE` rather than two
 * 32-bit writes: the high word is zero for every date anyone will see, and a
 * reader who assumes that is one of the ways this gets written wrong.
 */
export function totpCode(
  secret: Uint8Array,
  step: number,
  parameters: TotpParameters = TOTP_PRODUCTION,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac(NODE_HASH[parameters.algorithm], secret).update(counter).digest();

  // The low four bits of the LAST byte choose the offset. `digest.length - 1`
  // rather than a literal 19, because the offset is algorithm-dependent and
  // SHA-256 and SHA-512 produce longer digests — the mistake that makes the
  // SHA-1 rows pass and the other two fail.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** parameters.digits).padStart(parameters.digits, '0');
}

export interface VerifyTotpInput {
  readonly secret: Uint8Array;
  /** Exactly as the caller submitted it, already trimmed by the request schema. */
  readonly code: string;
  readonly atMs: number;
  /**
   * D6's replay floor: the lowest step this factor may still accept, which is
   * `lastAcceptedStep + 1`. Omitted means "no code has been accepted yet".
   *
   * It is a parameter of the primitive rather than a check the caller performs
   * afterwards so that a caller cannot forget it. **The atomic half is not
   * here**: two concurrent requests both read the same floor, so the store is
   * what has to arbitrate, and it does — see `mfa-verification.service.ts`.
   */
  readonly minimumStep?: number | undefined;
  readonly parameters?: TotpParameters | undefined;
  readonly driftSteps?: number | undefined;
}

/**
 * Returns the step the code was accepted at, or `null`.
 *
 * **The step is returned rather than a boolean** because D6's replay defence
 * has to store it. A boolean would force the caller to recompute which step
 * matched, and a recomputation is a second implementation of the window.
 *
 * The comparison is `timingSafeEqual` on equal-length buffers. The value being
 * compared is a six-digit number an attacker can already enumerate at whatever
 * rate the limiter allows, so this is not the control that stops guessing — the
 * rate limit and the five-attempt lock are. It is here because a length-first
 * `===` on a secret-derived value is the habit worth keeping, and because the
 * cost is nothing.
 */
export function verifyTotpCode(input: VerifyTotpInput): number | null {
  const parameters = input.parameters ?? TOTP_PRODUCTION;
  const drift = input.driftSteps ?? TOTP_DRIFT_STEPS;

  // Length and charset first, and both are refusals rather than exceptions: the
  // submitted value is external input and `mfa/verify` accepts a recovery code
  // through the same field, so a non-numeric string is an ordinary miss here.
  if (input.code.length !== parameters.digits) return null;
  if (!/^\d+$/.test(input.code)) return null;

  const submitted = Buffer.from(input.code, 'ascii');
  const current = stepAt(input.atMs, parameters.stepSeconds);

  // Oldest first, so a code that is valid at more than one step (impossible for
  // a real HMAC, but the loop should not depend on that) reports the earliest —
  // the conservative choice for a floor that only moves forward.
  for (let step = current - drift; step <= current + drift; step += 1) {
    if (input.minimumStep !== undefined && step < input.minimumStep) continue;
    const expected = Buffer.from(totpCode(input.secret, step, parameters), 'ascii');
    if (expected.length === submitted.length && timingSafeEqual(expected, submitted)) return step;
  }
  return null;
}

/**
 * The `otpauth://` URI an authenticator app scans. The QR **image** is the
 * frontend's job (Task 17); this is the payload it encodes.
 *
 * `Sentinel:{email}` is the label and `Sentinel` the issuer, both present
 * because authenticator apps disagree about which they read — some show the
 * label's prefix, some the `issuer` parameter, and an app that sees neither
 * lists the entry as an unnamed address.
 *
 * **Percent-encoded, and the label separator survives it.** `encodeURIComponent`
 * escapes `@`, `+`, `/` and `?` — every one of which appears in real addresses
 * and every one of which changes the meaning of the path or the query — while
 * the literal `:` between issuer and account is written outside the encoding,
 * because an app splits on the first unescaped colon to find the issuer prefix.
 *
 * The secret is unpadded base32 (`=` would need escaping in a query value and
 * every authenticator accepts the unpadded form).
 */
export const TOTP_ISSUER = 'Sentinel';

export function otpauthUri(input: { email: string; secret: Uint8Array }): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(input.email)}`;
  const parameters = new URLSearchParams({
    secret: base32Encode(input.secret, { padding: false }),
    issuer: TOTP_ISSUER,
    algorithm: TOTP_PRODUCTION.algorithm,
    digits: String(TOTP_PRODUCTION.digits),
    period: String(TOTP_PRODUCTION.stepSeconds),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
