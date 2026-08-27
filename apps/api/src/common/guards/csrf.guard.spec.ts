import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import request from 'supertest';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { deriveCsrfToken } from '../../modules/auth/csrf-token.js';
import { mintSecretToken } from '../../modules/auth/secret-token.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { Public } from '../decorators/access.decorator.js';
import { CSRF_HEADER, CsrfGuard } from './csrf.guard.js';

/**
 * CSRF, PROVED ALONE.
 *
 * `CsrfGuard` is registered here without `AuthenticationGuard`, deliberately:
 * its rule is about the *presence* of an ambient credential and the method,
 * not about whether that credential resolves. Mixing the two would make every
 * failure ambiguous between 401 and 403, and the interaction between them is
 * asserted where it actually happens, in `app.module.spec.ts` (order) and the
 * integration spec (both guards, real application).
 */
const SESSION = mintSecretToken().token;
const OTHER_SESSION = mintSecretToken().token;
const VALID = deriveCsrfToken(SESSION);

@Controller('probe')
class ProbeController {
  @Public()
  @Get()
  read(): string {
    return 'ok';
  }

  @Public()
  @Post()
  create(): string {
    return 'ok';
  }

  @Public()
  @Put()
  replace(): string {
    return 'ok';
  }

  @Public()
  @Patch()
  amend(): string {
    return 'ok';
  }

  @Public()
  @Delete()
  destroy(): string {
    return 'ok';
  }
}

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildGuardedApp({
    controllers: [ProbeController],
    providers: [Reflector, { provide: APP_GUARD, useClass: CsrfGuard }],
  });
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

const withSession = (extra = ''): string =>
  `${SESSION_COOKIE_NAME}=${SESSION}${extra === '' ? '' : `; ${extra}`}`;

const codeOf = (body: unknown): string => errorEnvelopeSchema.parse(body).error.code;

describe('what is exempt', () => {
  it('a safe method, even carrying the session cookie', async () => {
    // §4 names the unsafe methods. A GET that required a token would break every
    // page load and teach the frontend to send one everywhere, which is how the
    // token ends up somewhere it can be read.
    await request(server).get('/api/v1/probe').set('Cookie', withSession()).expect(200);
  });

  it('an unsafe method with NO session cookie — no ambient credential to abuse', async () => {
    // §4's own reasoning for exempting bearer-authenticated requests, expressed
    // as the condition it actually rests on: a request the browser did not
    // attach a credential to has nothing for a cross-site page to ride.
    await request(server).post('/api/v1/probe').expect(201);
  });

  it('an unsafe method carrying a bearer token and no cookie', async () => {
    // `api/authentication.md` §3: bearer-authenticated requests are exempt.
    // Phase 2 issues no API keys, so this asserts the shape rather than a live
    // credential path — the guard exempts it because there is no cookie, which
    // is the property that will still be true when keys exist.
    await request(server)
      .post('/api/v1/probe')
      .set('Authorization', 'Bearer sk_not_a_real_key')
      .expect(201);
  });

  it('an unsafe method carrying only the CSRF cookie, not the session one', async () => {
    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', `${CSRF_COOKIE_NAME}=${VALID}`)
      .expect(201);
  });
});

describe('what is refused', () => {
  it.each([
    ['POST', (path: string) => request(server).post(path)],
    ['PUT', (path: string) => request(server).put(path)],
    ['PATCH', (path: string) => request(server).patch(path)],
    ['DELETE', (path: string) => request(server).delete(path)],
  ])('%s with a session cookie and no token', async (_method, send) => {
    const response = await send('/api/v1/probe').set('Cookie', withSession()).expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('a token belonging to a different session', async () => {
    // §4: "bound to the session, so a token minted for one session does not
    // validate another". This is that sentence as a test.
    const response = await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, deriveCsrfToken(OTHER_SESSION))
      .expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('a token of the wrong length, without a 500', async () => {
    // `crypto.timingSafeEqual` throws a RangeError on unequal lengths. A guard
    // that let that escape would answer 500 for a short token and 403 for a
    // wrong-but-right-length one, which is a length oracle wearing a stack
    // trace.
    for (const forged of ['x', 'x'.repeat(5_000), VALID.slice(0, 42)]) {
      const response = await request(server)
        .post('/api/v1/probe')
        .set('Cookie', withSession())
        .set(CSRF_HEADER, forged)
        .expect(403);
      expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
    }
  });

  it('a request whose Sec-Fetch-Site says cross-site, before the token is looked at', async () => {
    const response = await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, VALID)
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('a repeated X-CSRF-Token header, which Node joins into one comma-separated value', async () => {
    // MEASURED, not assumed: Node concatenates repeated non-`Set-Cookie` headers
    // into a single comma-separated string, so `request.headers['x-csrf-token']`
    // is `"<valid>, other"` here rather than an array. It is refused because
    // that string is not the derived token — the array branch in the guard is
    // for a proxy or framework that presents one, and is not what fires here.
    const response = await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, `${VALID}, other`)
      .expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('what is allowed', () => {
  it('the correct token for this session', async () => {
    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, VALID)
      .expect(201);
  });

  it('the same token presented alongside the CSRF cookie, as a browser sends it', async () => {
    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession(`${CSRF_COOKIE_NAME}=${VALID}`))
      .set(CSRF_HEADER, VALID)
      .expect(201);
  });

  it('a same-origin request carrying Sec-Fetch-Site', async () => {
    for (const value of ['same-origin', 'same-site', 'none']) {
      await request(server)
        .post('/api/v1/probe')
        .set('Cookie', withSession())
        .set(CSRF_HEADER, VALID)
        .set('Sec-Fetch-Site', value)
        .expect(201);
    }
  });

  it('a request with no Sec-Fetch-Site at all — the signal is not the control', async () => {
    // §4 calls Origin and Sec-Fetch-Site a secondary signal. Refusing on their
    // absence would make them the control, and would refuse every non-browser
    // client that legitimately holds a session cookie.
    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, VALID)
      .expect(201);
  });
});

describe('the cookie-injection attack that plain double-submit does not stop', () => {
  it('REFUSES a matching cookie-and-header pair the attacker chose', async () => {
    // THE TEST THIS DESIGN EXISTS FOR. Classic double-submit compares the header
    // to the cookie, so an attacker who can write a cookie into the victim's
    // browser writes both halves and they match. Here the header is compared
    // against the value DERIVED from the session token, which the attacker does
    // not have — so a self-consistent forged pair is refused.
    const forged = 'attacker-chosen-value';
    const response = await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession(`${CSRF_COOKIE_NAME}=${forged}`))
      .set(CSRF_HEADER, forged)
      .expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses a stale CSRF pair from before a rotation, and accepts the current one', async () => {
    // Rotation mints a new session token, so the derived token changes with it
    // and no separate rotation step can be forgotten.
    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession(`${CSRF_COOKIE_NAME}=${deriveCsrfToken(OTHER_SESSION)}`))
      .set(CSRF_HEADER, deriveCsrfToken(OTHER_SESSION))
      .expect(403);

    await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession(`${CSRF_COOKIE_NAME}=${VALID}`))
      .set(CSRF_HEADER, VALID)
      .expect(201);
  });

  it('never says which half was wrong', async () => {
    // One code and one message for every refusal. Telling a caller whether the
    // header was missing, malformed or simply wrong tells an attacker which half
    // of the control they have already defeated.
    const missing = await request(server).post('/api/v1/probe').set('Cookie', withSession());
    const wrong = await request(server)
      .post('/api/v1/probe')
      .set('Cookie', withSession())
      .set(CSRF_HEADER, deriveCsrfToken(OTHER_SESSION));

    const body = (value: unknown): { code: string; message: string } => {
      const parsed = errorEnvelopeSchema.parse(value).error;
      return { code: parsed.code, message: parsed.message };
    };
    expect(body(missing.body)).toEqual(body(wrong.body));
  });
});
