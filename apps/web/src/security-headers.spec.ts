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
  // ADR-0017 has the browser call the API cross-origin. `connect-src 'self'`
  // forbids that, so Task 16 widened the directive by exactly one origin. These
  // four assertions pin both the widening and its narrowness — a wildcard, a
  // scheme-only source, or a second origin sneaking in would fail here.
  describe('connect-src and the cross-origin API', () => {
    it("is 'self' alone when no API origin is supplied", () => {
      const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
      expect(csp.split('; ')).toContain("connect-src 'self'");
    });

    it('names the API origin exactly once when one is supplied', () => {
      const csp =
        buildSecurityHeaders('abc123', true, 'http://localhost:3001')['Content-Security-Policy'] ??
        '';
      expect(csp.split('; ')).toContain("connect-src 'self' http://localhost:3001");
    });

    it('never emits a wildcard or a scheme-only source in connect-src', () => {
      const csp =
        buildSecurityHeaders('abc123', true, 'https://api.sentinel.example')[
          'Content-Security-Policy'
        ] ?? '';
      const directive = csp.split('; ').find((entry) => entry.startsWith('connect-src'));
      expect(directive).toBe("connect-src 'self' https://api.sentinel.example");
      expect(directive).not.toContain('*');
      expect(directive).not.toContain('https:;');
    });

    it('widens connect-src and nothing else', () => {
      const narrow = (buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '').split(
        '; ',
      );
      const widened = (
        buildSecurityHeaders('abc123', true, 'https://api.sentinel.example')[
          'Content-Security-Policy'
        ] ?? ''
      ).split('; ');
      expect(widened.length).toBe(narrow.length);
      const differing = widened.filter((entry, index) => entry !== narrow[index]);
      expect(differing).toEqual(["connect-src 'self' https://api.sentinel.example"]);
    });
  });

  /**
   * L1. The three tests above supply well-formed origins and then assert
   * properties of the values they chose; none of them is a property of the
   * function. Today's only caller passes `new URL(env.API_BASE_URL).origin`,
   * which is correct — and that correctness lives at the call site, one
   * careless second call site away from being wrong.
   *
   * So the parameter is reduced to an origin *inside* the function, and these
   * assert that reduction rather than the caller's manners.
   */
  describe('connect-src — the API origin is normalised inside the function', () => {
    const connectSrc = (apiOrigin: string): string | undefined =>
      (buildSecurityHeaders('abc123', true, apiOrigin)['Content-Security-Policy'] ?? '')
        .split('; ')
        .find((entry) => entry.startsWith('connect-src'));

    const narrowPolicy = (): string[] =>
      (buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '').split('; ');

    /** Well-formed inputs, and the single origin each must be reduced to. */
    const reduced: readonly [string, string, string][] = [
      ['an origin already in origin form', 'https://api.sentinel.example', 'https://api.sentinel.example'],
      ['a trailing slash', 'http://localhost:3001/', 'http://localhost:3001'],
      ['a path', 'https://api.sentinel.example/v1/auth', 'https://api.sentinel.example'],
      [
        'a query string and a fragment',
        'https://api.sentinel.example/v1?a=b#c',
        'https://api.sentinel.example',
      ],
      [
        'credentials, which an origin does not carry',
        'https://user:pass@api.sentinel.example',
        'https://api.sentinel.example',
      ],
      ['the scheme default port', 'https://api.sentinel.example:443', 'https://api.sentinel.example'],
      ['a non-default port, which is part of the origin', 'https://api.sentinel.example:8443', 'https://api.sentinel.example:8443'],
    ];

    for (const [label, input, origin] of reduced) {
      it(`reduces ${label} to one origin`, () => {
        expect(connectSrc(input)).toBe(`connect-src 'self' ${origin}`);
      });
    }

    /**
     * Values a second call site could plausibly pass. Each must leave the
     * directive exactly as narrow as it is with no API origin at all — the
     * source is *omitted*, not emitted raw. `https://*` and
     * `javascript:alert(1)` are in the list because both survive `new URL`:
     * the first parses to the origin `https://*`, the second to the opaque
     * origin `null`. Parsing alone is not the check.
     */
    const refused: readonly [string, string][] = [
      ['a bare wildcard', '*'],
      ['a wildcard host', 'https://*'],
      ['a wildcard subdomain', 'https://*.sentinel.example'],
      ['a scheme-only source', 'https:'],
      ['a CSP source list', "'self' data:"],
      ['the keyword self', "'self'"],
      ['a second origin smuggled in by a space', 'https://api.example https://evil.example'],
      ['a second directive smuggled in by a semicolon', 'https://api.example; script-src *'],
      ['a bare host with no scheme', 'api.sentinel.example'],
      ['a protocol-relative URL', '//evil.example'],
      ['a javascript: URL, whose origin parses as the opaque "null"', 'javascript:alert(1)'],
      ['a data: URL, likewise opaque', 'data:text/html,<script>alert(1)</script>'],
      ['a path with no origin at all', '/api'],
      ['the empty string', ''],
      ['whitespace', '   '],
    ];

    for (const [label, input] of refused) {
      it(`omits the source for ${label}`, () => {
        expect(connectSrc(input)).toBe("connect-src 'self'");
      });
    }

    it('emits no wildcard, no scheme-only source and no second source, for any of them', () => {
      for (const [, input] of refused) {
        const directive = connectSrc(input) ?? '';
        const where = `input ${JSON.stringify(input)} produced ${JSON.stringify(directive)}`;
        expect(directive, where).not.toContain('*');
        expect(directive, where).not.toContain('evil.example');
        expect(directive.split(' ').length, where).toBe(2);
      }
    });

    it('leaves every other directive untouched whatever it is given', () => {
      const narrow = narrowPolicy();
      for (const [, input] of [...reduced.map(([l, i]) => [l, i] as const), ...refused]) {
        const policy = (
          buildSecurityHeaders('abc123', true, input)['Content-Security-Policy'] ?? ''
        ).split('; ');
        const where = `input ${JSON.stringify(input)}`;
        expect(policy.length, where).toBe(narrow.length);
        const differing = policy.filter((entry, index) => entry !== narrow[index]);
        expect(differing.length, where).toBeLessThanOrEqual(1);
        for (const entry of differing) {
          expect(entry.startsWith("connect-src 'self' "), where).toBe(true);
        }
      }
    });
  });
});
