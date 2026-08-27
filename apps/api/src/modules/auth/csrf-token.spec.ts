import { describe, expect, it } from 'vitest';
import { CSRF_TOKEN_ENCODED_LENGTH, csrfTokenMatches, deriveCsrfToken } from './csrf-token.js';
import { mintSecretToken } from './secret-token.js';

const sessionA = mintSecretToken().token;
const sessionB = mintSecretToken().token;

describe('deriveCsrfToken', () => {
  it('is deterministic for one session token', () => {
    // Every API instance has to reach the same answer from the cookie alone.
    // Anything stored per session would need a column, and anything random per
    // request would need somewhere to remember it.
    expect(deriveCsrfToken(sessionA)).toBe(deriveCsrfToken(sessionA));
  });

  it('BINDS to the session — a different session derives a different token', () => {
    // §4: "bound to the session, so a token minted for one session does not
    // validate another". This is that sentence.
    expect(deriveCsrfToken(sessionA)).not.toBe(deriveCsrfToken(sessionB));
  });

  it('never returns the session token, or any part of it', () => {
    // The CSRF cookie is NOT HttpOnly — page script reads it, and so does
    // anything that can read the DOM. If it carried the session token, the
    // control designed to protect the session would be the thing that leaks it.
    const derived = deriveCsrfToken(sessionA);
    expect(derived).not.toBe(sessionA);
    expect(derived).not.toContain(sessionA);
    expect(sessionA).not.toContain(derived);
  });

  it('is base64url, so it is a legal cookie value with no escaping', () => {
    expect(deriveCsrfToken(sessionA)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is 43 characters — 256 bits of HMAC output, base64url', () => {
    expect(deriveCsrfToken(sessionA)).toHaveLength(CSRF_TOKEN_ENCODED_LENGTH);
    expect(CSRF_TOKEN_ENCODED_LENGTH).toBe(43);
  });

  it('changes when the session rotates, with no extra step', () => {
    // Rotation mints a new session token (Task 6), so the CSRF token follows on
    // its own. A design storing the CSRF secret separately would need rotation
    // to remember to rotate it too, and forgetting is silent.
    const rotated = mintSecretToken().token;
    expect(deriveCsrfToken(rotated)).not.toBe(deriveCsrfToken(sessionA));
  });
});

describe('csrfTokenMatches', () => {
  it('accepts the token derived from the same session', () => {
    expect(csrfTokenMatches(deriveCsrfToken(sessionA), sessionA)).toBe(true);
  });

  it('refuses a token derived from another session', () => {
    expect(csrfTokenMatches(deriveCsrfToken(sessionB), sessionA)).toBe(false);
  });

  it('refuses an empty presented token', () => {
    expect(csrfTokenMatches('', sessionA)).toBe(false);
  });

  it('refuses input of a DIFFERENT LENGTH without throwing', () => {
    // `crypto.timingSafeEqual` throws a RangeError on unequal lengths, which is
    // the obvious way to reintroduce the timing leak it exists to remove — and
    // to turn a forged header into a 500. Both sides are hashed to a fixed 32
    // bytes before the comparison, so length is never a branch.
    for (const presented of ['a', 'a'.repeat(1_000), deriveCsrfToken(sessionA).slice(0, 42)]) {
      expect(() => csrfTokenMatches(presented, sessionA)).not.toThrow();
      expect(csrfTokenMatches(presented, sessionA)).toBe(false);
    }
  });

  it('refuses a token that differs only in its last character', () => {
    const valid = deriveCsrfToken(sessionA);
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
    expect(csrfTokenMatches(tampered, sessionA)).toBe(false);
  });

  it('handles a non-ASCII presented token without throwing', () => {
    // A header value can carry bytes that are not the base64url the honest path
    // produces. Hashing both sides means the comparison never sees them.
    expect(() => csrfTokenMatches('ééé', sessionA)).not.toThrow();
    expect(csrfTokenMatches('ééé', sessionA)).toBe(false);
  });
});
