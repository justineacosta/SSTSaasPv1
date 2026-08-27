import { describe, expect, it } from 'vitest';
import { parseCookieHeader, readCookie } from './cookie-header.js';

/**
 * THE FIRST COOKIE PARSER IN THIS CODEBASE.
 *
 * Task 6's carry-forward ruling 54 records that there was none: `cookies.ts` in
 * the auth module owns the session cookie's name and attributes on the way out,
 * and deliberately built nothing for the way in, because Task 6 issued
 * credentials and never inspected one.
 *
 * Its input is a header an attacker writes in full, and its output decides
 * which credential a request is carrying. Every case below is one an attacker
 * can construct.
 */
describe('parseCookieHeader', () => {
  it('reads a single pair', () => {
    expect(parseCookieHeader('a=1').get('a')).toBe('1');
  });

  it('reads several, separated the way a browser sends them', () => {
    const jar = parseCookieHeader('a=1; b=2; c=3');
    expect([jar.get('a'), jar.get('b'), jar.get('c')]).toEqual(['1', '2', '3']);
  });

  it('tolerates the separator without a space, which is legal', () => {
    expect(parseCookieHeader('a=1;b=2').get('b')).toBe('2');
  });

  it('is empty for an absent header rather than throwing', () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader('').size).toBe(0);
  });

  it('keeps a value containing an = sign, which base64 padding produces', () => {
    expect(parseCookieHeader('a=aGVsbG8=').get('a')).toBe('aGVsbG8=');
  });

  it('ignores a segment with no = at all', () => {
    const jar = parseCookieHeader('novalue; a=1');
    expect(jar.has('novalue')).toBe(false);
    expect(jar.get('a')).toBe('1');
  });

  it('ignores a segment with an empty name', () => {
    expect(parseCookieHeader('=1; a=2').has('')).toBe(false);
  });

  it('keeps an empty value, which is how a cleared cookie arrives', () => {
    expect(parseCookieHeader('a=; b=2').get('a')).toBe('');
  });

  it('does not percent-decode, and does not throw on a malformed escape', () => {
    // `decodeURIComponent('%')` throws a URIError. A parser that decoded would
    // turn an attacker-chosen cookie into a 500 on every request that carries
    // it. Nothing this application sets needs decoding: both cookies it issues
    // carry base64url or hex, which are already cookie-octet safe.
    expect(parseCookieHeader('a=%').get('a')).toBe('%');
    expect(parseCookieHeader('a=%zz%').get('a')).toBe('%zz%');
  });

  it('DROPS a name that appears more than once, rather than picking one', () => {
    // THE ONE THAT MATTERS. Two cookies with one name is not a value to choose
    // between — it is a signal that something is placing cookies that should
    // not be. First-wins and last-wins each hand the request to whichever party
    // can write on that side. Dropping it makes the request unauthenticated,
    // which is the only outcome that favours neither.
    const jar = parseCookieHeader('a=1; a=2');
    expect(jar.has('a')).toBe(false);
  });

  it('drops a duplicated name even when both copies are identical', () => {
    // Identical values are not evidence of good faith: an attacker who can read
    // the victim's cookie can also replay it. One rule, no special case.
    expect(parseCookieHeader('a=1; a=1').has('a')).toBe(false);
  });

  it('leaves the other cookies alone when one name is duplicated', () => {
    const jar = parseCookieHeader('a=1; b=2; a=3');
    expect(jar.has('a')).toBe(false);
    expect(jar.get('b')).toBe('2');
  });

  it('is case-sensitive in the name, as cookies are', () => {
    const jar = parseCookieHeader('A=1; a=2');
    expect(jar.get('A')).toBe('1');
    expect(jar.get('a')).toBe('2');
  });

  it('trims the surrounding whitespace a proxy may introduce', () => {
    expect(parseCookieHeader('  a = 1  ').get('a')).toBe('1');
  });
});

describe('readCookie', () => {
  it('returns the value when exactly one cookie of that name is present', () => {
    expect(readCookie('__Host-session=abc; other=1', '__Host-session')).toBe('abc');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCookie('other=1', '__Host-session')).toBeUndefined();
  });

  it('returns undefined for a duplicated name', () => {
    expect(readCookie('__Host-session=a; __Host-session=b', '__Host-session')).toBeUndefined();
  });

  it('returns undefined for an empty value', () => {
    // An empty session cookie is the cleared cookie the logout response sets.
    // Treating it as a credential would send an empty string to a SHA-256 and
    // spend a Redis and a Postgres lookup proving what the browser already
    // told us: there is no session here.
    expect(readCookie('__Host-session=; a=1', '__Host-session')).toBeUndefined();
  });

  it('returns undefined when there is no Cookie header at all', () => {
    expect(readCookie(undefined, '__Host-session')).toBeUndefined();
  });

  it('accepts the array form Node produces for a repeated Cookie header', () => {
    // Node exposes a repeated header as `string[]`. A parser typed only for
    // `string` would silently read `undefined` from it and every request with
    // two Cookie headers would be unauthenticated — a bypass of the wrong kind
    // if the check that follows is a deny rule.
    expect(readCookie(['a=1', '__Host-session=abc'], '__Host-session')).toBe('abc');
  });

  it('drops a name duplicated ACROSS two Cookie headers, not only within one', () => {
    expect(readCookie(['__Host-session=a', '__Host-session=b'], '__Host-session')).toBeUndefined();
  });
});
