import 'reflect-metadata';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config as loadDotenv } from 'dotenv';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { Public } from './common/decorators/access.decorator.js';
import { AppModule } from './app.module.js';
import { configureApp } from './app-setup.js';

// The live compose stack is the system under test. `.env` is the same file the
// developer's own `pnpm dev` reads, so drift between the two is caught here
// rather than in production.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
// environments.md §1: the test environment logs nothing unless a test asks for
// it, and enforces CSP rather than merely reporting it — a policy that is only
// ever report-only where it is asserted is a policy no test has seen block
// anything.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

/**
 * A handler that fails the way real code fails, so the 500 path is exercised
 * against a realistic payload rather than `new Error('x')`. Carries a
 * constraint name, an internal host, a database role, and a credential.
 */
class RealisticInternalError extends Error {
  readonly code = 'P2002';
  readonly meta = { target: ['Finding_organizationId_fingerprint_key'] };
  readonly clientVersion = '6.19.3';
}

@Controller({ path: 'boom', version: '1' })
class BoomController {
  @Public()
  @Get('prisma')
  prisma(): never {
    throw new RealisticInternalError(
      'Invalid prisma.finding.create() at db-primary.internal:5432 as role sentinel_app: Unique constraint failed on the fields: (Finding_organizationId_fingerprint_key)',
    );
  }

  @Public()
  @Get('econnrefused')
  econnrefused(): never {
    throw new Error('connect ECONNREFUSED 10.42.0.7:5432');
  }

  @Public()
  @Get('secret')
  secret(): never {
    throw new Error('upstream rejected redis://sentinel:hunter2@10.42.0.9:6379');
  }
}

async function buildApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [BoomController],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

const serverOf = (app: INestApplication): Server => app.getHttpServer() as Server;

/** `supertest`'s `body` is `any`. One cast, in one place, with a name. */
const jsonOf = (response: { body: unknown }): Record<string, unknown> =>
  response.body as Record<string, unknown>;

interface DetailedBody {
  status: string;
  checkedAt: string;
  dependencies: Record<string, { status: string; latencyMs: number }>;
}

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildApp();
  server = serverOf(app);
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('API surface', () => {
  it('GET /health/live returns 200 and touches no dependency', async () => {
    await request(server).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready reports postgres, redis and storage individually', async () => {
    const response = await request(server).get('/health/ready').expect(200);
    expect(jsonOf(response).dependencies).toMatchObject({
      postgres: 'ok',
      redis: 'ok',
      storage: 'ok',
    });
  });

  it('echoes a supplied x-request-id', async () => {
    const response = await request(server)
      .get('/health/live')
      .set('x-request-id', 'req_supplied')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('req_supplied');
  });

  it('generates a request id when none is supplied', async () => {
    const response = await request(server).get('/health/live').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('refuses a client-supplied request id that is not well-formed', async () => {
    const response = await request(server)
      .get('/health/live')
      .set('x-request-id', 'not a valid id <script>')
      .expect(200);
    expect(response.headers['x-request-id']).not.toContain('<script>');
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sets every header in transport-and-headers.md §2', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    expect(headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-powered-by']).toBeUndefined();
    // An ETag alongside `no-store` is a contradiction, and Express emits one by
    // default.
    expect(headers.etag).toBeUndefined();
  });

  it('sets the same headers on an error response, not only on a success', async () => {
    // A response that skipped the middleware chain is a response with no
    // headers. An unmatched route is the easiest way to reach one.
    const { headers } = await request(server).get('/api/v1/does-not-exist').expect(404);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-request-id']).toMatch(/^req_/);
  });

  // The gap that let a whole class of unprotected responses ship: every header
  // assertion above picks a path *inside* `/api` or `/health`, which is exactly
  // the tree `MiddlewareConsumer.forRoutes({ path: '*splat' })` covered — it
  // resolves relative to the global prefix. `/`, `/a/b` and `/healthz` answered
  // with no security headers and no request ID at all. These paths are the
  // control, and they must stay in the suite even when nothing is routed there:
  // transport-and-headers.md §2 says "every application response", and an
  // unrouted path still produces one.
  it.each(['/', '/a', '/a/b', '/healthz', '/health', '/favicon.ico'])(
    'sets the full header set on %s, outside both /api and /health',
    async (path) => {
      const { headers } = await request(server).get(path);
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains; preload',
      );
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=(), payment=()',
      );
      expect(headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['content-security-policy']).toBeDefined();
      expect(headers['x-powered-by']).toBeUndefined();
      expect(headers['x-request-id']).toMatch(/^req_/);
    },
  );

  it('covers a response Nest rejects before routing, such as a malformed body', async () => {
    // Nest registers its body parser during `app.init()`. A chain registered
    // through `MiddlewareConsumer` runs *after* the parser, so a parse failure
    // answered with no headers and a request ID of `req_unknown` in both the
    // envelope and the log — an error nobody could correlate. `configureApp`
    // now registers the chain before init, which puts it ahead of the parser.
    const response = await request(server)
      .post('/api/v1/x')
      .set('content-type', 'application/json')
      .send('{"a":');
    expect(response.status).toBe(400);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBeDefined();
    const requestId = response.headers['x-request-id'] as string;
    expect(requestId).toMatch(/^req_/);
    // The envelope's request ID is the one on the wire, not the `req_unknown`
    // placeholder the filter falls back to when nothing set one.
    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.requestId).toBe(requestId);
  });

  it('honours a supplied request id even on a pre-routing failure', async () => {
    const response = await request(server)
      .post('/api/v1/x')
      .set('content-type', 'application/json')
      .set('x-request-id', 'req_from_edge')
      .send('{"a":');
    expect(response.headers['x-request-id']).toBe('req_from_edge');
    expect(errorEnvelopeSchema.parse(response.body).error.requestId).toBe('req_from_edge');
  });

  it('answers an oversized body with a client-class 413, not a 500', async () => {
    // body-parser raises an `http-errors` object, which is not a Nest
    // HttpException. Left unrecognised it fell to the filter's catch-all and
    // every oversized request became a 500 — a 5xx any caller could drive,
    // against the alert in operations/monitoring.md §6.
    const response = await request(server)
      .post('/api/v1/x')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(200_000) }));
    expect(response.status).toBe(413);
    const parsed = errorEnvelopeSchema.parse(response.body);
    // errors.md §3 files INTERNAL_ERROR under Server; a client must not read its
    // own too-large request as a server fault.
    expect(parsed.error.code).not.toBe('INTERNAL_ERROR');
    expect(parsed.error.requestId).toMatch(/^req_/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets a nonce-based CSP with no unsafe-inline and no unsafe-eval', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    const csp =
      headers['content-security-policy'] ?? headers['content-security-policy-report-only'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('enforces the policy outside development rather than only reporting it', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    expect(headers['content-security-policy']).toBeDefined();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('issues a different nonce on every request', async () => {
    const cspOf = async (): Promise<string> => {
      const { headers } = await request(server).get('/health/live');
      return (headers['content-security-policy'] ??
        headers['content-security-policy-report-only']) as string;
    };
    expect(await cspOf()).not.toBe(await cspOf());
  });

  it('returns the error envelope for an unmatched route', async () => {
    const response = await request(server).get('/api/v1/does-not-exist').expect(404);
    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(parsed.error.requestId).toMatch(/^req_/);
  });

  it('keeps health outside the /api/v1 prefix', async () => {
    // The exclusion is the thing under test: if it silently stopped applying,
    // /health/live would 404 and the prefixed paths would 200. Both directions
    // are asserted so a change that moves the routes cannot pass.
    await request(server).get('/health/live').expect(200);
    await request(server).get('/api/v1/health/live').expect(404);
    await request(server).get('/api/health/live').expect(404);
  });

  it('serves versioned routes under /api/v1', async () => {
    await request(server).get('/api/v1/boom/prisma').expect(500);
    await request(server).get('/boom/prisma').expect(404);
  });
});

describe('The 500 path leaks nothing', () => {
  it.each(['/api/v1/boom/prisma', '/api/v1/boom/econnrefused', '/api/v1/boom/secret'])(
    '%s returns a generic envelope and no internal detail',
    async (path) => {
      const response = await request(server).get(path).expect(500);
      const parsed = errorEnvelopeSchema.parse(response.body);
      expect(parsed.error.code).toBe('INTERNAL_ERROR');
      expect(parsed.error.requestId).toMatch(/^req_/);

      const body = JSON.stringify(response.body);
      for (const forbidden of [
        'stack',
        'at Object',
        'node_modules',
        'P2002',
        'Finding_organizationId_fingerprint_key',
        'prisma',
        'db-primary.internal',
        'sentinel_app',
        'ECONNREFUSED',
        '10.42.0.7',
        '10.42.0.9',
        'hunter2',
        '6.19.3',
        'RealisticInternalError',
      ]) {
        expect(body).not.toContain(forbidden);
      }
      // Exactly the envelope, nothing more.
      const json = jsonOf(response);
      expect(Object.keys(json)).toEqual(['error']);
      expect(Object.keys(json.error as object).sort()).toEqual(['code', 'message', 'requestId']);
    },
  );

  it('still sets the security headers on a 500', async () => {
    const { headers } = await request(server).get('/api/v1/boom/prisma').expect(500);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toBeDefined();
  });
});

describe('What Nest itself puts in an HttpException message', () => {
  it("a router 404's message reflects only the caller's own request line", async () => {
    // Recorded rather than assumed: Nest's NotFoundException for an unmatched
    // route carries "Cannot GET <path>". That echoes the caller's own input and
    // nothing internal — no handler name, no file path, no framework version.
    const response = await request(server).get('/api/v1/does-not-exist').expect(404);
    const message = errorEnvelopeSchema.parse(response.body).error.message;
    expect(message).toBe('Cannot GET /api/v1/does-not-exist');
    for (const forbidden of ['node_modules', 'apps/api', 'src/', 'Nest', 'express']) {
      expect(message).not.toContain(forbidden);
    }
  });

  it('does not reflect a request path back with control characters intact', async () => {
    const response = await request(server).get('/api/v1/%0d%0aX-Evil:%201').expect(404);
    const message = errorEnvelopeSchema.parse(response.body).error.message;
    expect(response.headers['x-evil']).toBeUndefined();
    expect(message).not.toMatch(/[\r\n]/);
  });
});

describe('/health/detailed', () => {
  it('adds timings and nothing an unauthenticated caller could map infrastructure with', async () => {
    const response = await request(server).get('/health/detailed').expect(200);
    const body = jsonOf(response) as unknown as DetailedBody;
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'dependencies', 'status']);
    expect(Object.keys(body.dependencies).sort()).toEqual(['postgres', 'redis', 'storage']);
    for (const entry of Object.values(body.dependencies)) {
      expect(Object.keys(entry).sort()).toEqual(['latencyMs', 'status']);
    }

    const serialised = JSON.stringify(response.body).toLowerCase();
    // monitoring.md §5 puts this endpoint behind authentication, which does not
    // exist yet. Until it does, nothing here may name a host, a port, a bucket,
    // a driver, or a version.
    for (const forbidden of [
      'localhost',
      '127.0.0.1',
      '5432',
      '6379',
      '9000',
      'postgres://',
      'postgresql',
      'redis://',
      'minio',
      'evidence',
      'prisma',
      'version',
    ]) {
      expect(serialised).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('A dependency outage', () => {
  // Not a mock: a second, real application whose Redis URL points at a port
  // nothing is listening on. The proof that liveness touches no dependency has
  // to come from a dependency that is genuinely gone.
  let brokenApp: NestExpressApplication;
  let brokenServer: Server;

  beforeAll(async () => {
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    try {
      brokenApp = await buildApp();
    } finally {
      process.env.REDIS_URL = original;
    }
    brokenServer = serverOf(brokenApp);
  }, 60_000);

  afterAll(async () => {
    await brokenApp.close();
  });

  it('leaves /health/live answering 200', async () => {
    // monitoring.md §5: a liveness check that fails when a dependency is
    // briefly unavailable restarts every instance at once, turning a blip into
    // an outage.
    await request(brokenServer).get('/health/live').expect(200, { status: 'ok' });
  });

  it('makes /health/ready return 503 naming the dependency that is down', async () => {
    const response = await request(brokenServer).get('/health/ready').expect(503);
    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(parsed.error.details).toEqual({
      dependencies: { postgres: 'ok', redis: 'error', storage: 'ok' },
    });
  });

  it('names the dependency without naming the host, port, or driver error', async () => {
    const response = await request(brokenServer).get('/health/ready').expect(503);
    const body = JSON.stringify(response.body);
    for (const forbidden of ['127.0.0.1', '6399', 'ECONNREFUSED', 'redis://', 'ioredis']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('reports the outage in /health/detailed too, still without infrastructure detail', async () => {
    const response = await request(brokenServer).get('/health/detailed').expect(200);
    const body = jsonOf(response) as unknown as DetailedBody;
    expect(body.status).toBe('degraded');
    expect(body.dependencies.redis?.status).toBe('error');
    expect(body.dependencies.postgres?.status).toBe('ok');
    // The same key-shape assertion the healthy case gets, applied to the branch
    // that actually runs during an outage. A forbidden-string sweep below is a
    // second line only: it catches the strings someone thought of, and a probe
    // that started reporting `host` or `driver` is exactly the field nobody
    // thought of.
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'dependencies', 'status']);
    expect(Object.keys(body.dependencies).sort()).toEqual(['postgres', 'redis', 'storage']);
    for (const entry of Object.values(body.dependencies)) {
      expect(Object.keys(entry).sort()).toEqual(['latencyMs', 'status']);
    }
    const serialised = JSON.stringify(response.body);
    for (const forbidden of ['127.0.0.1', '6399', 'ECONNREFUSED', 'redis://']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
