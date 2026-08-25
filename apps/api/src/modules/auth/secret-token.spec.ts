import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashSecretToken,
  mintSecretToken,
  SECRET_TOKEN_BYTES,
  SECRET_TOKEN_ENCODED_LENGTH,
} from './secret-token.js';

describe('mintSecretToken', () => {
  it('produces 256 bits of entropy, base64url encoded', () => {
    // security/authentication.md §6: "256-bit random". 32 bytes base64url is
    // 43 characters with no padding — which is what makes the value fit
    // `opaqueTokenSchema` (z.string().min(1).max(512)) without changing it.
    expect(SECRET_TOKEN_BYTES).toBe(32);
    const { token } = mintSecretToken();
    expect(token).toHaveLength(SECRET_TOKEN_ENCODED_LENGTH);
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats a token across a large sample', () => {
    // Not a proof of randomness — a collision here would mean the source is
    // not a CSPRNG at all, which is the failure worth catching cheaply.
    const seen = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) seen.add(mintSecretToken().token);
    expect(seen.size).toBe(5_000);
  });

  it('returns a hash that matches the raw token, and a hash that is not the token', () => {
    const { token, tokenHash } = mintSecretToken();
    expect(tokenHash).toBe(hashSecretToken(token));
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });
});

describe('hashSecretToken', () => {
  it('is SHA-256, hex encoded', () => {
    // Pinned against node:crypto directly rather than against a literal so the
    // assertion names the algorithm the contract requires (the phase's global
    // constraint: session, verification, reset and invitation tokens are
    // SHA-256 hashed at rest) instead of restating an opaque digest.
    const token = 'a-known-token';
    expect(hashSecretToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hashSecretToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, so a lookup by hash finds the row', () => {
    expect(hashSecretToken('same')).toBe(hashSecretToken('same'));
    expect(hashSecretToken('same')).not.toBe(hashSecretToken('other'));
  });
});
