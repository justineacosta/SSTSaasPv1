import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { ACCESS_METADATA_KEY, type AccessDeclaration } from '../decorators/access.decorator.js';
import { csrfTokenMatches } from '../../modules/auth/csrf-token.js';
import { DomainError } from '../errors/domain-error.js';
import { readCookie } from '../http/cookie-header.js';

/** The header the page echoes the CSRF cookie in. `api/authentication.md` §3. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The methods this guard does not examine.
 *
 * RFC 9110's safe methods, and the set `security/authentication.md` §4 and
 * `api/authentication.md` §3 both name by their complement
 * (`POST`/`PUT`/`PATCH`/`DELETE`). Written as the *exempt* list rather than the
 * guarded one on purpose: a method added to HTTP, or to this application, is
 * then guarded by default rather than unguarded by omission.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Cross-site requests that arrive with `Sec-Fetch-Site` set to this are refused
 * before the token is even looked at.
 *
 * `same-origin` and `same-site` are fine, `none` is a user typing a URL or a
 * bookmark, and `cross-site` is the shape of the attack. Absent means an older
 * browser or a non-browser client, and is not refused — see the guard's
 * docblock for why this is a *signal* and not the control.
 *
 * Exported since Task 9 so `CrossSiteGuard` can refuse on the same header value
 * without restating the string. There it is the control rather than a signal,
 * because the token comparison below is unavailable on a public route — but it
 * must be the *same* string, and two literals is how that stops being true.
 */
export const CROSS_SITE = 'cross-site';

function invalid(reason: string): DomainError {
  // ONE CODE AND ONE MESSAGE FOR EVERY REFUSAL. The `reason` is for the
  // docblock's reader, not for the response: telling a caller whether the
  // header was missing, malformed, or simply wrong tells an attacker which half
  // of the double-submit they have already defeated.
  void reason;
  return new DomainError(
    ERROR_CODES.CSRF_TOKEN_INVALID,
    'A valid CSRF token is required for this request.',
    403,
  );
}

/**
 * STAGE SIX OF `architecture/backend.md` §3 — DOUBLE-SUBMIT, BOUND TO THE
 * SESSION.
 *
 * `security/authentication.md` §4: `SameSite=Lax` is the baseline, not the
 * control. Lax already withholds the session cookie from a cross-site `POST`,
 * and that is genuinely most of the defence — but it is a property of the
 * user's browser, not of this server. It does not hold for a browser that
 * predates it, for a user who has relaxed it, for a `<form>` navigation in the
 * cases browsers still allow, or for any client that is not a browser at all.
 * **The double-submit token below is what actually holds**, and ADR-0017's
 * Consequences section depends on that being true: the cross-origin design it
 * accepts rules `SameSite=Strict` out, so `Lax` plus this token is doing the
 * work `Strict` would otherwise contribute to.
 *
 * **`Origin` and `Sec-Fetch-Site` are a secondary signal, and this comment is
 * load-bearing.** §4 names them as secondary. They refuse an obviously
 * cross-site request early and cheaply, and they are trivially absent from a
 * non-browser client, so **nothing may be deleted on the grounds that they
 * cover it**. A future reader who removes the token comparison because "we
 * check the Origin anyway" has removed the control and kept the hint.
 *
 * **What "authenticated by cookie" means here.** The guard applies when the
 * request carries the session cookie — the ambient credential a cross-site
 * request would be abusing. A bearer-authenticated request carries no ambient
 * credential and is exempt, which is §4's own reasoning and
 * `api/authentication.md` §3's wording. A request with no session cookie has
 * nothing to abuse either.
 *
 * **A `@Public()` route is skipped entirely, exactly as `AuthenticationGuard`
 * skips one.** That guard's reason applies here word for word: a browser
 * attaches whatever session cookie it has, unasked, and a public route that
 * could refuse because of one is a route nobody can recover from — the way out
 * of a bad cookie is the login page, and the login page is public. Without this
 * the 401 door was closed and a 403 door stood open on the same route for the
 * same input, **with no client-side remedy**: the expected header is derived
 * from the raw session cookie, which is `HttpOnly`, so a page holding a stale
 * `__Host-csrf` cannot produce it. The consequence is that **login CSRF is not
 * covered by this control at all** — neither the absent-cookie case nor the
 * stale-cookie one — and Task 9, which builds the login endpoint, owns its own
 * mechanism for it. `security/authentication.md` §4 records that.
 *
 * **The comparison is against the value DERIVED from the session token, not
 * against the CSRF cookie.** This is a deliberate strengthening of plain
 * double-submit and it is stated because the plain form is what §4 describes.
 * Comparing the header to the cookie compares two values an attacker who can
 * write cookies controls *both* of — the well-known cookie-injection weakness
 * of double-submit. Comparing the header to `deriveCsrfToken(sessionToken)`
 * trusts neither: only a party who already holds the `HttpOnly` session cookie
 * can produce a header that matches. In the honest case the two are the same
 * string, because the cookie is issued as that derived value.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Read the same way `AuthenticationGuard` reads it, from the same key, so
    // the two guards can never disagree about which routes are public.
    if (access?.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<Request>();
    // `.toUpperCase()` is unreachable on current input and kept as depth: Node's
    // own parser rejects a lowercase method before Express sees it — measured by
    // the Task 7 reviewer over a raw socket, `post / HTTP/1.1` answers
    // `HTTP/1.1 400 Bad Request`. It costs nothing and removes a class of
    // question about what reaches this line.
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    // No ambient credential, nothing for a cross-site request to abuse. This is
    // also what exempts a bearer-authenticated request without this guard
    // having to know anything about API keys, which Phase 2 does not issue.
    const sessionToken = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (sessionToken === undefined) return true;

    // The secondary signal, checked first because it is free. Absent is not
    // refused: `Sec-Fetch-Site` is a browser header and a legitimate script or
    // integration will not send it, and refusing on absence would make this the
    // control rather than the signal.
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite === CROSS_SITE) throw invalid('sec-fetch-site: cross-site');

    const presented = request.headers[CSRF_HEADER];
    // **Node joins repeated non-`Set-Cookie` headers into one comma-separated
    // string**, measured against this guard through supertest, so two
    // `X-CSRF-Token` headers arrive here as `"<a>, <b>"` and are refused by the
    // comparison below rather than by this branch. The branch is for the array
    // form a proxy or a future framework may present: an array is not a value
    // to pick one of, for the same reason two cookies of one name are not (see
    // `cookie-header.ts`).
    if (typeof presented !== 'string') throw invalid('header missing or non-string');

    if (!csrfTokenMatches(presented, sessionToken)) throw invalid('token mismatch');
    return true;
  }
}
