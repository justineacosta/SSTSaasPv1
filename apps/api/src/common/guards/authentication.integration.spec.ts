import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type ApiEnv } from '@sentinel/config';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { newId } from '@sentinel/db';
import { type PostgresHarness, startPostgresHarness } from '@sentinel/db/testing';
import { type PrismaClient, createUnscopedPrismaClient } from '@sentinel/db/unscoped';
import { config as loadDotenv } from 'dotenv';
import request from 'supertest';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app-setup.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { deriveCsrfToken } from '../../modules/auth/csrf-token.js';
import { SessionService } from '../../modules/auth/session.service.js';
import { ENV, PRISMA } from '../../infrastructure/tokens.js';
import { AllowPendingMfa, AuthenticatedOnly, Public } from '../decorators/access.decorator.js';
import { CSRF_HEADER } from './csrf.guard.js';

/**
 * THE WHOLE PIPELINE, ON THE REAL APPLICATION.
 *
 * The unit specs prove each guard's rules against a stub. This proves the parts
 * only the assembled application can: that the guards are actually registered
 * and in which order, that CORS reaches every response including a preflight
 * and an error, and that a session issued by the real `SessionService` and then
 * revoked through it is refused by the guard on the very next request — the
 * Phase 2 exit criterion, observed at the HTTP boundary rather than at the
 * service.
 *
 * **Postgres comes from the Testcontainers harness, Redis from compose**, and
 * the `PRISMA` provider is overridden to point at it. Task 6 recorded why: CI
 * never applies migrations to the compose database, so a spec inserting into
 * `Session` against it passes locally and fails in CI with "relation does not
 * exist".
 *
 * The fixture controllers exist nowhere in the product. `pnpm check:openapi`
 * still reports four routes.
 */
loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });

@Controller({ path: 'fixture', version: '1' })
class FixtureController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('me')
  me(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Post('write')
  write(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @AllowPendingMfa()
  @Post('mfa')
  mfa(): { ok: true } {
    return { ok: true };
  }
}

let harness: PostgresHarness;
let prisma: PrismaClient;
let app: NestExpressApplication;
let server: Server;
let sessions: SessionService;
let allowedOrigin: string;

const userId = newId('usr');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = 'test';
  harness = await startPostgresHarness();
  prisma = createUnscopedPrismaClient(harness.ownerUrl);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [FixtureController],
  })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  server = app.getHttpServer() as Server;
  sessions = app.get(SessionService);
  allowedOrigin = app.get<ApiEnv>(ENV).WEB_BASE_URL;

  await prisma.user.create({ data: { id: userId, email: `guard-${userId}@example.test` } });
}, 180_000);

afterAll(async () => {
  // Ruling 33: by key, never FLUSHDB — the rate-limit specs share this Redis.
  const rows = await prisma.session.findMany({ select: { tokenHash: true } });
  if (rows.length > 0) {
    const redis = app.get<{ del: (...keys: string[]) => Promise<number> }>('SENTINEL_REDIS');
    await redis.del(...rows.map((row) => `session:v1:${row.tokenHash}`));
  }
  await app.close();
  await prisma.$disconnect();
  await harness.stop();
});

const codeOf = (body: unknown): string => errorEnvelopeSchema.parse(body).error.code;

async function issue(status: 'ACTIVE' | 'PENDING_MFA'): Promise<{ id: string; token: string }> {
  const issued = await sessions.issue({ userId, status });
  return { id: issued.session.id, token: issued.token };
}

const asCookie = (token: string): string => `${SESSION_COOKIE_NAME}=${token}`;

describe('a real session, through the real pipeline', () => {
  it('authenticates an @AuthenticatedOnly route', async () => {
    const session = await issue('ACTIVE');
    await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(session.token))
      .expect(200);
  });

  it('is refused with SESSION_EXPIRED on the VERY NEXT request after revocation', async () => {
    // The Phase 2 exit criterion, observed where a user would observe it. Task
    // 6 proved `resolve` refuses immediately; this proves the guard in front of
    // it does, on a request that went through the whole application.
    const session = await issue('ACTIVE');
    await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(session.token))
      .expect(200);

    expect(await sessions.revoke(session.id)).toBe(true);

    const response = await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(session.token))
      .expect(401);
    expect(codeOf(response.body)).toBe('SESSION_EXPIRED');
  });

  it('is refused after rotation, and the successor is accepted', async () => {
    // §3's session-fixation defence, at the HTTP boundary: the credential the
    // browser held before the privilege change cannot be used after it.
    const session = await issue('ACTIVE');
    await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(session.token))
      .expect(200);

    const rotated = await sessions.rotate({ sessionId: session.id, status: 'ACTIVE' });
    expect(rotated).not.toBeNull();

    const refused = await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(session.token))
      .expect(401);
    expect(codeOf(refused.body)).toBe('SESSION_EXPIRED');

    await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(rotated?.token ?? ''))
      .expect(200);
  });

  it('refuses a PENDING_MFA session everywhere except the route that allows it', async () => {
    const pending = await issue('PENDING_MFA');

    const refused = await request(server)
      .get('/api/v1/fixture/me')
      .set('Cookie', asCookie(pending.token))
      .expect(401);
    expect(codeOf(refused.body)).toBe('MFA_REQUIRED');

    await request(server)
      .post('/api/v1/fixture/mfa')
      .set('Cookie', asCookie(pending.token))
      .set(CSRF_HEADER, deriveCsrfToken(pending.token))
      .expect(201);
  });

  it('answers UNAUTHENTICATED with no cookie and leaves the public route open', async () => {
    const response = await request(server).get('/api/v1/fixture/me').expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
    await request(server).get('/api/v1/fixture/open').expect(200);
  });
});

describe('CSRF on the real application', () => {
  it('refuses an unsafe cookie-authenticated request with no token', async () => {
    const session = await issue('ACTIVE');
    const response = await request(server)
      .post('/api/v1/fixture/write')
      .set('Cookie', asCookie(session.token))
      .expect(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('accepts it with the token the session derives, sent as a browser would', async () => {
    const session = await issue('ACTIVE');
    const csrf = deriveCsrfToken(session.token);
    await request(server)
      .post('/api/v1/fixture/write')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .expect(201);
  });

  it('answers 401 and not 403 when the caller is not authenticated at all', async () => {
    // Guard order, observed. CSRF running first would tell an anonymous caller
    // that their CSRF token was wrong, which is true and useless.
    const response = await request(server)
      .post('/api/v1/fixture/write')
      .set('Cookie', `${SESSION_COOKIE_NAME}=never-issued`)
      .expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
  });
});

describe('CORS on the real application, per ADR-0017', () => {
  it('names the configured origin for a request from it', async () => {
    const response = await request(server)
      .get('/api/v1/fixture/open')
      .set('Origin', allowedOrigin)
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('SENDS NO Access-Control-Allow-Origin AT ALL to an unknown origin', async () => {
    // The spec the brief names explicitly: not a header naming a different
    // origin, none.
    const response = await request(server)
      .get('/api/v1/fixture/open')
      .set('Origin', 'https://evil.test')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a preflight without reaching a guard, and refuses one from elsewhere', async () => {
    const allowed = await request(server)
      .options('/api/v1/fixture/write')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-csrf-token')
      .expect(204);
    expect(allowed.headers['access-control-allow-headers']).toContain('X-CSRF-Token');

    const refused = await request(server)
      .options('/api/v1/fixture/write')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('puts the CORS headers on an ERROR response too', async () => {
    // A 401 with no CORS headers is a 401 the page cannot read, so the frontend
    // sees an opaque network failure instead of "your session ended". The stage
    // is middleware precisely so it covers responses no route produced.
    const response = await request(server)
      .get('/api/v1/fixture/me')
      .set('Origin', allowedOrigin)
      .expect(401);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['vary']).toContain('Origin');
  });

  it('varies on Origin even when the origin is unknown', async () => {
    const response = await request(server)
      .get('/api/v1/fixture/open')
      .set('Origin', 'https://evil.test')
      .expect(200);
    expect(response.headers['vary']).toContain('Origin');
  });
});
