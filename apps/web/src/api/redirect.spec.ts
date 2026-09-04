import { ERROR_CODES } from '@sentinel/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import {
  DEFAULT_POST_LOGIN_PATH,
  isSessionExpiry,
  loginHrefForDestination,
  safeRedirectPath,
} from './redirect';

/**
 * The rejection cases are the point of this file. A validator that only ever
 * sees `/dashboard` has proven nothing about the input it exists to refuse.
 */
describe('safeRedirectPath — accepts', () => {
  it('a plain same-origin path', () => {
    expect(safeRedirectPath('/assets')).toBe('/assets');
  });

  it('a path with a query string and a fragment', () => {
    expect(safeRedirectPath('/findings?severity=high#top')).toBe('/findings?severity=high#top');
  });

  it('a nested path', () => {
    expect(safeRedirectPath('/projects/prj_123/settings')).toBe('/projects/prj_123/settings');
  });

  it('a percent-encoded segment, which stays same-origin under the URL parser', () => {
    expect(safeRedirectPath('/search?q=a%20b')).toBe('/search?q=a%20b');
  });
});

describe('safeRedirectPath — refuses, falling back', () => {
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

  it('never returns a value carrying a foreign origin', () => {
    for (const [, value] of rejected) {
      const result = safeRedirectPath(value);
      expect(result.startsWith('/')).toBe(true);
      expect(result.startsWith('//')).toBe(false);
      expect(result).not.toContain('evil.example');
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
