/**
 * RFC 4648 base32, encode only.
 *
 * `node:crypto` and `Buffer` between them speak hex, base64 and base64url and
 * **not** base32, so this is written rather than imported. It is thirty lines,
 * and ADR-0013's 24-hour dependency cooldown makes adding a package for thirty
 * lines a gamble against CI for no gain.
 *
 * **Encode only, deliberately.** Nothing in this product reads a base32 value:
 * the TOTP secret is generated as bytes, stored encrypted as bytes, and encoded
 * here exactly once, for the `otpauth://` URI the user's authenticator app
 * scans. A decoder would be an unused export, and an unused export of a parser
 * is a surface somebody eventually points at user input.
 *
 * It is proved against RFC 4648 §10's published table (`base32.spec.ts`) rather
 * than against itself. A round trip proves only self-consistency, and a
 * self-consistent wrong alphabet is a QR code no authenticator can read — which
 * is a defect the user discovers at the worst possible moment, holding a phone
 * that will not produce the right number.
 */

/** RFC 4648 §6's alphabet. Upper case, no `0`, `1`, `8` or `9`. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const BITS_PER_CHARACTER = 5;
const BITS_PER_BYTE = 8;
/** One base32 quantum is 40 bits: five bytes in, eight characters out. */
const CHARACTERS_PER_QUANTUM = 8;

export interface Base32Options {
  /**
   * RFC 4648 pads to a multiple of eight characters with `=`. The `otpauth://`
   * URI does not — `=` needs percent-encoding in a query value, and every
   * authenticator accepts the unpadded form — so the URI builder asks for
   * `false` and the spec asserts both forms against the RFC's table.
   */
  readonly padding?: boolean;
}

export function base32Encode(bytes: Uint8Array, options: Base32Options = {}): string {
  const padding = options.padding ?? true;

  let accumulator = 0;
  let bitsHeld = 0;
  let encoded = '';

  for (const byte of bytes) {
    accumulator = (accumulator << BITS_PER_BYTE) | byte;
    bitsHeld += BITS_PER_BYTE;
    while (bitsHeld >= BITS_PER_CHARACTER) {
      bitsHeld -= BITS_PER_CHARACTER;
      encoded += ALPHABET[(accumulator >>> bitsHeld) & 0b11111];
    }
  }

  if (bitsHeld > 0) {
    // The remaining bits are the HIGH bits of the final character, so they are
    // shifted up rather than masked down. Getting this wrong produces a value
    // that decodes to the right bytes on a tolerant decoder and to different
    // bytes on a strict one, which is exactly the class of bug the published
    // vectors catch and a round trip does not.
    encoded += ALPHABET[(accumulator << (BITS_PER_CHARACTER - bitsHeld)) & 0b11111];
  }

  if (!padding) return encoded;

  const remainder = encoded.length % CHARACTERS_PER_QUANTUM;
  if (remainder === 0) return encoded;
  return encoded + '='.repeat(CHARACTERS_PER_QUANTUM - remainder);
}
