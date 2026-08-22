import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { SecurityHeadersMiddleware } from './security-headers.middleware.js';

function run(enforceCsp: boolean): {
  headers: Record<string, string>;
  removed: string[];
  nonce: unknown;
  nextCalled: boolean;
} {
  const headers: Record<string, string> = {};
  const removed: string[] = [];
  const locals: Record<string, unknown> = {};
  const response = {
    locals,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    removeHeader: (name: string) => {
      removed.push(name.toLowerCase());
    },
  } as unknown as Response;

  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  new SecurityHeadersMiddleware(enforceCsp).use({} as Request, response, next);
  return { headers, removed, nonce: locals.cspNonce, nextCalled };
}

describe('SecurityHeadersMiddleware', () => {
  // security/transport-and-headers.md §2, cell for cell.
  it.each([
    ['strict-transport-security', 'max-age=31536000; includeSubDomains; preload'],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['cross-origin-resource-policy', 'same-origin'],
    ['cross-origin-embedder-policy', 'require-corp'],
    ['cache-control', 'no-store'],
  ])('sets %s to the documented value', (header, value) => {
    expect(run(true).headers[header]).toBe(value);
  });

  it('removes X-Powered-By rather than relying on the framework not to set it', () => {
    expect(run(true).removed).toContain('x-powered-by');
  });

  it('enforces CSP outside development and only reports in development', () => {
    const enforcing = run(true).headers;
    expect(enforcing['content-security-policy']).toBeDefined();
    expect(enforcing['content-security-policy-report-only']).toBeUndefined();

    const reporting = run(false).headers;
    expect(reporting['content-security-policy-report-only']).toBeDefined();
    expect(reporting['content-security-policy']).toBeUndefined();
  });

  it('builds a nonce-based policy with no unsafe-inline and no unsafe-eval', () => {
    const csp = run(true).headers['content-security-policy'] ?? '';
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]{16,}'/);
    expect(csp).toMatch(/style-src [^;]*'nonce-[A-Za-z0-9+/=]{16,}'/);
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      'report-uri /api/v1/csp-report',
    ]) {
      expect(csp).toContain(directive);
    }
  });

  // `upgrade-insecure-requests` is ignored by spec when it arrives in a
  // report-only policy, and Chromium logs a console error saying so — which is
  // how a developer learns to ignore CSP console errors. Omitting it when
  // report-only loses no protection, because it was never applied.
  it('sends upgrade-insecure-requests when enforcing', () => {
    const csp = run(true).headers['content-security-policy'] ?? '';
    expect(csp.split('; ')).toContain('upgrade-insecure-requests');
  });

  it('omits upgrade-insecure-requests when report-only, where it would be ignored', () => {
    const csp = run(false).headers['content-security-policy-report-only'] ?? '';
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  // Asserted as a whole-list comparison rather than by eye: the two policies
  // must differ by that one directive and nothing else, so a directive added
  // to one mode and not the other fails here rather than in production. The
  // per-request nonce is normalised away first, since it is the one part that
  // is *supposed* to differ between two calls.
  it('is otherwise byte-identical between enforcing and report-only', () => {
    const directives = (enforceCsp: boolean): string[] => {
      const { headers, nonce } = run(enforceCsp);
      const csp =
        headers[enforceCsp ? 'content-security-policy' : 'content-security-policy-report-only'] ??
        '';
      return csp.replaceAll(String(nonce), 'NONCE').split('; ');
    };

    expect(directives(false)).toEqual(
      directives(true).filter((directive) => directive !== 'upgrade-insecure-requests'),
    );
  });

  it('exposes the nonce on response.locals so a renderer can use the same one', () => {
    const { nonce, headers } = run(true);
    expect(typeof nonce).toBe('string');
    expect(headers['content-security-policy']).toContain(`'nonce-${String(nonce)}'`);
  });

  it('mints a fresh nonce for every request', () => {
    const seen = new Set<unknown>();
    for (let i = 0; i < 25; i += 1) seen.add(run(true).nonce);
    expect(seen.size).toBe(25);
  });

  it('calls next', () => {
    expect(run(true).nextCalled).toBe(true);
  });
});
