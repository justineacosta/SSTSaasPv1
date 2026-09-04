import { ERROR_CODES } from '@sentinel/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import {
  DEFAULT_POST_LOGIN_PATH,
  isSessionExpiry,
  loginHrefForDestination,
  REDIRECT_PARAM,
  safeRedirectPath,
} from './redirect';

/**
 * The rejection cases are the point of this file. A validator that only ever
 * sees `/dashboard` has proven nothing about the input it exists to refuse.
 *
 * The three input classes live at module scope so that the class-wide
 * invariant near the bottom can iterate **all** of them. It previously
 * iterated the rejected table alone, which is the same 19 values the 19 tests
 * above it already assert individually — a tautology that could not fail, and
 * which was green throughout the open redirect recorded as H1 in `review.md`.
 */

/** Inputs the validator accepts, with the exact value it must return. */
const accepted: readonly [string, string, string][] = [
  ['a plain same-origin path', '/assets', '/assets'],
  [
    'a path with a query string and a fragment',
    '/findings?severity=high#top',
    '/findings?severity=high#top',
  ],
  ['a nested path', '/projects/prj_123/settings', '/projects/prj_123/settings'],
  [
    'a percent-encoded segment, which stays same-origin under the URL parser',
    '/search?q=a%20b',
    '/search?q=a%20b',
  ],
];

/**
 * Inputs whose **resolved** form is a foreign origin even though their input
 * form passes every shape guard. The URL parser removes dot segments while
 * resolving, and that removal can manufacture a leading `//` which appeared
 * nowhere in the string the guards inspected.
 *
 * This is the class H1 was: nothing anywhere in the task tested it, and the
 * function returned `//evil.example` for the first entry below. It is a
 * separate table from `rejected` because these are not refused on sight — they
 * are refused by the check `safeRedirectPath` applies to the value it is about
 * to return. Blacklisting the spellings would be the losing game; there is
 * always another one, and the last two entries exist to say so.
 */
const normalisedToForeignOrigin: readonly [string, string][] = [
  ['a dot segment climbing into a protocol-relative URL', '/..//evil.example'],
  ['a dot segment climbing back out of a real path', '/a/..//evil.example'],
  ['a single-dot segment before a double slash', '/.//evil.example'],
  ['a percent-encoded dot segment', '/%2e%2e//evil.example'],
  ['a dot segment carrying a query string', '/..//evil.example?x=1'],
  ['a dot segment carrying a fragment', '/..//evil.example#top'],
  ['a dot segment before a triple slash', '/..///evil.example'],
  ['two dot segments', '/../..//evil.example'],
  ['a dot segment smuggling credentials', '/..//user:pass@evil.example'],
  ['a dot segment reached through a trailing slash', '/a/./..//evil.example'],
];

describe('safeRedirectPath — accepts', () => {
  for (const [label, value, expected] of accepted) {
    it(label, () => {
      expect(safeRedirectPath(value)).toBe(expected);
    });
  }
});

const rejected: readonly [string, string][] = [
  ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/login'],
    ['a triple slash', '///evil.example'],
    ['an absolute https URL', 'https://evil.example/login'],
    ['an absolute http URL', 'http://evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a backslash escape browsers normalise to //', '/\\evil.example'],
    ['a double backslash', '\\\\evil.example'],
    ['a backslash anywhere in the path', '/assets\\..\\..'],
    ['a bare relative path with no leading slash', 'dashboard'],
    ['a scheme-relative-looking bare host', 'evil.example/login'],
    ['a path with a leading newline browsers would strip', '\n//evil.example'],
    ['a path with a leading tab', '\t//evil.example'],
    ['a path containing a NUL', '/assets' + String.fromCharCode(0)],
    ['a path containing a DEL', '/assets' + String.fromCharCode(127)],
    ['a path containing a carriage return', '/assets\r\n/other'],
  ['a path with a leading space', ' /assets'],
  ['the empty string', ''],
];

/**
 * Every input this file names, in one list, so the invariant below is stated
 * over the whole known space rather than over one table of it.
 */
const everyInput: readonly string[] = [
  ...accepted.map(([, value]) => value),
  ...rejected.map(([, value]) => value),
  ...normalisedToForeignOrigin.map(([, value]) => value),
];

describe('safeRedirectPath — refuses, falling back', () => {
  for (const [label, value] of rejected) {
    it(`refuses ${label}`, () => {
      expect(safeRedirectPath(value)).toBe(DEFAULT_POST_LOGIN_PATH);
    });
  }

  it('refuses null and undefined', () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('returns the caller-supplied fallback rather than always /dashboard', () => {
    expect(safeRedirectPath('https://evil.example', '/login')).toBe('/login');
  });
});

/**
 * H1. The input passes every shape guard; the *returned* value is what carries
 * the foreign origin, because the URL parser normalised it on the way through.
 */
describe('safeRedirectPath — refuses what normalisation would turn into a foreign origin', () => {
  for (const [label, value] of normalisedToForeignOrigin) {
    it(`refuses ${label}`, () => {
      expect(safeRedirectPath(value)).toBe(DEFAULT_POST_LOGIN_PATH);
    });
  }

  it('refuses them with the caller-supplied fallback too', () => {
    expect(safeRedirectPath('/..//evil.example', '/login')).toBe('/login');
    expect(safeRedirectPath('/..//evil.example', '')).toBe('');
  });
});

/**
 * The invariant, and the reason this file exists. It is stated over every
 * input above — accepted, rejected and normalising — because the property is
 * about **every value the function returns**, not about the values it was
 * already known to refuse.
 */
describe('safeRedirectPath — the class-wide invariant', () => {
  it('covers all three input tables', () => {
    expect(everyInput.length).toBe(accepted.length + rejected.length + normalisedToForeignOrigin.length);
    expect(everyInput.length).toBeGreaterThanOrEqual(30);
  });

  it('returns a same-origin path for every input, whatever its class', () => {
    for (const value of everyInput) {
      const result = safeRedirectPath(value);
      const where = `input ${JSON.stringify(value)} returned ${JSON.stringify(result)}`;
      expect(result.startsWith('/'), where).toBe(true);
      expect(result.startsWith('//'), where).toBe(false);
      expect(result, where).not.toContain('evil.example');
    }
  });

  it('holds for the caller-supplied fallback form as well', () => {
    for (const value of everyInput) {
      const result = safeRedirectPath(value, '/login');
      const where = `input ${JSON.stringify(value)} returned ${JSON.stringify(result)}`;
      expect(result.startsWith('/'), where).toBe(true);
      expect(result.startsWith('//'), where).toBe(false);
      expect(result, where).not.toContain('evil.example');
    }
  });

  it('cannot be composed into a foreign origin through loginHrefForDestination', () => {
    for (const value of everyInput) {
      const href = loginHrefForDestination(value);
      const where = `input ${JSON.stringify(value)} produced ${JSON.stringify(href)}`;
      expect(href.startsWith('/login'), where).toBe(true);
      expect(href, where).not.toContain('evil.example');

      if (href !== '/login') {
        const decoded = decodeURIComponent(href.slice(`/login?${REDIRECT_PARAM}=`.length));
        expect(decoded.startsWith('/'), where).toBe(true);
        expect(decoded.startsWith('//'), where).toBe(false);
      }
    }
  });
});

describe('loginHrefForDestination', () => {
  it('encodes a safe destination into the next parameter', () => {
    expect(loginHrefForDestination('/findings?severity=high')).toBe(
      '/login?next=%2Ffindings%3Fseverity%3Dhigh',
    );
  });

  it('drops an unsafe destination instead of propagating it', () => {
    expect(loginHrefForDestination('https://evil.example')).toBe('/login');
    expect(loginHrefForDestination('//evil.example')).toBe('/login');
  });

  it('drops a destination that only becomes foreign under normalisation', () => {
    expect(loginHrefForDestination('/..//evil.example')).toBe('/login');
    expect(loginHrefForDestination('/a/..//evil.example')).toBe('/login');
    expect(loginHrefForDestination('/%2e%2e//evil.example')).toBe('/login');
  });

  it('is /login when there is no destination', () => {
    expect(loginHrefForDestination(null)).toBe('/login');
    expect(loginHrefForDestination('')).toBe('/login');
  });

  it('round-trips: what it encodes, safeRedirectPath accepts unchanged', () => {
    const href = loginHrefForDestination('/projects/prj_1/settings?tab=scope');
    const encoded = href.slice('/login?next='.length);
    expect(safeRedirectPath(decodeURIComponent(encoded))).toBe(
      '/projects/prj_1/settings?tab=scope',
    );
  });
});

describe('isSessionExpiry', () => {
  const apiError = (code: string): ApiError =>
    new ApiError({ kind: 'api', status: 401, code, message: 'no', requestId: 'req_1' });

  it('is true for the two codes that mean "sign in again"', () => {
    expect(isSessionExpiry(apiError(ERROR_CODES.SESSION_EXPIRED))).toBe(true);
    expect(isSessionExpiry(apiError(ERROR_CODES.UNAUTHENTICATED))).toBe(true);
  });

  it('is false for a different auth failure', () => {
    expect(isSessionExpiry(apiError(ERROR_CODES.INVALID_CREDENTIALS))).toBe(false);
    expect(isSessionExpiry(apiError(ERROR_CODES.MFA_INVALID))).toBe(false);
    expect(isSessionExpiry(apiError(ERROR_CODES.PERMISSION_DENIED))).toBe(false);
  });

  it('is false for anything that is not an ApiError', () => {
    expect(isSessionExpiry(new Error('boom'))).toBe(false);
    expect(isSessionExpiry(null)).toBe(false);
    expect(isSessionExpiry({ code: ERROR_CODES.SESSION_EXPIRED })).toBe(false);
  });
});
