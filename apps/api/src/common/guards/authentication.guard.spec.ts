import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Post, SetMetadata } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import request from 'supertest';
import type { Server } from 'node:http';
import { SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { SessionService, type SessionResolution } from '../../modules/auth/session.service.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import {
  ALLOW_PENDING_MFA_KEY,
  AllowPendingMfa,
  AuthenticatedOnly,
  Public,
  RequirePermission,
} from '../decorators/access.decorator.js';
import { AuthenticationGuard } from './authentication.guard.js';

/**
 * THE GUARD, AGAINST ROUTES THAT EXIST NOWHERE IN THE PRODUCT.
 *
 * `pnpm check:openapi` reports four routes, and every controller below is one
 * this codebase deliberately does not contain — the same reason
 * `routing-app.ts` exists for the boot assertion. A guard whose rules could
 * only be proved against real endpoints could not be built until Task 9, and
 * would then be proved by the tasks that depend on it being right.
 *
 * The session service is a stub keyed by token, so every outcome
 * `SessionService.resolve` can return is reachable here — including the two
 * expiry outcomes, which against a real service would need a real clock.
 * `session.service.integration.spec.ts` already proves that `resolve` returns
 * them for the right reasons; this file proves what the guard does with them.
 */
const ACTIVE_TOKEN = 'active-session-token';
const PENDING_TOKEN = 'pending-session-token';
const EXPIRED_TOKEN = 'expired-session-token';
const REVOKED_TOKEN = 'revoked-session-token';

const identity = (status: 'ACTIVE' | 'PENDING_MFA'): SessionResolution => ({
  outcome: 'resolved',
  session: {
    id: 'ses_01ABCDEFGHJKMNPQRSTVWXYZ00',
    userId: 'usr_01ABCDEFGHJKMNPQRSTVWXYZ00',
    status,
    activeOrganizationId: null,
    rememberMe: false,
    absoluteExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    idleExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    mfaCompletedAt: null,
  },
});

const RESOLUTIONS: Record<string, SessionResolution> = {
  [ACTIVE_TOKEN]: identity('ACTIVE'),
  [PENDING_TOKEN]: identity('PENDING_MFA'),
  [EXPIRED_TOKEN]: { outcome: 'expired' },
  [REVOKED_TOKEN]: { outcome: 'revoked' },
};

const sessions = {
  resolve: (token: string): Promise<SessionResolution> =>
    Promise.resolve(RESOLUTIONS[token] ?? { outcome: 'unknown' }),
};

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): string {
    return 'open';
  }

  @Public()
  @Post('open-post')
  openPost(): string {
    return 'open';
  }

  @AuthenticatedOnly()
  @Get('me')
  me(): { userId: string | undefined; sessionId: string | undefined } {
    // Read straight off the request in a later stage, which is the only thing
    // attaching a principal is for.
    return { userId: captured()?.userId, sessionId: captured()?.sessionId };
  }

  @RequirePermission('finding.read')
  @Get('guarded')
  guarded(): string {
    return 'guarded';
  }

  @AuthenticatedOnly()
  @AllowPendingMfa()
  @Post('mfa')
  mfa(): string {
    return 'mfa';
  }
}

/**
 * THE EXEMPTION, ATTACKED AT CLASS LEVEL — three ways one could be written.
 *
 * `@AllowPendingMfa()` is typed `MethodDecorator`, so `attack-b` needs a cast
 * and `attack-a` bypasses the decorator entirely with the exported key. Both
 * are things a person can write, and `ALLOW_PENDING_MFA_KEY` is exported, so
 * neither is hypothetical.
 *
 * This codebase has already shipped this exact accident once: `@RateLimitExempt()`
 * was narrowed to `MethodDecorator`, but `RateLimitGuard` still *honoured*
 * class-level metadata, so one `@SetMetadata(RATE_LIMIT_EXEMPT_KEY, true)` on a
 * controller disabled every limit beneath it. The guard here reads
 * `reflector.get(key, context.getHandler())` and nothing else; these controllers
 * are what holds that line in place.
 */
@SetMetadata(ALLOW_PENDING_MFA_KEY, true)
@Controller('attack-raw-metadata')
class RawClassMetadataController {
  @AuthenticatedOnly()
  @Get()
  reachable(): string {
    return 'should never be reached by a pending session';
  }
}

@(AllowPendingMfa() as ClassDecorator)
@Controller('attack-cast-decorator')
class CastDecoratorController {
  @AuthenticatedOnly()
  @Get()
  reachable(): string {
    return 'should never be reached by a pending session';
  }
}

@SetMetadata(ALLOW_PENDING_MFA_KEY, true)
class ExemptBaseController {}

@Controller('attack-inherited-class')
class InheritedClassMetadataController extends ExemptBaseController {
  @AuthenticatedOnly()
  @Get()
  reachable(): string {
    return 'should never be reached by a pending session';
  }
}

interface Captured {
  readonly kind: string;
  readonly userId: string;
  readonly sessionId: string;
}

/** What the handler saw, captured by a second guard registered after the first. */
let seen: Captured | undefined;

/**
 * Read through a function, not directly.
 *
 * `seen = undefined` at the top of a test narrows the variable to `undefined`
 * for the rest of it, and TypeScript does not widen it again just because an
 * `await` ran a guard that assigned to it. Reading through a call is what makes
 * the assertion see the declared type instead of `never`.
 */
const captured = (): Captured | undefined => seen;

const CAPTURE = {
  provide: APP_GUARD,
  useValue: {
    canActivate: (context: { switchToHttp: () => { getRequest: () => unknown } }): boolean => {
      const request_ = context.switchToHttp().getRequest() as { principal?: Captured };
      seen = request_.principal;
      return true;
    },
  },
};

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildGuardedApp({
    controllers: [
      ProbeController,
      RawClassMetadataController,
      CastDecoratorController,
      InheritedClassMetadataController,
    ],
    providers: [
      Reflector,
      { provide: SessionService, useValue: sessions },
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      CAPTURE,
    ],
  });
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

const cookie = (token: string): string => `${SESSION_COOKIE_NAME}=${token}`;

const codeOf = (body: unknown): string => errorEnvelopeSchema.parse(body).error.code;

describe('a public route', () => {
  it('is reachable with no credential at all', async () => {
    await request(server).get('/api/v1/probe/open').expect(200);
  });

  it('is STILL reachable when the browser attaches a garbage cookie', async () => {
    // A browser sends whatever it has stored, unasked. If a malformed or expired
    // cookie could 401 a public route, the way out of a bad cookie — the login
    // page — would be unreachable for the users who most need it.
    await request(server).get('/api/v1/probe/open').set('Cookie', cookie('nonsense')).expect(200);
    await request(server)
      .get('/api/v1/probe/open')
      .set('Cookie', cookie(EXPIRED_TOKEN))
      .expect(200);
    await request(server)
      .get('/api/v1/probe/open')
      .set('Cookie', `${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`)
      .expect(200);
  });

  it('attaches no principal, so nothing downstream can mistake it for signed in', async () => {
    seen = undefined;
    await request(server).get('/api/v1/probe/open').set('Cookie', cookie(ACTIVE_TOKEN)).expect(200);
    expect(captured()).toBeUndefined();
  });
});

describe('the two refusals, which must stay distinct', () => {
  it('answers 401 UNAUTHENTICATED when no cookie is present', async () => {
    const response = await request(server).get('/api/v1/probe/me').expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
  });

  it('answers 401 UNAUTHENTICATED for a token that resolves to nothing', async () => {
    // `api/authentication.md` §6 keeps this distinct from SESSION_EXPIRED. A
    // token matching no row never was a session here, so "your session ended"
    // would be a false statement — to anyone holding a cookie from a database
    // that has since been reset, among others.
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', cookie('never-issued'))
      .expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
  });

  it('answers 401 UNAUTHENTICATED for an empty cookie value', async () => {
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=`)
      .expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
  });

  it('answers 401 UNAUTHENTICATED for two session cookies, not whichever one it liked', async () => {
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${ACTIVE_TOKEN}; ${SESSION_COOKIE_NAME}=other`)
      .expect(401);
    expect(codeOf(response.body)).toBe('UNAUTHENTICATED');
  });

  it('answers 401 SESSION_EXPIRED for an expired session', async () => {
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', cookie(EXPIRED_TOKEN))
      .expect(401);
    expect(codeOf(response.body)).toBe('SESSION_EXPIRED');
  });

  it('answers 401 SESSION_EXPIRED for a revoked session', async () => {
    // Revoked and expired share a code deliberately: the frontend's next step is
    // identical, and splitting them would tell whoever holds a stolen token
    // whether the theft had been noticed.
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', cookie(REVOKED_TOKEN))
      .expect(401);
    expect(codeOf(response.body)).toBe('SESSION_EXPIRED');
  });
});

describe('a resolved session', () => {
  it('reaches an @AuthenticatedOnly route and arrives as a principal', async () => {
    seen = undefined;
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', cookie(ACTIVE_TOKEN))
      .expect(200);

    expect(captured()?.userId).toBe('usr_01ABCDEFGHJKMNPQRSTVWXYZ00');
    expect(captured()?.sessionId).toBe('ses_01ABCDEFGHJKMNPQRSTVWXYZ00');
    expect(response.body).toEqual({
      userId: 'usr_01ABCDEFGHJKMNPQRSTVWXYZ00',
      sessionId: 'ses_01ABCDEFGHJKMNPQRSTVWXYZ00',
    });
  });

  it('reaches a @RequirePermission route too — this stage answers WHO, not WHAT', async () => {
    // `security/authentication.md` §1. The permission is Task 12's guard to
    // evaluate; an authentication stage that started refusing on permissions
    // would be the point at which the two stages stopped being separable, and
    // organisation switching depends on their being separate (ruling E).
    await request(server)
      .get('/api/v1/probe/guarded')
      .set('Cookie', cookie(ACTIVE_TOKEN))
      .expect(200);
  });

  it('carries no organisation and no permissions — ruling E and ruling F', async () => {
    seen = undefined;
    await request(server).get('/api/v1/probe/me').set('Cookie', cookie(ACTIVE_TOKEN)).expect(200);
    expect(Object.keys(captured() ?? {}).sort()).toEqual(['kind', 'sessionId', 'userId']);
  });
});

describe('a PENDING_MFA session — the other half of the MFA bypass', () => {
  it('is refused with 401 MFA_REQUIRED on an ordinary authenticated route', async () => {
    // `security/authentication.md` §5: the pending session "can do nothing but
    // complete MFA". Task 6's ruling 50 closed the half where such a session
    // could be PROMOTED without evidence; this is the half that constrains what
    // it may DO. A pending credential that can read anything is the whole
    // bypass.
    const response = await request(server)
      .get('/api/v1/probe/me')
      .set('Cookie', cookie(PENDING_TOKEN))
      .expect(401);
    expect(codeOf(response.body)).toBe('MFA_REQUIRED');
  });

  it('is refused on a permission-guarded route as well', async () => {
    const response = await request(server)
      .get('/api/v1/probe/guarded')
      .set('Cookie', cookie(PENDING_TOKEN))
      .expect(401);
    expect(codeOf(response.body)).toBe('MFA_REQUIRED');
  });

  it('IS allowed through on the route carrying @AllowPendingMfa', async () => {
    // The exception has to exist or MFA could never be completed. Task 11
    // shipped `POST /auth/mfa/verify` carrying the decorator — but that route is
    // `@Public()`, so this guard exits before it reads the metadata and the
    // exemption enforces nothing there. The mechanism is proved here, against a
    // fixture controller that IS authenticated, because no shipped route
    // exercises it.
    await request(server)
      .post('/api/v1/probe/mfa')
      .set('Cookie', cookie(PENDING_TOKEN))
      .expect(201);
  });

  it('attaches its principal on that route, so the endpoint knows whose it is', async () => {
    seen = undefined;
    await request(server)
      .post('/api/v1/probe/mfa')
      .set('Cookie', cookie(PENDING_TOKEN))
      .expect(201);
    expect(captured()?.sessionId).toBe('ses_01ABCDEFGHJKMNPQRSTVWXYZ00');
  });

  it('does not let an ACTIVE session be refused by the same rule', async () => {
    // The negative control: a guard that refused everything would pass every
    // test above.
    await request(server).post('/api/v1/probe/mfa').set('Cookie', cookie(ACTIVE_TOKEN)).expect(201);
  });
});

describe('the pending-MFA exemption cannot be granted at class level', () => {
  // THE HISTORICAL ACCIDENT, AS A TEST. Widening the reflector read to
  // `getAllAndOverride([getHandler(), getClass()])` — the exact shape of the
  // `@RateLimitExempt()` bug this codebase already shipped — left both lanes
  // green before these three cases existed. One `@SetMetadata` on a controller
  // would then grant a pre-MFA session every route beneath it, which is the
  // whole MFA bypass, with a passing suite.
  it.each([
    ['raw @SetMetadata on the controller', '/api/v1/attack-raw-metadata'],
    ['@AllowPendingMfa() cast to a ClassDecorator', '/api/v1/attack-cast-decorator'],
    ['class metadata inherited from a base controller', '/api/v1/attack-inherited-class'],
  ])('refuses a pending session on a route exempted by %s', async (_shape, path) => {
    const response = await request(server)
      .get(path)
      .set('Cookie', cookie(PENDING_TOKEN))
      .expect(401);
    expect(codeOf(response.body)).toBe('MFA_REQUIRED');
  });

  it('still lets an ACTIVE session through those routes — they are ordinary routes', async () => {
    // The negative control. A guard that refused all three regardless of status
    // would pass every case above while breaking the routes for everyone.
    for (const path of [
      '/api/v1/attack-raw-metadata',
      '/api/v1/attack-cast-decorator',
      '/api/v1/attack-inherited-class',
    ]) {
      await request(server).get(path).set('Cookie', cookie(ACTIVE_TOKEN)).expect(200);
    }
  });
});

describe('what the guard does NOT attach', () => {
  it('sets no principalId on the request — ruling B, and nothing else held it', async () => {
    // The limiter reads `request.principalId` and runs BEFORE this guard, so a
    // value written here has already missed its only reader. Writing it anyway
    // would make `generalSession`'s per-principal limit look wired while
    // resolving nothing on every request. The review added that one line and
    // both lanes stayed green; this is the assertion that would have caught it.
    let keys: string[] = [];
    class Capture {
      canActivate(context: { switchToHttp: () => { getRequest: () => object } }): boolean {
        keys = Object.keys(context.switchToHttp().getRequest());
        return true;
      }
    }
    const probe = await buildGuardedApp({
      controllers: [ProbeController],
      providers: [
        Reflector,
        { provide: SessionService, useValue: sessions },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: Capture },
      ],
    });
    try {
      await request(probe.getHttpServer())
        .get('/api/v1/probe/me')
        .set('Cookie', cookie(ACTIVE_TOKEN))
        .expect(200);
      expect(keys).toContain('principal');
      expect(keys).not.toContain('principalId');
      expect(keys).not.toContain('organizationId');
    } finally {
      await probe.close();
    }
  });
});
