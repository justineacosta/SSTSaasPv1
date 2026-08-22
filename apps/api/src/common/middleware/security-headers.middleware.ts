import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CSP_ENFORCE } from '../../infrastructure/tokens.js';

/**
 * Applies security/transport-and-headers.md §2 to every response, and §3's
 * nonce-based CSP.
 *
 * A note on why the API sends a CSP at all, since it serves JSON: the policy is
 * what stops a response that is somehow rendered as a document — a browser
 * navigated straight at an endpoint, a content-type confusion — from executing
 * anything. `object-src 'none'` and `frame-ancestors 'none'` cost nothing here
 * and close that case.
 *
 * `connect-src` is `'self'` rather than the example hosts listed in §3: those
 * name the *web* origin's API and Sentry endpoints and are placeholders in the
 * document. This origin is the API itself and initiates no browser connections.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  constructor(@Inject(CSP_ENFORCE) private readonly enforceCsp: boolean) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    // 128 bits from the CSPRNG, minted per request. A nonce reused across
    // responses is a nonce an attacker can read from one page and reuse on the
    // next, which is the same as having no nonce at all.
    const nonce = randomBytes(16).toString('base64');
    response.locals.cspNonce = nonce;

    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // The API serves nothing cacheable; every response may contain tenant data.
    response.setHeader('Cache-Control', 'no-store');
    response.removeHeader('X-Powered-By');

    const policy = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // Enforcing only. CSP Level 2 specifies that `upgrade-insecure-requests`
      // is ignored when delivered in a report-only policy, and Chromium logs a
      // console error saying so on every response — a permanent error in every
      // local dev session, which is how developers learn to ignore CSP errors.
      // Omitting it here costs no protection: it was never applied. The web
      // origin's `buildSecurityHeaders` makes the same call, and both specs
      // assert the two modes differ by this directive and nothing else.
      ...(this.enforceCsp ? ['upgrade-insecure-requests'] : []),
      // The collector arrives with the web app. Wired from day one because a
      // policy nobody monitors is decoration — transport-and-headers.md §3.
      'report-uri /api/v1/csp-report',
    ].join('; ');

    // operations/environments.md §4: report-only while iterating locally,
    // enforcing everywhere else. The flag is derived from APP_ENV once, in
    // infrastructure/config, so "everywhere else" cannot drift per call site.
    response.setHeader(
      this.enforceCsp ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      policy,
    );

    next();
  }
}
