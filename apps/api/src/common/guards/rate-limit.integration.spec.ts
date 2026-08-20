import 'reflect-metadata';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config as loadDotenv } from 'dotenv';
import { Controller, Get, type INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { Public } from '../decorators/access.decorator.js';
import { RateLimit } from '../decorators/rate-limit.decorator.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app-setup.js';

loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

/**
 * Fixture routes live in the spec, not in the application.
 *
 * The plan called for `__test` routes registered when `APP_ENV === 'test'`.
 * Task 9 established the better pattern with its `BoomController`: a route that
 * exists only in the test file cannot ship, cannot be reached in production by
 * a misconfigured `APP_ENV`, and does not have to be excluded from Task 11's
 * OpenAPI output. They still carry `@Public()` — ruling F7 — because Task 11's
 * boot assertion treats an undeclared route as a defect and would otherwise
 * crash the app in exactly this environment.
 */
@Controller({ path: 'fixture', version: '1' })
class FixtureController {
  /** `registration`: 3/hour per IP, fails closed. Small enough to exhaust in a test. */
  @Public()
  @RateLimit('registration')
  @Post('registration')
  registration(): { ok: true } {
    return { ok: true };
  }

  /** `login`: 5/15min per principal AND 20/15min per IP, fails closed. */
  @Public()
  @RateLimit('login')
  @Post('login')
  login(): { ok: true } {
    return { ok: true };
  }

  /** `generalSession`: per principal only, fails OPEN. */
  @Public()
  @RateLimit('generalSession')
  @Get('general')
  general(): { ok: true } {
    return { ok: true };
  }

  /** `invitations`: per organisation only, fails CLOSED — the unresolvable-scope case. */
  @Public()
  @RateLimit('invitations')
  @Post('invitations')
  invitations(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [AppModule], controllers: [FixtureController] })
class FixtureModule {}

/**
 * Stands in for the authentication middleware that arrives in Phase 2, so the
 * per-principal scope can be exercised now. Test-only, and deliberately dumb:
 * it reads a header, which is precisely what production must never do.
 */
function principalFromHeader(request: Request, _response: Response, next: NextFunction): void {
  const supplied = request.header('x-test-principal');
  if (supplied !== undefined) {
    (request as Request & { principalId?: string }).principalId = supplied;
  }
  next();
}

async function buildApp(redisUrl?: string): Promise<{ app: INestApplication; server: Server }> {
  const previous = process.env.REDIS_URL;
  if (redisUrl !== undefined) process.env.REDIS_URL = redisUrl;
  try {
    const moduleRef = await Test.createTestingModule({ imports: [FixtureModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    app.use(principalFromHeader);
    await app.init();
    return { app, server: app.getHttpServer() };
  } finally {
    if (redisUrl !== undefined) process.env.REDIS_URL = previous;
  }
}

let app: INestApplication;
let server: Server;
let redis: Redis;

beforeAll(async () => {
  ({ app, server } = await buildApp());
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  await redis.quit();
  await app.close();
});

beforeEach(async () => {
  // Every request in this suite arrives from the same loopback address, so the
  // per-IP buckets would otherwise carry over between tests.
  const keys = await redis.keys('ratelimit:*');
  if (keys.length > 0) await redis.del(...keys);
});

describe('rate limiting', () => {
  it('allows requests up to the limit and refuses the next one', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(server).post('/api/v1/fixture/registration').expect(201);
    }
    await request(server).post('/api/v1/fixture/registration').expect(429);
  });

  it('returns the shared error envelope with code RATE_LIMITED on the 429', async () => {
    for (let i = 0; i < 3; i += 1) await request(server).post('/api/v1/fixture/registration');
    const response = await request(server).post('/api/v1/fixture/registration').expect(429);

    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.code).toBe('RATE_LIMITED');
    expect(parsed.error.requestId).toMatch(/^req_/);
    expect(parsed.error.details?.['retryAfterSeconds']).toEqual(expect.any(Number));
  });

  it('sets RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset on an allowed response', async () => {
    const { headers } = await request(server).post('/api/v1/fixture/registration').expect(201);
    expect(headers['ratelimit-limit']).toBe('3');
    expect(headers['ratelimit-remaining']).toBe('2');
    expect(Number(headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('keeps the headers, and adds Retry-After, on the 429', async () => {
    // The guard sets these before it throws; the exception filter must not
    // discard them while building the envelope.
    for (let i = 0; i < 3; i += 1) await request(server).post('/api/v1/fixture/registration');
    const { headers } = await request(server).post('/api/v1/fixture/registration').expect(429);

    expect(headers['ratelimit-limit']).toBe('3');
    expect(headers['ratelimit-remaining']).toBe('0');
    expect(Number(headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('counts per IP and per principal independently', async () => {
    // `login` is 5 per principal and 20 per IP. Exhausting one principal must
    // not exhaust another's budget from the same address — otherwise the two
    // scopes are one scope wearing two names.
    for (let i = 0; i < 5; i += 1) {
      await request(server)
        .post('/api/v1/fixture/login')
        .set('x-test-principal', 'user_a')
        .expect(201);
    }
    await request(server)
      .post('/api/v1/fixture/login')
      .set('x-test-principal', 'user_a')
      .expect(429);

    await request(server)
      .post('/api/v1/fixture/login')
      .set('x-test-principal', 'user_b')
      .expect(201);
  });

  it('applies the per-class limit, not one global limit', async () => {
    // Exhausting `registration` (3/IP) must leave `login` (20/IP) untouched.
    for (let i = 0; i < 3; i += 1) await request(server).post('/api/v1/fixture/registration');
    await request(server).post('/api/v1/fixture/registration').expect(429);

    await request(server)
      .post('/api/v1/fixture/login')
      .set('x-test-principal', 'user_c')
      .expect(201);
  });

  it('does not let a forged X-Forwarded-For mint a fresh bucket', async () => {
    // The bypass that makes per-IP limiting decorative: if the header were
    // trusted, an attacker would rotate it and never meet a limit at all.
    for (let i = 0; i < 3; i += 1) {
      await request(server)
        .post('/api/v1/fixture/registration')
        .set('x-forwarded-for', `10.0.0.${i}`);
    }
    await request(server)
      .post('/api/v1/fixture/registration')
      .set('x-forwarded-for', '10.0.0.99')
      .expect(429);
  });

  it('refuses when a fail-closed class has no resolvable scope', async () => {
    // `invitations` is keyed only per organisation, and there is no tenant
    // context until Phase 2. Skipping the scope would leave a fail-closed class
    // with no limit whatsoever.
    const response = await request(server).post('/api/v1/fixture/invitations').expect(429);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('RATE_LIMITED');
  });

  it('allows when a fail-open class has no resolvable scope', async () => {
    // The other direction: `generalSession` is per principal, and an
    // unauthenticated request has none. It must not lock anyone out.
    await request(server).get('/api/v1/fixture/general').expect(200);
  });
});

describe('rate limiting when Redis is unavailable', () => {
  let deadApp: INestApplication;
  let deadServer: Server;

  beforeAll(async () => {
    // A second application pointed at a port nothing is listening on, rather
    // than stopping the shared container: the compose Redis is used by every
    // other integration suite and by the developer's own session.
    ({ app: deadApp, server: deadServer } = await buildApp('redis://127.0.0.1:6399'));
  });

  afterAll(async () => {
    await deadApp.close();
  });

  it('FAILS CLOSED on an authentication class', async () => {
    // A Redis outage must not become a window for credential stuffing.
    await request(deadServer).post('/api/v1/fixture/registration').expect(429);
    await request(deadServer)
      .post('/api/v1/fixture/login')
      .set('x-test-principal', 'user_d')
      .expect(429);
  });

  it('FAILS OPEN on a read-only class', async () => {
    // An outage must not lock every customer out of reading their own data.
    await request(deadServer)
      .get('/api/v1/fixture/general')
      .set('x-test-principal', 'user_e')
      .expect(200);
  });
});
