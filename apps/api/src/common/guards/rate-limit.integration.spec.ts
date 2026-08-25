import 'reflect-metadata';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { config as loadDotenv } from 'dotenv';
import { Controller, Get, type INestApplication, Module, Post, SetMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { Public } from '../decorators/access.decorator.js';
import {
  RATE_LIMIT_EXEMPT_KEY,
  RateLimit,
  RateLimitExempt,
} from '../decorators/rate-limit.decorator.js';
import { HealthController } from '../../modules/health/health.controller.js';
import { AppModule } from '../../app.module.js';
import { configureApp } from '../../app-setup.js';
import { LOGGER } from '../../infrastructure/tokens.js';

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

  /** `emailVerificationResend`: body-keyed account (3/hour) AND a 10/hour IP bound. */
  @Public()
  @RateLimit('emailVerificationResend')
  @Post('resend')
  resend(): { ok: true } {
    return { ok: true };
  }

  /**
   * Exempt at the HANDLER, on a class whose per-IP scope resolves. If the guard
   * ever read only the controller's metadata and ignored the handler's, this
   * route would start being limited and start creating keys — which the
   * liveness tests cannot detect, because the default class resolves nothing
   * on an unauthenticated request either way.
   */
  @Public()
  @RateLimit('registration')
  @RateLimitExempt()
  @Post('exempt')
  exempt(): { ok: true } {
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

/**
 * The class-level bypass, attempted the only way it can still be written.
 * `@RateLimitExempt()` is `MethodDecorator`, so this uses the raw key — which is
 * exported from the same module and was, until this was closed, honoured by the
 * guard. One line here disabled every limit beneath it.
 */
@SetMetadata(RATE_LIMIT_EXEMPT_KEY, true)
@Controller({ path: 'bypass', version: '1' })
class BypassAttemptController {
  @Public()
  @RateLimit('registration')
  @Post('limited')
  limited(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [AppModule],
  controllers: [FixtureController, BypassAttemptController],
})
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

/** Only the classes this suite drives, so it cannot clobber another suite's keys. */
const FIXTURE_CLASSES = [
  'registration',
  'login',
  'generalSession',
  'emailVerificationResend',
  'invitations',
] as const;

beforeEach(async () => {
  // Every request in this suite arrives from the same loopback address, so the
  // per-IP buckets would otherwise carry over between tests. Scanned rather
  // than KEYS, which keeps the scan bounded.
  //
  // **This does NOT protect other suites, and an earlier version of this
  // comment claimed it did.** `FIXTURE_CLASSES` includes `login`, and
  // `sliding-window.integration.spec.ts:13` builds its keys as
  // `slidingWindowKey('login', 'perIp', randomUUID())` — `ratelimit:login:perIp:*`,
  // squarely inside the pattern this loop deletes. Both suites share the one
  // compose Redis. While integration files ran in parallel that made
  // `sliding-window` fail intermittently on counts lower than it had just
  // written (`expected 1 to be 2`, `expected +0 to be 5`), which cost most of a
  // session to diagnose because the deletion happens in a different file.
  //
  // What protects it now is sequential execution — root `test:integration`
  // passes `--no-file-parallelism`, see the comment on the integration project
  // in `vitest.workspace.ts`. That is a real guard, not a coincidence, but it
  // is the ONLY one: restore parallelism and this loop reaches into that suite
  // again. Nor does it protect a developer's running app, whose own buckets are
  // exactly these classes.
  for (const className of FIXTURE_CLASSES) {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(
        cursor,
        'MATCH',
        `ratelimit:${className}:*`,
        'COUNT',
        500,
      );
      if (found.length > 0) await redis.del(...found);
      cursor = next;
    } while (cursor !== '0');
  }
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

  it('counts per IP and per account independently', async () => {
    // `login` is 5 per account and 20 per IP. Exhausting one account must not
    // exhaust another's budget from the same address — otherwise the two scopes
    // are one scope wearing two names.
    for (let i = 0; i < 5; i += 1) {
      await request(server)
        .post('/api/v1/fixture/login')
        .send({ email: 'user_a@example.com' })
        .expect(201);
    }
    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'user_a@example.com' })
      .expect(429);

    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'user_b@example.com' })
      .expect(201);
  });

  it('applies the per-class limit, not one global limit', async () => {
    // Exhausting `registration` (3/IP) must leave `login` (20/IP) untouched.
    for (let i = 0; i < 3; i += 1) await request(server).post('/api/v1/fixture/registration');
    await request(server).post('/api/v1/fixture/registration').expect(429);

    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'user_c@example.com' })
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
      .send({ email: 'user_d@example.com' })
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

describe('rate limiting — the account-keyed classes', () => {
  it('keys the per-account window off the body, not an authenticated principal', async () => {
    // The three per-account rows of abuse-prevention.md §1 are unauthenticated
    // by definition: a failed login carries no principal, and "5 / 15 min per
    // account" means the account being attempted. Reading `principalId` here
    // resolves nothing — and because `perIp` (20) does resolve, the miss would
    // be skipped in silence, leaving a route that 429s at 20, advertises
    // `limit: 20`, and does not apply the control that stops credential
    // stuffing at all.
    for (let i = 0; i < 5; i += 1) {
      await request(server)
        .post('/api/v1/fixture/login')
        .send({ email: 'victim@example.com' })
        .expect(201);
    }

    const { status, headers } = await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'victim@example.com' });

    // Refused at 5 by the account window, well before the per-IP window's 20.
    expect(status).toBe(429);
    expect(headers['ratelimit-limit']).toBe('5');
  });

  it('leaves a different account untouched when one is exhausted', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(server).post('/api/v1/fixture/login').send({ email: 'a@example.com' });
    }
    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'a@example.com' })
      .expect(429);
    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'b@example.com' })
      .expect(201);
  });

  it('never puts the raw account identifier in a Redis key', async () => {
    // The key would otherwise expose an email address to anything that can run
    // KEYS, read a slow-log, or dump memory.
    await request(server).post('/api/v1/fixture/login').send({ email: 'secret@example.com' });

    const keys = await redis.keys('ratelimit:login:perPrincipal:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain('secret@example.com');
      expect(key).not.toContain('secret');
    }
  });

  it('normalises the account identifier so case and padding are one bucket', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(server).post('/api/v1/fixture/login').send({ email: 'Case@Example.com' });
    }
    await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: '  case@example.COM  ' })
      .expect(429);
  });

  it('still bounds a request that names no account, by IP', async () => {
    // Naming no account used to mean "no scope resolves", which the fail-closed
    // rule refused outright. Now that the class carries a per-IP bound, an
    // anonymous request is allowed but counted — and the IP bound is what stops
    // a caller who names a fresh address every time from sending unlimited
    // verification mail to third parties.
    for (let i = 0; i < 10; i += 1) {
      await request(server).post('/api/v1/fixture/resend').send({}).expect(201);
    }
    await request(server).post('/api/v1/fixture/resend').send({}).expect(429);
  });

  it('caps a caller naming a fresh account every time, which the account window cannot', async () => {
    // The amplifier case. Each address is the first in its own account window,
    // so the per-account limit never triggers; only the per-IP bound does.
    for (let i = 0; i < 10; i += 1) {
      await request(server)
        .post('/api/v1/fixture/resend')
        .send({ email: `fresh${i}@example.com` })
        .expect(201);
    }
    await request(server)
      .post('/api/v1/fixture/resend')
      .send({ email: 'fresh-one-more@example.com' })
      .expect(429);
  });
});

describe('rate limiting — a refusal must not spend another scope', () => {
  it('does not charge the account window for a request the IP window refused', async () => {
    // Exhaust the per-IP window (20) using 20 distinct accounts, then attack a
    // 21st. Without the break, those refused attempts would still burn the
    // victim's 5-per-15-minutes budget — so one address, *after* its own limit
    // had closed, could lock out arbitrarily many accounts. The per-IP cap
    // exists precisely to bound the damage one address can do.
    for (let i = 0; i < 20; i += 1) {
      await request(server)
        .post('/api/v1/fixture/login')
        .send({ email: `filler${i}@example.com` });
    }

    for (let i = 0; i < 6; i += 1) {
      await request(server)
        .post('/api/v1/fixture/login')
        .send({ email: 'victim2@example.com' })
        .expect(429);
    }

    const accountKeys = await redis.keys('ratelimit:login:perPrincipal:*');
    let worst = 0;
    for (const key of accountKeys) worst = Math.max(worst, await redis.zcard(key));
    // Each filler account spent exactly one slot; the victim spent none, so no
    // account window may hold more than one entry.
    expect(worst).toBe(1);
  });
});

describe('liveness is never rate limited', () => {
  it('issues no Redis command at all while probing /health/live', async () => {
    // monitoring.md §5: liveness checks the process and nothing else. The
    // rate-limit guard reaches Redis, so a limited liveness route would acquire
    // exactly the backing-service dependency the probe is defined not to have.
    // Watched on a real connection rather than reasoned about, because before
    // `@RateLimitExempt()` this property held only by accident — no scope of
    // the default class happened to resolve.
    const watcher = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const monitor = await watcher.monitor();
    const commands: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) => {
      commands.push(args.join(' '));
    });

    try {
      for (let i = 0; i < 5; i += 1) await request(server).get('/health/live').expect(200);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      monitor.disconnect();
      watcher.disconnect();
    }

    expect(commands.filter((c) => c.toLowerCase().includes('ratelimit'))).toEqual([]);
    expect(commands.filter((c) => c.toLowerCase().startsWith('eval'))).toEqual([]);
  });

  it('sees Redis traffic for a limited route, so the absence above means something', async () => {
    // The positive control the previous version of this test lacked. Without
    // it, a watcher that silently failed to attach — or a guard that never
    // reaches Redis for any route — would satisfy the assertion above while
    // proving nothing at all.
    const watcher = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const monitor = await watcher.monitor();
    const commands: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) => {
      commands.push(args.join(' '));
    });

    try {
      await request(server).post('/api/v1/fixture/registration');
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      monitor.disconnect();
      watcher.disconnect();
    }

    expect(commands.filter((c) => c.toLowerCase().startsWith('eval')).length).toBeGreaterThan(0);
  });

  it('honours an exemption declared on the handler of an otherwise-limited class', () => {
    // `registration` is 3 per IP and its scope resolves, so without a
    // handler-level exemption this route would refuse on the fourth request and
    // leave a key behind.
    return (async () => {
      for (let i = 0; i < 8; i += 1) {
        await request(server).post('/api/v1/fixture/exempt').expect(201);
      }
      expect(await redis.keys('ratelimit:registration:*')).toEqual([]);
    })();
  });

  it('pins the exemption to the liveness handler itself', () => {
    // The behavioural tests above pass with or without the decorator, because
    // the default class happens to resolve no scope on an unauthenticated
    // request — the very accident `@RateLimitExempt()` was added to replace.
    // Deleting the decorator has to fail something, so it fails this.
    // Read through a descriptor rather than `Controller.prototype.method`: the
    // latter is an unbound method reference, which the lint rules reject.
    const handler = (name: string): object =>
      Object.getOwnPropertyDescriptor(HealthController.prototype, name)?.value as object;

    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handler('live'))).toBe(true);
    // And it must not have spread: readiness stays on the normal path.
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, handler('ready'))).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_EXEMPT_KEY, HealthController)).toBeUndefined();
  });

  it('carries no RateLimit headers on the liveness probe', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    expect(headers['ratelimit-limit']).toBeUndefined();
    expect(headers['ratelimit-remaining']).toBeUndefined();
  });
});

describe('the exemption is a per-route decision and cannot be taken class-wide', () => {
  it('ignores exempt metadata set on a controller, even on a fail-closed class', () => {
    // Narrowing the decorator's TYPE stopped `@RateLimitExempt()` being written
    // on a class; it did not stop the guard from honouring class-level metadata,
    // and the key is exported. One `@SetMetadata` on a controller was still a
    // kill switch for every limit beneath it — measured at 6/6 allowed on a
    // fail-closed class during a Redis outage. `registration` is 3 per IP, so
    // an honoured bypass shows up as the fourth request succeeding.
    return (async () => {
      for (let i = 0; i < 3; i += 1) {
        await request(server).post('/api/v1/bypass/limited').expect(201);
      }
      await request(server).post('/api/v1/bypass/limited').expect(429);
    })();
  });
});

describe('headers describe the window closest to refusing', () => {
  it('reports the account window when it is tighter than the IP window', async () => {
    // `login` is 5 per account and 20 per IP. A client with 4 account slots left
    // must be told 4, not 19 — the headers exist so a caller can pace itself
    // before it is cut off, and the loosest window tells it the opposite of what
    // it needs. Every other header assertion in this suite uses a single-scope
    // class or the 429 path, so this is the only cover for the multi-scope
    // allowed path.
    const first = await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'tightest@example.com' })
      .expect(201);
    expect(first.headers['ratelimit-limit']).toBe('5');
    expect(first.headers['ratelimit-remaining']).toBe('4');

    const second = await request(server)
      .post('/api/v1/fixture/login')
      .send({ email: 'tightest@example.com' })
      .expect(201);
    expect(second.headers['ratelimit-remaining']).toBe('3');
  });
});

describe('an unresolvable declared scope is reported once, not once per request', () => {
  it('does not let an ordinary client flood the channel it warns on', async () => {
    // The condition cannot tell a wiring defect from a client that simply sent
    // no `email`, and the latter is free to generate. Warning every time would
    // bury the defect it exists to surface — the same anti-pattern the
    // fail-open branch of this guard is written to avoid.
    //
    // Counted through an injected recorder, not by capturing stdout: the test
    // environment's logger deliberately writes nowhere, so a stdout-based
    // version of this test passes whether the guard warns once or every time.
    const lines: string[] = [];
    const recorder = {
      warn: (_bindings: unknown, message?: string) => lines.push(message ?? ''),
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      trace: () => undefined,
      child: () => recorder,
    };

    const moduleRef = await Test.createTestingModule({ imports: [FixtureModule] })
      .overrideProvider(LOGGER)
      .useValue(recorder)
      .compile();
    const loggedApp = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(loggedApp);
    await loggedApp.init();

    try {
      for (let i = 0; i < 6; i += 1) {
        await request(loggedApp.getHttpServer())
          .post('/api/v1/fixture/login')
          .send({ password: 'x' });
      }
    } finally {
      await loggedApp.close();
    }

    const warnings = lines.filter((line) => line.includes('declared but not resolvable'));
    // Exactly one: it must warn (the control being absent is worth knowing) and
    // must not warn again (six requests is six lines an attacker chose).
    expect(warnings.length).toBe(1);
  });
});
