import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers.js';

describe('buildSecurityHeaders', () => {
  it('emits a CSP carrying the supplied nonce', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Content-Security-Policy']).toContain("'nonce-abc123'");
  });

  it('never allows unsafe-inline or unsafe-eval', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('sets frame-ancestors none and object-src none', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('restricts fonts to self, which is what next/font self-hosting buys', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("font-src 'self'");
  });

  it('reports rather than enforces when enforcement is off', () => {
    const headers = buildSecurityHeaders('abc123', false);
    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeDefined();
  });

  it('sets the full header table from transport-and-headers.md §2', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  // Divergence from apps/api's SecurityHeadersMiddleware, asserted rather than
  // only commented: the API sets `Cache-Control: no-store` on every response
  // because it serves nothing cacheable. This table is applied to every
  // response on the web origin including `/_next/static/**`, which is served
  // `public, max-age=31536000, immutable`; a blanket `no-store` would discard
  // that. Next already sends `no-store` on the HTML. See security-headers.ts.
  it('does not blanket-disable caching on the web origin', () => {
    expect(buildSecurityHeaders('abc123', true)['Cache-Control']).toBeUndefined();
  });

  // The collector this points at is this origin's own app/api/csp-report
  // route, not the API's /api/v1/csp-report — which, per
  // transport-and-headers.md §3, still does not exist.
  it('points report-uri at this origin collector', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain('report-uri /api/csp-report');
  });

  // `upgrade-insecure-requests` is ignored by spec when it arrives in a
  // report-only policy, and Chromium logs a console error saying so — which is
  // how a developer learns to ignore CSP console errors. Omitting it when
  // report-only loses no protection, because it was never applied.
  it('sends upgrade-insecure-requests when enforcing', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp.split('; ')).toContain('upgrade-insecure-requests');
  });

  it('omits upgrade-insecure-requests when report-only, where it would be ignored', () => {
    const csp = buildSecurityHeaders('abc123', false)['Content-Security-Policy-Report-Only'] ?? '';
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  // Asserted as a whole-list comparison rather than by eye: the two policies
  // must differ by that one directive and nothing else, so a directive added
  // to one mode and not the other fails here rather than in production.
  it('is otherwise byte-identical between enforcing and report-only', () => {
    const enforced = (buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '').split(
      '; ',
    );
    const reported = (
      buildSecurityHeaders('abc123', false)['Content-Security-Policy-Report-Only'] ?? ''
    ).split('; ');

    expect(reported).toEqual(
      enforced.filter((directive) => directive !== 'upgrade-insecure-requests'),
    );
  });
});
