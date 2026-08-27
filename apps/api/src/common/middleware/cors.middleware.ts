import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The methods a browser may use cross-origin, enumerated.
 *
 * ADR-0017 says "enumerated methods", and enumeration is the point: a wildcard
 * is not available with credentials anyway, and a list is a thing a reader can
 * check against the API's actual surface.
 */
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * The request headers a browser may send cross-origin, enumerated.
 *
 * `Content-Type` for JSON bodies, `X-CSRF-Token` for §4's double-submit, and
 * `X-Request-Id` because `RequestIdMiddleware` accepts a client-supplied
 * correlation ID and a client that cannot send the header cannot supply one.
 *
 * **`Authorization` is deliberately absent.** API keys are the machine
 * credential (`api/authentication.md` §1) — CI, integrations, scripts — none of
 * which is a browser subject to CORS, and Phase 2 issues no API keys at all.
 * Listing it now would widen the browser-reachable surface for a credential
 * type nothing can yet obtain. Adding it when that path exists is one entry in
 * this list, which is exactly the property ADR-0017 wants of an allowlist.
 */
const ALLOWED_HEADERS = 'Content-Type, X-CSRF-Token, X-Request-Id';

/**
 * The response headers a page may read.
 *
 * Without this a cross-origin caller sees only the CORS-safelisted response
 * headers, so `X-Request-Id` — the one identifier that ties a user's failed
 * request to a log line — would be invisible to the frontend, and the
 * `RateLimit-*` family that `abuse-prevention.md` §1's contract publishes would
 * be unreadable by the client meant to obey them.
 */
const EXPOSED_HEADERS =
  'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After';

/** Ten minutes. Chromium caps preflight caching well below this; Firefox lower still. */
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * CORS, PER ADR-0017: ONE CONFIGURED ORIGIN, COMPARED EXACTLY, NEVER REFLECTED.
 *
 * Hand-written rather than `app.enableCors()` for one reason that matters and
 * one that follows from it. The `cors` package given a string origin sets
 * `Access-Control-Allow-Origin` on **every** response, including responses to
 * requests from origins that are not allowed; given a callback returning
 * `true`, it echoes the *request's* `Origin` string back. ADR-0017 requires
 * that an origin which is not on the list receives **no** such header at all,
 * and that the value emitted is never the request's own string. Thirty lines
 * here says exactly that, with no configuration surface to get wrong.
 *
 * **The value written is the configured one, not the matched request header.**
 * They are byte-equal at that point — the comparison is `===` — so this is
 * belt-and-braces rather than a behaviour difference. It is written this way so
 * that no future edit can turn "compare then echo" into "echo", which is one
 * character of difference and the single most common way this control is built
 * wrong (ADR-0017, Decision).
 *
 * **`Vary: Origin` is set on every response, allowed or not.** The response
 * body for the same URL now differs by request header, and a shared cache that
 * does not know it can hand an allowed origin's response — CORS headers
 * included — to a different origin. Setting it only on the allowed branch is
 * the subtle version of the same bug.
 *
 * **A preflight is answered here and goes no further.** It carries no
 * credentials and identifies no user, so it must not reach the rate limiter
 * (which would charge a real request's budget to a browser's bookkeeping) or
 * the authentication guard (which would 401 it, and a 401 preflight fails the
 * actual request with a CORS error that names nothing). Being middleware rather
 * than a guard is what puts it ahead of both.
 *
 * **CORS is not the authorization control** (ADR-0017, Decision). It constrains
 * what a *browser* lets a page do with a response; `curl`, a server and a
 * scanner ignore it entirely. Every route still declares its access and every
 * unsafe cookie-authenticated request still carries the CSRF token.
 */
@Injectable()
export class CorsMiddleware implements NestMiddleware {
  constructor(private readonly allowedOrigin: string) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // Appended rather than assigned: `Cache-Control: no-store` aside, another
    // stage may already have varied on something, and clobbering it would be a
    // caching bug introduced by a security header.
    const existing = response.getHeader('Vary');
    const vary = typeof existing === 'string' && existing !== '' ? `${existing}, Origin` : 'Origin';
    response.setHeader('Vary', vary);

    const origin = request.headers.origin;
    const allowed = typeof origin === 'string' && origin === this.allowedOrigin;

    if (allowed) {
      response.setHeader('Access-Control-Allow-Origin', this.allowedOrigin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    }

    // A preflight is an OPTIONS carrying `Access-Control-Request-Method`. An
    // OPTIONS without it is an ordinary request and is left to the router.
    if (
      request.method.toUpperCase() !== 'OPTIONS' ||
      request.headers['access-control-request-method'] === undefined
    ) {
      next();
      return;
    }

    if (allowed) {
      response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    }

    // 204 with no CORS headers for a disallowed origin, rather than a 403. The
    // browser blocks the real request either way — it is looking for the
    // headers, not at the status — and a distinct status would tell a scanner
    // which origins are on the list, one guess at a time.
    response.statusCode = 204;
    response.end();
  }
}
