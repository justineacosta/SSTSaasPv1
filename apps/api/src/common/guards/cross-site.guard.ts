import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import type { Request } from 'express';
import { REFUSE_CROSS_SITE_KEY } from '../decorators/cross-site.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import { CROSS_SITE } from './csrf.guard.js';

/**
 * The one browser origin this API answers, as a DI token.
 *
 * The value is `ApiEnv.WEB_BASE_URL`, which is also what `CorsMiddleware` is
 * constructed with in `app-setup.ts`. Taking it from the same configuration
 * rather than deriving a second answer is deliberate: two independently
 * computed "which origin is ours" values is exactly how an allowlist and a CSRF
 * check drift apart, and the one that drifts is always the one nobody is
 * looking at.
 */
export const WEB_ORIGIN = Symbol('WEB_ORIGIN');

/**
 * LOGIN CSRF, WHICH `CsrfGuard` DELIBERATELY DOES NOT COVER.
 *
 * # What this defends
 *
 * Login CSRF: an attacker submits a cross-site `POST /auth/login` carrying
 * **their own** credentials, so the victim's browser is silently signed in to
 * an account the attacker controls. Everything the victim does afterwards —
 * an asset they register, a scan they run, a report they read — accrues to that
 * account, which the attacker can then log in to and read. It is the mirror
 * image of ordinary CSRF and it is invisible to the victim, because nothing
 * about the page says whose account it is until they look.
 *
 * # Why it needs a mechanism of its own
 *
 * Carry-forward ruling 56. `CsrfGuard` skips `@Public()` routes, and that is
 * correct rather than a gap to close there: its expected value is derived from
 * the raw session cookie, which is `HttpOnly`, so a page sitting on the login
 * form cannot produce the header — and a caller arriving with a *stale* session
 * cookie would be refused with no way to recover, since the way out of a bad
 * cookie is the login page. A cross-site login `POST` also carries no session
 * cookie at all, so double-submit has nothing to bind to. There is no token to
 * compare here; what is left is the browser's own account of where the request
 * came from.
 *
 * # The rule, in order
 *
 * 1. `Sec-Fetch-Site: cross-site` -> refuse. The browser is telling us
 *    directly. The constant is `csrf.guard.ts`'s, imported rather than
 *    restated, so the two guards can never disagree about the string.
 * 2. An `Origin` header that is present and is not `WEB_ORIGIN` -> refuse.
 *    Compared exactly, never by prefix or suffix: `https://app.sentinel.test`
 *    and `https://app.sentinel.test.evil.example` differ only in a suffix, and
 *    a `startsWith` here is the same defect ADR-0017 spends thirty lines
 *    avoiding in `CorsMiddleware`.
 * 3. Neither header present -> allow.
 *
 * **The two arms are AND-ed.** A request that reports `cross-site` is refused
 * even when its `Origin` is ours, because a forged `Origin` must not be able to
 * re-open the arm the browser closed.
 *
 * # Why absence is allowed, and what that costs
 *
 * A non-browser client — `curl`, a CI script, an integration test in this
 * repository — sends neither header. What this control defends is a **browser**
 * being driven cross-site, and a browser sends at least one of them: `Origin`
 * is mandatory on a cross-origin request and on any `POST` in every current
 * browser, and `Sec-Fetch-Site` has been sent by Chromium and Firefox for
 * years. Refusing on absence would make the absent header the control, which
 * every non-browser caller would then fail, and it would buy nothing: an
 * attacker who can suppress both headers is not driving a browser and does not
 * need CSRF at all — they can send the request directly with the victim's
 * cookies absent, which is a request that authenticates nobody.
 *
 * That is the residual, stated rather than implied: a browser that sends
 * neither header is not protected by this. It is the same shape as
 * `security/authentication.md` §4's own note that `Origin` and `Sec-Fetch-Site`
 * are a secondary signal — here they are the *only* signal, because the primary
 * one is unavailable, and the routes that carry it are chosen accordingly.
 *
 * # One code and one message
 *
 * 403 `CSRF_TOKEN_INVALID` for every arm, for the reason `api/authentication.md`
 * §3 already gives about `CsrfGuard`: telling a caller which half they defeated
 * tells them what to fix. The code is shared with `CsrfGuard` on purpose — a
 * client that has to distinguish "your CSRF token was wrong" from "your origin
 * was wrong" is a client that has been told which control it is up against.
 */
@Injectable()
export class CrossSiteGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(WEB_ORIGIN) private readonly webOrigin: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    // **The handler only.** Carry-forward ruling 61, and see
    // `cross-site.decorator.ts` for why the direction being reversed here — a
    // class-level annotation would extend rather than exempt — does not change
    // the argument. `reflector.get` against `getHandler()` cannot be widened
    // into a prototype-chain walk the way `getAllAndOverride` can.
    if (this.reflector.get<true>(REFUSE_CROSS_SITE_KEY, context.getHandler()) !== true) return true;

    const request = context.switchToHttp().getRequest<Request>();

    if (request.headers['sec-fetch-site'] === CROSS_SITE) throw refused();

    const origin = request.headers.origin;
    // `!== undefined` rather than a truthiness check, so an empty `Origin`
    // header is compared rather than skipped.
    //
    // What this does NOT need is a branch for a repeated header. Node joins
    // repeated non-`Set-Cookie` headers into one comma-separated string
    // (ruling 57, measured), so two `Origin` headers arrive as `"<a>, <b>"` —
    // a string that is not the configured origin, and therefore refused by the
    // comparison itself rather than by a branch that would have to pick one.
    // An array form from a future adapter is likewise neither `undefined` nor
    // equal to the origin, so it too is refused. That is the same reasoning
    // `cookie-header.ts` uses to refuse two cookies of one name: an ambiguous
    // value is not a value to choose from.
    //
    // (L2: this comment previously quoted `typeof origin === 'string'`, which
    // is not what the line below says and never was. The behaviour argued for
    // was delivered anyway; the comment was describing code that was never
    // written.)
    if (origin !== undefined && origin !== this.webOrigin) throw refused();

    return true;
  }
}

function refused(): DomainError {
  // NO REASON PARAMETER, unlike `csrf.guard.ts`'s `invalid()`. There the
  // argument documents which of four comparisons failed for a reader of the
  // file; here there are two arms and both are named in the docblock, and a
  // parameter that is only ever `void`-ed is a parameter someone eventually
  // logs.
  return new DomainError(
    ERROR_CODES.CSRF_TOKEN_INVALID,
    'A valid CSRF token is required for this request.',
    403,
  );
}
