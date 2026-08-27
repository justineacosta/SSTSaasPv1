import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import request from 'supertest';
import type { Server } from 'node:http';
import { SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { SessionService, type SessionResolution } from '../../modules/auth/session.service.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import {
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
    return { userId: seen?.userId, sessionId: seen?.sessionId };
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

/** What the handler saw, captured by a second guard registered after the first. */
let seen: { userId: string; sessionId: string } | undefined;

const CAPTURE = {
  provide: APP_GUARD,
  useValue: {
    canActivate: (context: { switchToHttp: () => { getRequest: () => unknown } }): boolean => {
      const request_ = context.switchToHttp().getRequest() as {
        principal?: { userId: string; sessionId: string };
      };
      seen = request_.principal;
      return true;
    },
  },
};

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildGuardedApp({
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: SessionService, useValue: sessions },
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      CAPTURE,
    ],
  });
  server = app.getHttpServer() as Server;
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
    expect(seen).toBeUndefined();
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

    expect(seen?.userId).toBe('usr_01ABCDEFGHJKMNPQRSTVWXYZ00');
    expect(seen?.sessionId).toBe('ses_01ABCDEFGHJKMNPQRSTVWXYZ00');
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
    expect(Object.keys(seen ?? {}).sort()).toEqual(['kind', 'sessionId', 'userId']);
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
    // The exception has to exist or MFA could never be completed. Task 11 builds
    // the endpoint; the mechanism is proved here because a rule about routes
    // cannot honestly be proved by a task that ships none.
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
    expect(seen?.sessionId).toBe('ses_01ABCDEFGHJKMNPQRSTVWXYZ00');
  });

  it('does not let an ACTIVE session be refused by the same rule', async () => {
    // The negative control: a guard that refused everything would pass every
    // test above.
    await request(server).post('/api/v1/probe/mfa').set('Cookie', cookie(ACTIVE_TOKEN)).expect(201);
  });
});
