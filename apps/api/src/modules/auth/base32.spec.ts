import { describe, expect, it } from 'vitest';
import { base32Encode } from './base32.js';

/**
 * RFC 4648 §10'S OWN TEST VECTORS, AND THEY ARE THE REQUIREMENT.
 *
 * A round-trip test — encode then decode and compare — passes for any
 * self-consistent wrong implementation, including one with a rotated alphabet
 * or the wrong bit order. What an authenticator app reads is the *published*
 * encoding, so the published table is the only thing that proves this is it.
 *
 * The table is quoted verbatim from RFC 4648 §10, padding included. The
 * `otpauth://` URI strips the padding (`=` is not URI-safe without escaping and
 * every authenticator accepts the unpadded form), so both forms are asserted
 * here rather than one being inferred from the other.
 */
const RFC_4648_VECTORS: readonly (readonly [input: string, expected: string])[] = [
  ['', ''],
  ['f', 'MY======'],
  ['fo', 'MZXQ===='],
  ['foo', 'MZXW6==='],
  ['foob', 'MZXW6YQ='],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI======'],
];

describe('base32Encode against RFC 4648 §10', () => {
  for (const [input, expected] of RFC_4648_VECTORS) {
    it(`encodes ${JSON.stringify(input)} as ${JSON.stringify(expected)}`, () => {
      expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(expected);
    });
  }

  for (const [input, expected] of RFC_4648_VECTORS) {
    const unpadded = expected.replace(/=+$/, '');
    it(`encodes ${JSON.stringify(input)} unpadded as ${JSON.stringify(unpadded)}`, () => {
      expect(base32Encode(Buffer.from(input, 'ascii'), { padding: false })).toBe(unpadded);
    });
  }
});

describe('base32Encode shape', () => {
  it('emits only the RFC 4648 alphabet and padding', () => {
    // 20 bytes is the TOTP secret length, so this is the production case.
    const bytes = Buffer.alloc(20);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index * 13;
    expect(base32Encode(bytes)).toMatch(/^[A-Z2-7]+=*$/);
  });

  it('produces a length that is a multiple of eight when padded', () => {
    for (let length = 0; length <= 24; length += 1) {
      expect(base32Encode(Buffer.alloc(length)).length % 8).toBe(0);
    }
  });

  it('never emits padding when padding is off', () => {
    for (let length = 0; length <= 24; length += 1) {
      expect(base32Encode(Buffer.alloc(length), { padding: false })).not.toContain('=');
    }
  });
});
