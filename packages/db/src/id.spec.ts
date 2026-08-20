import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, newId, parseIdPrefix } from './id.js';

describe('newId', () => {
  it('produces a prefixed, 26-character Crockford base32 identifier', () => {
    const id = newId('org');
    expect(id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique identifiers under a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('fnd')));
    expect(ids.size).toBe(10_000);
  });

  it('sorts chronologically as a string, which is what gives index locality', async () => {
    const first = newId('scn');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId('scn');
    expect(first < second).toBe(true);
  });

  it('exposes a prefix for every entity type the API returns', () => {
    expect(ID_PREFIXES.org).toBe('org');
    expect(ID_PREFIXES.usr).toBe('usr');
    expect(ID_PREFIXES.aud).toBe('aud');
  });

  it('round-trips the prefix', () => {
    expect(parseIdPrefix(newId('mbr'))).toBe('mbr');
  });

  it('returns undefined for a string that is not one of our identifiers', () => {
    expect(parseIdPrefix('not-an-id')).toBeUndefined();
    expect(parseIdPrefix('xyz_01J8XK2P9V3QWERTYUIOPASDF')).toBeUndefined();
  });
});
