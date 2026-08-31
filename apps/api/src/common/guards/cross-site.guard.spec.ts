import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Controller, Post, SetMetadata } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import request from 'supertest';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { Public } from '../decorators/access.decorator.js';
import { REFUSE_CROSS_SITE_KEY, RefuseCrossSite } from '../decorators/cross-site.decorator.js';
import { CrossSiteGuard, WEB_ORIGIN } from './cross-site.guard.js';

/**
 * LOGIN CSRF, PROVED ON A PUBLIC ROUTE THAT `CsrfGuard` DELIBERATELY SKIPS.
 *
 * Carry-forward ruling 56. `CsrfGuard` exempts `@Public()` routes, and correctly:
 * the expected double-submit value derives from the `HttpOnly` session cookie,
 * so a page arriving at the login form has no way to produce it and a public
 * route demanding it would refuse every caller with no client-side remedy. That
 * leaves login CSRF — an attacker silently signing a victim's browser into an
 * account the *attacker* controls, so the victim's subsequent activity accrues
 * to it — uncovered, and this guard is Task 9's answer to it.
 *
 * **The fixture controller has routes on BOTH sides of the branch.** Ruling 58:
 * the Task 7 CSRF suite could not see ruling 56's hole because every route in it
 * was `@Public()`, so a fix that exempted public routes would have made nineteen
 * tests vacuous rather than red. `/open` opts in and `/bare` does not, and the
 * `/bare` assertions are what prove this guard governs by decoration rather than
 * by accident of being registered.
 */

@Controller('open')
class OptedInController {
  @Public()
  @RefuseCrossSite()
  @Post()
  create(): string {
    return 'ok';
  }
}

/** The other side of the branch: public, unsafe, and NOT opted in. */
@Controller('bare')
class NotOptedInController {
  @Public()
  @Post()
  create(): string {
    return 'ok';
  }
}

/**
 * A class-level annotation, which must exempt and govern nothing.
 *
 * `access.decorator.ts`'s `AllowPendingMfa` docblock records what class-level
 * metadata did to the last exemption in this codebase, and ruling 61 records
 * that narrowing the decorator's TYPE is only half the control — the guard has
 * to read `getHandler()` and nothing else, and that has to be tested. This is
 * the mirror image: a class-level declaration must not *extend* the guard to a
 * handler that never opted in, because a reader who writes it at the class would
 * otherwise believe a route is covered when the coverage depends on where Nest
 * happens to look.
 */
@Controller('classlevel')
@SetMetadata(REFUSE_CROSS_SITE_KEY, true)
class ClassLevelController {
  @Public()
  @Post()
  create(): string {
    return 'ok';
  }
}

const ALLOWED_ORIGIN = 'https://app.sentinel.test';

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildGuardedApp({
    controllers: [OptedInController, NotOptedInController, ClassLevelController],
    providers: [
      Reflector,
      { provide: WEB_ORIGIN, useValue: ALLOWED_ORIGIN },
      { provide: APP_GUARD, useClass: CrossSiteGuard },
    ],
  });
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

describe('a route that opted in', () => {
  it('allows a request carrying neither Origin nor Sec-Fetch-Site', async () => {
    // The curl / CI-script / integration-test case, and the one this control
    // deliberately does not refuse: what it defends against is a *browser* being
    // driven cross-site, and a non-browser client sends neither header. Refusing
    // on absence would make an absent header the control, which every non-browser
    // caller in the world would then fail.
    await request(server).post('/api/v1/open').expect(201);
  });

  it('allows Sec-Fetch-Site: same-origin, same-site and none', async () => {
    // `none` is a user typing a URL or following a bookmark. `same-site` is a
    // sibling subdomain, which ADR-0017's single-origin CORS policy already
    // constrains elsewhere.
    for (const value of ['same-origin', 'same-site', 'none']) {
      await request(server).post('/api/v1/open').set('Sec-Fetch-Site', value).expect(201);
    }
  });

  it('refuses Sec-Fetch-Site: cross-site with 403 CSRF_TOKEN_INVALID', async () => {
    const response = await request(server)
      .post('/api/v1/open')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);

    const envelope = errorEnvelopeSchema.parse(response.body);
    expect(envelope.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('allows the configured web origin', async () => {
    await request(server).post('/api/v1/open').set('Origin', ALLOWED_ORIGIN).expect(201);
  });

  it('refuses any other Origin, including a lookalike and a null origin', async () => {
    // `null` is what a sandboxed iframe and some redirects send, and it is not
    // the configured origin, so it is refused like any other foreign value.
    for (const origin of [
      'https://app.sentinel.test.evil.example',
      'https://evil.example',
      'http://app.sentinel.test',
      `${ALLOWED_ORIGIN}/`,
      'null',
    ]) {
      const response = await request(server).post('/api/v1/open').set('Origin', origin).expect(403);
      expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
    }
  });

  it('gives one code and one message for every arm', async () => {
    // `api/authentication.md` §3's reason, applied here: telling a caller which
    // half they defeated tells them what to fix.
    const byOrigin = await request(server)
      .post('/api/v1/open')
      .set('Origin', 'https://evil.example');
    const byFetchSite = await request(server)
      .post('/api/v1/open')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(byOrigin.status).toBe(byFetchSite.status);
    expect(byOrigin.body).toEqual(byFetchSite.body);
  });

  it('refuses a cross-site Sec-Fetch-Site even when the Origin is the allowed one', async () => {
    // The two arms are AND-ed, not OR-ed. A browser that reports `cross-site`
    // while echoing our own origin is describing a request we do not want, and
    // reading the Origin as an override would let a forged header re-open the
    // arm the browser closed.
    await request(server)
      .post('/api/v1/open')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('does not examine safe methods it never receives, and refuses on the unsafe one it does', async () => {
    // The route is POST-only, so this asserts the guard does not somehow admit
    // a cross-site POST by falling through a method check it does not have.
    await request(server).post('/api/v1/open').set('Sec-Fetch-Site', 'cross-site').expect(403);
  });
});

describe('a route that did not opt in', () => {
  it('is governed by nothing, even cross-site', async () => {
    // The anti-vacuity half. If this guard applied to every route, every
    // assertion above would pass for a reason that has nothing to do with the
    // decorator, and Task 10 and Task 11 would inherit a control they could not
    // choose. It is also the honest statement of what ships: `register`,
    // `verify-email` and `resend-verification` are public unsafe routes and are
    // NOT opted in — see `auth.controller.ts` for why each is bounded by what it
    // does rather than by this guard.
    await request(server).post('/api/v1/bare').set('Sec-Fetch-Site', 'cross-site').expect(201);
    await request(server).post('/api/v1/bare').set('Origin', 'https://evil.example').expect(201);
  });
});

describe('a class-level annotation', () => {
  it('opts nothing in — the guard reads the handler and nothing else', async () => {
    // Ruling 61's mirror, and asserted the way that ruling says to assert it:
    // through a raw `@SetMetadata`, because narrowing the decorator's TYPE to
    // `MethodDecorator` is only half the control and a raw annotation is a
    // thing a person can write. `getAllAndOverride([handler, class])` would
    // have made this route covered, and this route is not.
    await request(server)
      .post('/api/v1/classlevel')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(201);
  });
});
