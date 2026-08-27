import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearedCsrfCookie,
  clearedSessionCookie,
  serialiseCsrfCookie,
  serialiseSessionCookie,
} from './cookies.js';

/**
 * THE COOKIE IS THE ONLY PART OF THIS TASK A BROWSER EVER SEES.
 *
 * `security/authentication.md` §3 fixes the whole header: `HttpOnly`, `Secure`,
 * `SameSite=Lax`, the `__Host-` prefix, path `/`. Each attribute is asserted
 * separately rather than against one golden string, so a failure names the
 * attribute that changed instead of printing two headers to diff by eye.
 */
describe('the session cookie name', () => {
  it('carries the __Host- prefix from §3', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-session');
  });
});

describe('serialiseSessionCookie', () => {
  const cookie = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: null });

  it('sets the value under the §3 name', () => {
    expect(cookie.startsWith('__Host-session=abc123;')).toBe(true);
  });

  it('is HttpOnly — script in the page must never read it', () => {
    expect(cookie).toContain('; HttpOnly');
  });

  it('is Secure, which the __Host- prefix also requires', () => {
    expect(cookie).toContain('; Secure');
  });

  it('is SameSite=Lax, the §4 baseline that CSRF defence sits on top of', () => {
    expect(cookie).toContain('; SameSite=Lax');
  });

  it('is scoped to Path=/ and carries no Domain, as __Host- requires', () => {
    expect(cookie).toContain('; Path=/');
    expect(cookie).not.toContain('Domain');
  });

  it('omits Max-Age entirely when it is null, making it a browser-session cookie', () => {
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
  });

  it('carries Max-Age when the caller asks for a persistent cookie', () => {
    const persistent = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: 2_592_000 });
    expect(persistent).toContain('; Max-Age=2592000');
  });

  it('floors a fractional Max-Age rather than emitting a decimal', () => {
    // `Max-Age=59.7` is not a valid delta-seconds production (RFC 6265 §5.2.2)
    // and a browser ignores the whole attribute, silently turning a persistent
    // cookie into a browser-session one.
    const persistent = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: 59.7 });
    expect(persistent).toContain('; Max-Age=59');
  });

  it('never emits a negative Max-Age from a session that is already over', () => {
    // A negative Max-Age tells the browser to delete the cookie immediately,
    // which is the right end state reached by the wrong path — a session past
    // its absolute expiry should never have been issued a cookie at all.
    const persistent = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: -5 });
    expect(persistent).toContain('; Max-Age=0');
  });

  it('emits digits for a non-finite Max-Age rather than the word NaN', () => {
    // MEASURED BY THE REVIEW, not suspected: `Math.max(0, Math.floor(NaN))` is
    // `NaN`, so the guard produced `Max-Age=NaN` and `Max-Age=Infinity` while
    // the comment beside it claimed digits only. `delta-seconds` (RFC 6265
    // §5.2.2) is digits, and a browser that cannot parse the attribute ignores
    // it — silently downgrading a persistent cookie to a session one, which is
    // the exact failure the comment names. A `NaN` arrives the way the comment
    // says: an `Invalid Date` on either side of a caller's subtraction.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const cookie = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: bad });
      expect(cookie).toContain('; Max-Age=0');
      expect(cookie).not.toContain('NaN');
      expect(cookie).not.toContain('Infinity');
    }
    // -Infinity already floored to 0 through `Math.max`; pinned so a rewrite of
    // the guard cannot lose it.
    expect(
      serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: Number.NEGATIVE_INFINITY }),
    ).toContain('; Max-Age=0');
  });

  it('emits only digits for every Max-Age it will accept', () => {
    // The general form of the rule, so a future arithmetic change has to keep it.
    for (const seconds of [0, 1, 59.7, 2_592_000, -5, Number.NaN]) {
      const cookie = serialiseSessionCookie({ value: 'abc123', maxAgeSeconds: seconds });
      expect(cookie).toMatch(/; Max-Age=\d+$/);
    }
  });

  it('refuses a value carrying anything a cookie value may not hold', () => {
    // Response-header injection. The token this normally carries is base64url
    // and can never contain any of these, so the guard exists for the day
    // something else is put in the cookie — the class of mistake carry-forward
    // ruling 42 records for the mail recipient guard.
    const carriageReturn = String.fromCharCode(13);
    const lineFeed = String.fromCharCode(10);
    const injected = `a${carriageReturn}${lineFeed}Set-Cookie: x=y`;

    for (const bad of [injected, 'a b', 'a;b', 'a,b', 'a"b', ' ']) {
      expect(() => serialiseSessionCookie({ value: bad, maxAgeSeconds: null })).toThrow(
        /cookie value/i,
      );
    }
  });

  it('refuses an empty value, which is how a cookie is cleared and not how it is set', () => {
    expect(() => serialiseSessionCookie({ value: '', maxAgeSeconds: null })).toThrow(
      /cookie value/i,
    );
  });
});

describe('clearedSessionCookie', () => {
  const cookie = clearedSessionCookie();

  it('empties the value and expires it immediately', () => {
    expect(cookie.startsWith('__Host-session=;')).toBe(true);
    expect(cookie).toContain('; Max-Age=0');
  });

  it('repeats every attribute of the cookie it is replacing', () => {
    // A browser matches a replacement cookie on name, domain and path. Clearing
    // with a different Path would add a second cookie instead of removing the
    // one that authenticates the user — a logout that logs nobody out.
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; SameSite=Lax');
    expect(cookie).toContain('; Path=/');
    expect(cookie).not.toContain('Domain');
  });
});

describe('the CSRF cookie', () => {
  const cookie = serialiseCsrfCookie({ value: 'abc123', maxAgeSeconds: 2_592_000 });

  it('carries the __Host- prefix, which §4 did not ask for and gets anyway', () => {
    expect(CSRF_COOKIE_NAME).toBe('__Host-csrf');
  });

  it('is NOT HttpOnly — the page has to read it to echo it', () => {
    // The one difference from the session cookie, and the mechanism rather than
    // an oversight. A cookie script cannot read cannot be echoed into a header.
    expect(cookie).not.toContain('HttpOnly');
  });

  it('keeps every other attribute of the session cookie', () => {
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; SameSite=Lax');
    expect(cookie).toContain('; Path=/');
    expect(cookie).not.toContain('Domain');
  });

  it('carries Max-Age when asked and none when not', () => {
    expect(cookie).toContain('; Max-Age=2592000');
    expect(serialiseCsrfCookie({ value: 'abc123', maxAgeSeconds: null })).not.toContain('Max-Age');
  });

  it('refuses a value a cookie may not carry, like its sibling', () => {
    expect(() => serialiseCsrfCookie({ value: 'a b', maxAgeSeconds: null })).toThrow(
      /cookie value/i,
    );
  });

  it('clears with every attribute repeated', () => {
    const cleared = clearedCsrfCookie();
    expect(cleared.startsWith('__Host-csrf=;')).toBe(true);
    expect(cleared).toContain('; Max-Age=0');
    expect(cleared).toContain('; Path=/');
    expect(cleared).not.toContain('HttpOnly');
  });
});
