import { errorEnvelopeSchema, sessionCollectionSchema } from '@sentinel/contracts';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AuthHarness, clearRateLimits, startAuthHarness } from '../../testing/auth-harness.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.js';

/**
 * THE THREE SESSION ROUTES `/settings/security` IS BUILT ON, DRIVEN THROUGH THE
 * REAL APPLICATION.
 *
 * Real Postgres (Testcontainers, migrated), real Redis (compose), the real
 * `AppModule` and the real `configureApp`, so every guard in
 * `architecture/backend.md` §3's pipeline sits in front of these routes.
 *
 * # The most important test in this file is the cross-USER one
 *
 * `Session` is **user**-owned, not tenant-owned — `session.repository.ts`'s
 * class docblock and `schema.prisma`'s comment on the model both say so, and it
 * is deliberately absent from the tenant resource registry. So the isolation
 * property here is not the cross-tenant 404 every tenant-owned resource
 * inherits from `TenantContextGuard`; there is no guard that produces it. It is
 * enforced inside the handler, and only a test can tell whether it actually is.
 *
 * **404, never 403.** A 403 confirms the id names a real row, which turns this
 * route into an oracle for "is this session id live" against every account in
 * the product. The refusal for somebody else's session is asserted here to be
 * byte-identical to the refusal for an id that has never existed — as an
 * identity, not as two separate expectations that could drift apart.
 */

const PASSWORD = 'correct horse battery staple';

let h: AuthHarness;

beforeAll(async () => {
  h = await startAuthHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await clearRateLimits(h.redis);
  h.sent.length = 0;
});

let counter = 0;
const freshAddress = (): string => {
  counter += 1;
  return `sessions-${String(counter)}-${String(Date.now())}@example.test`;
};

const setCookies = (response: Response): string[] => {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
};

const cookieNamed = (response: Response, name: string): string | undefined =>
  setCookies(response).find((value) => value.startsWith(`${name}=`));

const valueOf = (cookie: string): string =>
  cookie.slice(cookie.indexOf('=') + 1).split(';')[0] ?? '';

interface Signed {
  readonly cookie: string;
  readonly csrf: string;
  readonly sessionToken: string;
}

async function account(): Promise<string> {
  const email = freshAddress();
  await clearRateLimits(h.redis);
  await request(h.server).post('/api/v1/auth/register').send({ email, password: PASSWORD });
  await h.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  h.sent.length = 0;
  return email;
}

async function signIn(email: string, agent = 'spec-agent/1.0'): Promise<Signed> {
  await clearRateLimits(h.redis);
  const response = await request(h.server)
    .post('/api/v1/auth/login')
    .set('User-Agent', agent)
    .send({ email, password: PASSWORD, rememberMe: true });
  const session = cookieNamed(response, SESSION_COOKIE_NAME);
  const csrf = cookieNamed(response, CSRF_COOKIE_NAME);
  if (session === undefined || csrf === undefined) {
    throw new Error(`login did not set cookies (status ${String(response.status)})`);
  }
  return {
    cookie: `${SESSION_COOKIE_NAME}=${valueOf(session)}; ${CSRF_COOKIE_NAME}=${valueOf(csrf)}`,
    csrf: valueOf(csrf),
    sessionToken: valueOf(session),
  };
}

const list = (signed: Signed): request.Test =>
  request(h.server).get('/api/v1/auth/sessions').set('Cookie', signed.cookie);

const revokeOne = (signed: Signed, sessionId: string): request.Test =>
  request(h.server)
    .delete(`/api/v1/auth/sessions/${sessionId}`)
    .set('Cookie', signed.cookie)
    .set('X-CSRF-Token', signed.csrf);

const revokeOthers = (signed: Signed): request.Test =>
  request(h.server)
    .delete('/api/v1/auth/sessions')
    .set('Cookie', signed.cookie)
    .set('X-CSRF-Token', signed.csrf);

/** The `Session.id` behind a signed-in cookie, taken from the route under test. */
async function sessionIdOf(signed: Signed): Promise<string> {
  const response = await list(signed).expect(200);
  const current = sessionCollectionSchema.parse(response.body).data.find((row) => row.current);
  if (current === undefined) throw new Error('no session marked current');
  return current.id;
}

/** The error envelope with `requestId` removed — the only field allowed to differ. */
function refusalWithoutRequestId(body: unknown): unknown {
  const parsed = errorEnvelopeSchema.parse(body);
  const { requestId, ...rest } = parsed.error;
  expect(requestId).toBeDefined();
  return { error: rest };
}

describe('cross-user isolation on the three session routes', () => {
  it("answers 404 for another user's session id, byte-identical to an id that never existed", async () => {
    const alice = await account();
    const bob = await account();
    const aliceSigned = await signIn(alice);
    const bobSigned = await signIn(bob);

    const bobSessionId = await sessionIdOf(bobSigned);

    // A well-formed id that names no row anywhere in the database.
    const neverExisted = 'ses_01M0T74WZZFY9T2QS56RGF3GQ7';

    const foreign = await revokeOne(aliceSigned, bobSessionId);
    const absent = await revokeOne(aliceSigned, neverExisted);

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(errorEnvelopeSchema.parse(foreign.body).error.code).toBe('RESOURCE_NOT_FOUND');
    expect(refusalWithoutRequestId(foreign.body)).toEqual(refusalWithoutRequestId(absent.body));
  });

  it("leaves the other user's session working after the refused revocation", async () => {
    const aliceSigned = await signIn(await account());
    const bobSigned = await signIn(await account());
    const bobSessionId = await sessionIdOf(bobSigned);

    await revokeOne(aliceSigned, bobSessionId).expect(404);

    // A 404 that had nonetheless revoked the row would be the worst possible
    // way for the assertion above to pass, so the credential is exercised.
    await request(h.server).get('/api/v1/auth/session').set('Cookie', bobSigned.cookie).expect(200);
  });

  it("never lists another user's sessions", async () => {
    const aliceSigned = await signIn(await account());
    const bobSigned = await signIn(await account());
    const bobSessionId = await sessionIdOf(bobSigned);

    const response = await list(aliceSigned).expect(200);
    const ids = sessionCollectionSchema.parse(response.body).data.map((row) => row.id);
    expect(ids).not.toContain(bobSessionId);
    expect(ids).toHaveLength(1);
  });

  it("'revoke all others' never reaches another user's sessions", async () => {
    const alice = await account();
    const aliceSigned = await signIn(alice);
    await signIn(alice, 'second-device/1.0');
    const bobSigned = await signIn(await account());

    await revokeOthers(aliceSigned).expect(200);

    await request(h.server).get('/api/v1/auth/session').set('Cookie', bobSigned.cookie).expect(200);
  });
});

describe('GET /api/v1/auth/sessions', () => {
  it('lists the caller’s own live sessions, most recently seen first', async () => {
    const email = await account();
    await signIn(email, 'device-one/1.0');
    const second = await signIn(email, 'device-two/1.0');

    // `lastSeenAt` is moved in Postgres rather than by issuing a request,
    // because a request does NOT move it: `isRenewalDue` renews only past the
    // halfway mark of the idle window (`session.service.ts`), which is twelve
    // hours. Measured — the first version of this test drove the older session
    // through `GET /auth/session` and its timestamp did not change. Writing the
    // column directly is what actually exercises the `ORDER BY`.
    await h.prisma.session.updateMany({
      where: { userAgent: 'device-one/1.0' },
      data: { lastSeenAt: new Date(Date.now() + 60_000) },
    });

    const page = sessionCollectionSchema.parse((await list(second).expect(200)).body);
    expect(page.data).toHaveLength(2);

    const seen = page.data.map((row) => Date.parse(row.lastSeenAt));
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(page.data[0]?.userAgent).toBe('device-one/1.0');
  });

  it('marks exactly one row as the current session, and it is the caller’s own', async () => {
    const email = await account();
    await signIn(email, 'device-one/1.0');
    const second = await signIn(email, 'device-two/1.0');

    const page = sessionCollectionSchema.parse((await list(second).expect(200)).body);
    expect(page.data.filter((row) => row.current)).toHaveLength(1);
    expect(page.data.find((row) => row.current)?.userAgent).toBe('device-two/1.0');
  });

  it('carries no tokenHash, and no stored hash value, on any row', async () => {
    const signed = await signIn(await account());
    const raw = JSON.stringify((await list(signed).expect(200)).body);

    expect(raw).not.toContain('tokenHash');
    const rows = await h.prisma.session.findMany({ select: { tokenHash: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(raw).not.toContain(row.tokenHash);
  });

  it('paginates rather than answering an unbounded list', async () => {
    const email = await account();
    await signIn(email, 'device-one/1.0');
    await signIn(email, 'device-two/1.0');
    const third = await signIn(email, 'device-three/1.0');

    const first = sessionCollectionSchema.parse(
      (await list(third).query({ limit: 1 }).expect(200)).body,
    );
    expect(first.data).toHaveLength(1);
    expect(first.pagination.limit).toBe(1);
    expect(first.pagination.hasMore).toBe(true);
    expect(first.pagination.nextCursor).not.toBeNull();

    const next = sessionCollectionSchema.parse(
      (
        await list(third)
          .query({ limit: 1, cursor: first.pagination.nextCursor ?? '' })
          .expect(200)
      ).body,
    );
    expect(next.data).toHaveLength(1);
    expect(next.data[0]?.id).not.toBe(first.data[0]?.id);
  });

  it('refuses a cursor this endpoint did not issue with a 400', async () => {
    const signed = await signIn(await account());
    const response = await list(signed).query({ cursor: 'not-a-cursor' }).expect(400);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('is refused without a session', async () => {
    await request(h.server).get('/api/v1/auth/sessions').expect(401);
  });

  it('does not list a session that has been revoked', async () => {
    const email = await account();
    const doomed = await signIn(email, 'doomed/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const doomedId = await sessionIdOf(doomed);

    await revokeOne(keeper, doomedId).expect(200);

    const page = sessionCollectionSchema.parse((await list(keeper).expect(200)).body);
    expect(page.data.map((row) => row.id)).not.toContain(doomedId);
  });
});

describe('DELETE /api/v1/auth/sessions/:sessionId', () => {
  it('actually invalidates the credential it revoked', async () => {
    const email = await account();
    const doomed = await signIn(email, 'doomed/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const doomedId = await sessionIdOf(doomed);

    await request(h.server).get('/api/v1/auth/session').set('Cookie', doomed.cookie).expect(200);

    await revokeOne(keeper, doomedId).expect(200);

    // Immediately, and off what is now a warm cache entry — the tombstone is
    // what makes this true rather than a TTL expiring.
    await request(h.server).get('/api/v1/auth/session').set('Cookie', doomed.cookie).expect(401);
  });

  it('writes exactly one SESSION_REVOKED audit row naming the revoked session', async () => {
    const email = await account();
    const doomed = await signIn(email, 'doomed/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const doomedId = await sessionIdOf(doomed);

    await revokeOne(keeper, doomedId).expect(200);

    const rows = await h.prisma.platformAuditEvent.findMany({
      where: { action: 'SESSION_REVOKED', resourceId: doomedId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceType).toBe('Session');
    expect(rows[0]?.actorType).toBe('USER');
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(doomed.sessionToken);
  });

  it('writes no second audit row when there was nothing live left to revoke', async () => {
    // Otherwise one caller holding one session can grow an append-only table by
    // replaying one request.
    const email = await account();
    const doomed = await signIn(email, 'doomed/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const doomedId = await sessionIdOf(doomed);

    await revokeOne(keeper, doomedId).expect(200);
    await revokeOne(keeper, doomedId).expect(200);
    await revokeOne(keeper, doomedId).expect(200);

    const rows = await h.prisma.platformAuditEvent.findMany({
      where: { action: 'SESSION_REVOKED', resourceId: doomedId },
    });
    expect(rows).toHaveLength(1);
  });

  it('requires the CSRF header', async () => {
    const email = await account();
    const doomed = await signIn(email, 'doomed/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const doomedId = await sessionIdOf(doomed);

    const response = await request(h.server)
      .delete(`/api/v1/auth/sessions/${doomedId}`)
      .set('Cookie', keeper.cookie)
      .expect(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses an id that is not a session id with a 400', async () => {
    const signed = await signIn(await account());
    const response = await revokeOne(signed, 'usr_01M0T74WZZFY9T2QS56RGF3GQ7').expect(400);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('revoking the CURRENT session signs the caller out and clears both cookies', async () => {
    const signed = await signIn(await account());
    const own = await sessionIdOf(signed);

    const response = await revokeOne(signed, own).expect(200);
    const cleared = setCookies(response);
    expect(cleared.some((value) => value.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true);
    expect(cleared.some((value) => value.startsWith(`${CSRF_COOKIE_NAME}=;`))).toBe(true);

    await request(h.server).get('/api/v1/auth/session').set('Cookie', signed.cookie).expect(401);
  });
});

describe('DELETE /api/v1/auth/sessions', () => {
  it('leaves exactly the current session live and revokes every other', async () => {
    const email = await account();
    const first = await signIn(email, 'device-one/1.0');
    const second = await signIn(email, 'device-two/1.0');
    const third = await signIn(email, 'device-three/1.0');

    const response = await revokeOthers(third).expect(200);
    expect(response.body).toEqual({ status: 'SESSIONS_REVOKED', revoked: 2 });

    await request(h.server).get('/api/v1/auth/session').set('Cookie', first.cookie).expect(401);
    await request(h.server).get('/api/v1/auth/session').set('Cookie', second.cookie).expect(401);
    await request(h.server).get('/api/v1/auth/session').set('Cookie', third.cookie).expect(200);

    const page = sessionCollectionSchema.parse((await list(third).expect(200)).body);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.current).toBe(true);
  });

  it('does not clear the caller’s cookies', async () => {
    const email = await account();
    await signIn(email, 'device-one/1.0');
    const keeper = await signIn(email, 'keeper/1.0');

    const response = await revokeOthers(keeper).expect(200);
    expect(setCookies(response)).toEqual([]);
  });

  it('answers 0 when there is nothing else to revoke, and writes no audit row', async () => {
    const only = await signIn(await account());
    const ownId = await sessionIdOf(only);

    const response = await revokeOthers(only).expect(200);
    expect(response.body).toEqual({ status: 'SESSIONS_REVOKED', revoked: 0 });

    const rows = await h.prisma.platformAuditEvent.findMany({
      where: { action: 'SESSION_REVOKED', resourceId: ownId },
    });
    expect(rows).toHaveLength(0);
  });

  it('writes one audit row for the whole bulk revocation, naming the surviving session', async () => {
    const email = await account();
    await signIn(email, 'device-one/1.0');
    await signIn(email, 'device-two/1.0');
    const keeper = await signIn(email, 'keeper/1.0');
    const keeperId = await sessionIdOf(keeper);

    await revokeOthers(keeper).expect(200);

    const rows = await h.prisma.platformAuditEvent.findMany({
      where: { action: 'SESSION_REVOKED', resourceId: keeperId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ revoked: 2, scope: 'others' });
  });

  it('requires the CSRF header', async () => {
    const signed = await signIn(await account());
    const response = await request(h.server)
      .delete('/api/v1/auth/sessions')
      .set('Cookie', signed.cookie)
      .expect(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('is refused without a session', async () => {
    await request(h.server).delete('/api/v1/auth/sessions').expect(401);
  });
});
