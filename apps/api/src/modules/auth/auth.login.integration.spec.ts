import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import request from 'supertest';
import { newId } from '@sentinel/db';
import { errorEnvelopeSchema, sessionResponseSchema } from '@sentinel/contracts';
import { type AuthHarness, clearRateLimits, startAuthHarness } from '../../testing/auth-harness.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.js';
import { deriveCsrfToken } from './csrf-token.js';
import { LOCKOUT_LADDER_SECONDS } from './lockout.js';
import { sessionCacheKey } from './session.service.js';
import { hashSecretToken } from './secret-token.js';

/**
 * LOGIN, LOGOUT AND THE SESSION ENDPOINT, DRIVEN THROUGH THE REAL APPLICATION.
 *
 * Real Postgres (Testcontainers, migrated), real Redis (compose), the real
 * `AppModule` and the real `configureApp` — so every guard in
 * `architecture/backend.md` §3's pipeline is in front of these routes, in the
 * order `app.module.spec.ts` pins.
 *
 * What is here and not in the unit lane is everything a fake would have made
 * true by construction: that the counter survives in a column rather than in a
 * closure, that the audit row lands in the append-only table, that the cookie
 * attributes reach a real `Set-Cookie` header, that the cache tombstone makes
 * revocation immediate, and — the two that matter most — that `CsrfGuard`
 * governs a real cookie-authenticated route for the first time, and that the
 * `Organization` lookup works over the **least-privileged database role** that
 * production actually uses.
 */

const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';

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
  return `login-${String(counter)}-${String(Date.now())}@example.test`;
};

/**
 * Registers and confirms an account, through the real endpoints.
 *
 * Confirmed by writing `emailVerifiedAt` directly rather than by redeeming the
 * link: the redemption path is `auth.verification.integration.spec.ts`'s and
 * repeating it here would make every test in this file depend on a second
 * endpoint's behaviour.
 */
async function account(options: { verified?: boolean } = {}): Promise<string> {
  const email = freshAddress();
  await clearRateLimits(h.redis);
  await request(h.server).post('/api/v1/auth/register').send({ email, password: PASSWORD });
  if (options.verified !== false) {
    await h.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  }
  h.sent.length = 0;
  return email;
}

/** One login, with the windows cleared first so the limiter is never the reason. */
async function login(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  await clearRateLimits(h.redis);
  const call = request(h.server).post('/api/v1/auth/login');
  for (const [name, value] of Object.entries(headers)) call.set(name, value);
  return call.send(body);
}

const setCookies = (response: Response): string[] => {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
};

const cookieNamed = (response: Response, name: string): string | undefined =>
  setCookies(response).find((value) => value.startsWith(`${name}=`));

const valueOf = (cookie: string): string =>
  cookie.slice(cookie.indexOf('=') + 1).split(';')[0] ?? '';

/** The `Cookie` header a browser would send back after a successful login. */
function cookieHeader(response: Response): string {
  const session = cookieNamed(response, SESSION_COOKIE_NAME);
  const csrf = cookieNamed(response, CSRF_COOKIE_NAME);
  if (session === undefined || csrf === undefined) throw new Error('login set no cookies');
  return `${SESSION_COOKIE_NAME}=${valueOf(session)}; ${CSRF_COOKIE_NAME}=${valueOf(csrf)}`;
}

async function platformEvents(resourceId: string | null, action?: string) {
  return h.prisma.platformAuditEvent.findMany({
    where: {
      ...(resourceId === null ? {} : { resourceId }),
      ...(action === undefined ? {} : { action }),
    },
    orderBy: { createdAt: 'asc' },
  });
}

describe('POST /auth/login — the success path', () => {
  it('answers 200 { mfaRequired: false } and sets both cookies', async () => {
    const email = await account();
    const response = await login({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mfaRequired: false });

    const session = cookieNamed(response, SESSION_COOKIE_NAME);
    const csrf = cookieNamed(response, CSRF_COOKIE_NAME);
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();

    // THE ATTRIBUTES `cookies.spec.ts` PINS, ASSERTED ON A REAL HEADER. That
    // file proves the serialiser; this proves the serialiser's output survives
    // Express, the interceptor and the filter unchanged.
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      expect(session, attribute).toContain(attribute);
    }
    // The CSRF cookie is the session cookie's attributes MINUS `HttpOnly`, and
    // the omission is the mechanism: page script has to read the value to echo
    // it in `X-CSRF-Token`.
    expect(csrf).not.toContain('HttpOnly');
    for (const attribute of ['Secure', 'SameSite=Lax', 'Path=/']) {
      expect(csrf, attribute).toContain(attribute);
    }
    // Neither carries a `Domain`, which a browser requires of a `__Host-` cookie
    // and silently drops the cookie over.
    expect(session).not.toContain('Domain');
    expect(csrf).not.toContain('Domain');
  });

  it('derives the CSRF cookie from the session token rather than storing one', async () => {
    // `csrf-token.ts`'s design, visible on the wire: the value in the second
    // cookie is an HMAC keyed by the value in the first. Nothing in the database
    // holds it, so a rotation cannot forget to rotate it.
    const email = await account();
    const response = await login({ email, password: PASSWORD });

    const sessionToken = valueOf(cookieNamed(response, SESSION_COOKIE_NAME) ?? '');
    const csrfValue = valueOf(cookieNamed(response, CSRF_COOKIE_NAME) ?? '');
    expect(csrfValue).toBe(deriveCsrfToken(sessionToken));
  });

  it('writes an ACTIVE session row whose token hash matches the cookie', async () => {
    const email = await account();
    const response = await login({ email, password: PASSWORD });
    const sessionToken = valueOf(cookieNamed(response, SESSION_COOKIE_NAME) ?? '');

    const row = await h.prisma.session.findUnique({
      where: { tokenHash: hashSecretToken(sessionToken) },
    });
    expect(row?.status).toBe('ACTIVE');
    expect(row?.revokedAt).toBeNull();
    expect(row?.mfaCompletedAt).toBeNull();
    // The RAW token is nowhere in the row. `secret-token.ts`'s promise, checked
    // against a real row rather than against the function that wrote it.
    expect(JSON.stringify(row)).not.toContain(sessionToken);
  });

  it('resets the failure counter, clears the lock and stamps lastLoginAt', async () => {
    const email = await account();
    await h.prisma.user.update({
      where: { email },
      data: { failedLoginCount: 3, lockedUntil: new Date(Date.now() - 60_000) },
    });

    await login({ email, password: PASSWORD });

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('writes exactly one LOGIN platform audit row', async () => {
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await login({ email, password: PASSWORD });

    const events = await platformEvents(user.id, 'LOGIN');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'USER',
      actorId: user.id,
      resourceType: 'User',
      resourceId: user.id,
    });
    // No password and no session token anywhere in the row.
    expect(JSON.stringify(events[0])).not.toContain(PASSWORD);
  });

  it('sends the new-device notice, and nothing else', async () => {
    const email = await account();
    h.sent.length = 0;
    await login({ email, password: PASSWORD });
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['newDeviceSignIn']);
  });

  it('does not send it a second time from the same IP and user agent', async () => {
    const email = await account();
    await login({ email, password: PASSWORD }, { 'User-Agent': 'FIXTURE-agent/1.0' });
    h.sent.length = 0;
    await login({ email, password: PASSWORD }, { 'User-Agent': 'FIXTURE-agent/1.0' });
    expect(h.sent).toEqual([]);
  });

  it('does not send it to an address whose ownership has not been proven', async () => {
    const email = await account({ verified: false });
    h.sent.length = 0;
    await login({ email, password: PASSWORD });
    expect(h.sent).toEqual([]);
  });
});

describe('POST /auth/login — rememberMe', () => {
  it('true produces the 30-day absolute expiry and a cookie carrying Max-Age', async () => {
    // Carry-forward ruling 49: the assertion is against a FIXED instant taken
    // before the request, not against a second clock reading. A mutant that
    // handed back the 7-day lifetime is 23 days away and cannot land inside the
    // tolerance.
    const email = await account();
    const before = Date.now();
    const response = await login({ email, password: PASSWORD, rememberMe: true });

    const cookie = cookieNamed(response, SESSION_COOKIE_NAME) ?? '';
    expect(cookie).toContain('Max-Age=');

    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(valueOf(cookie)) },
    });
    expect(row.rememberMe).toBe(true);
    const days = (row.absoluteExpiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('absent produces 7 days and a browser-session cookie with no Max-Age', async () => {
    const email = await account();
    const before = Date.now();
    const response = await login({ email, password: PASSWORD });

    const cookie = cookieNamed(response, SESSION_COOKIE_NAME) ?? '';
    // No `Max-Age` and no `Expires` — the cookie is discarded when the browser
    // closes, which is the honest rendering of "you did not ask to be
    // remembered". `cookies.ts` explains why the cookie is never the authority.
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
    expect(cookieNamed(response, CSRF_COOKIE_NAME)).not.toContain('Max-Age');

    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(valueOf(cookie)) },
    });
    expect(row.rememberMe).toBe(false);
    const days = (row.absoluteExpiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('refuses a non-boolean rememberMe at the boundary', async () => {
    const email = await account();
    const response = await login({ email, password: PASSWORD, rememberMe: 'true' });
    expect(response.status).toBe(400);
  });
});

describe('POST /auth/login — a wrong password', () => {
  it('answers 401 INVALID_CREDENTIALS with no Set-Cookie at all', async () => {
    const email = await account();
    const response = await login({ email, password: WRONG });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_CREDENTIALS');
    expect(setCookies(response)).toEqual([]);
  });

  it('increments the counter and writes one LOGIN_FAILED row naming the account', async () => {
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await login({ email, password: WRONG });

    expect((await h.prisma.user.findUniqueOrThrow({ where: { email } })).failedLoginCount).toBe(1);

    const events = await platformEvents(user.id, 'LOGIN_FAILED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, resourceId: user.id });
  });

  it('writes a LOGIN_FAILED row for an address with no account, naming nothing', async () => {
    // The event Task 8 could not write. `security/audit.md` §3 requires it, and
    // without it a credential-stuffing sweep across addresses that are not
    // customers leaves no trace at all.
    const unknown = `never-registered-${String(Date.now())}@example.test`;
    const before = await h.prisma.platformAuditEvent.count({
      where: { action: 'LOGIN_FAILED', resourceId: null },
    });

    await login({ email: unknown, password: PASSWORD });

    const after = await h.prisma.platformAuditEvent.findMany({
      where: { action: 'LOGIN_FAILED', resourceId: null },
    });
    expect(after.length).toBe(before + 1);
    // The attempted address is nowhere in it. D5.
    expect(JSON.stringify(after)).not.toContain(unknown);
  });
});

describe('POST /auth/login — the lockout ladder', () => {
  /** Fails `times` times, clearing the limiter between attempts. */
  async function failTimes(email: string, times: number): Promise<void> {
    for (let attempt = 0; attempt < times; attempt += 1) {
      const response = await login({ email, password: WRONG });
      expect(response.status).toBe(401);
    }
  }

  it('locks on the fifth consecutive failure, for the first rung of the ladder', async () => {
    const email = await account();
    const before = Date.now();
    await failTimes(email, 5);

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(5);
    expect(user.lockedUntil).not.toBeNull();
    const seconds = ((user.lockedUntil?.getTime() ?? 0) - before) / 1000;
    expect(seconds).toBeGreaterThan(LOCKOUT_LADDER_SECONDS[0] - 30);
    expect(seconds).toBeLessThan(LOCKOUT_LADDER_SECONDS[0] + 30);
  });

  it('writes one ACCOUNT_LOCKED row and sends the burst notice once', async () => {
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    h.sent.length = 0;

    await failTimes(email, 5);
    // Three more attempts while the lock is live.
    await failTimes(email, 3);

    expect(await platformEvents(user.id, 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['failedLoginBurst']);
  });

  it('answers 403 ACCOUNT_LOCKED to a CORRECT password while locked', async () => {
    // D3, and `api/authentication.md` §6's 403 rather than 401.
    const email = await account();
    await failTimes(email, 5);

    const response = await login({ email, password: PASSWORD });
    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('ACCOUNT_LOCKED');
    expect(setCookies(response)).toEqual([]);
  });

  it('answers 401 INVALID_CREDENTIALS to a WRONG password while locked', async () => {
    const email = await account();
    await failTimes(email, 5);

    const response = await login({ email, password: WRONG });
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('does not extend the lock, or the counter, while the lock is live', async () => {
    // D2's rule, and the reason for it: otherwise an attacker keeps an account
    // offline forever by attempting once a minute.
    const email = await account();
    await failTimes(email, 5);
    const locked = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await failTimes(email, 4);
    await login({ email, password: PASSWORD });

    const after = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.lockedUntil?.getTime()).toBe(locked.lockedUntil?.getTime());
    expect(after.failedLoginCount).toBe(locked.failedLoginCount);
  });

  it('lets a correct password through once the window has passed, and clears the counter', async () => {
    // The window is moved into the past rather than waited out: a spec that
    // slept for a minute would be a spec nobody runs, and the property under
    // test is that an EXPIRED lock stops applying, not that time passes.
    const email = await account();
    await failTimes(email, 5);
    await h.prisma.user.update({
      where: { email },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });

    const response = await login({ email, password: PASSWORD });
    expect(response.status).toBe(200);

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it('climbs to the next rung across cycles, because only a success resets the counter', async () => {
    const email = await account();
    await failTimes(email, 5);
    await h.prisma.user.update({
      where: { email },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });

    const before = Date.now();
    await failTimes(email, 1);

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(6);
    const seconds = ((user.lockedUntil?.getTime() ?? 0) - before) / 1000;
    expect(seconds).toBeGreaterThan(LOCKOUT_LADDER_SECONDS[1] - 30);
    expect(seconds).toBeLessThan(LOCKOUT_LADDER_SECONDS[1] + 30);
  });
});

describe('POST /auth/login — the per-account and per-IP windows bite independently', () => {
  it('refuses a sixth attempt on one address while another address still works', async () => {
    // §7's ACTUAL property, and the reason `rate-limit.config.ts` carries a
    // `{ bodyField }` principal source at all: one attacker guessing at one
    // address must not consume the budget of everybody behind the same egress
    // address. Both requests below come from the same loopback IP, so the only
    // thing that can distinguish them is the per-account key.
    //
    // No `clearRateLimits` inside this test — the limiter IS the subject.
    const victim = await account();
    const bystander = await account();
    await clearRateLimits(h.redis);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(h.server)
        .post('/api/v1/auth/login')
        .send({ email: victim, password: WRONG });
      statuses.push(response.status);
    }
    // 5 per 15 minutes per account: five refusals, then the limiter.
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

    // The bystander's account is untouched — the per-account window is keyed on
    // the address, and the shared per-IP window (20 / 15 min) still has room.
    const other = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email: bystander, password: PASSWORD });
    expect(other.status).toBe(200);
  });

  it('refuses on the per-IP window even across many different addresses', async () => {
    // The other half. Twenty attempts per fifteen minutes per IP, spread over
    // twenty different addresses so no per-account window is ever reached — the
    // per-IP limit is the only thing that can stop it.
    await clearRateLimits(h.redis);

    let refusedAt = -1;
    for (let attempt = 0; attempt < 22; attempt += 1) {
      const response = await request(h.server)
        .post('/api/v1/auth/login')
        .send({
          email: `sweep-${String(attempt)}-${String(Date.now())}@example.test`,
          password: WRONG,
        });
      if (response.status === 429) {
        refusedAt = attempt;
        break;
      }
    }
    expect(refusedAt).toBe(20);
  });
});

describe('POST /auth/login — the cross-site refusal', () => {
  it('refuses Sec-Fetch-Site: cross-site with 403 CSRF_TOKEN_INVALID', async () => {
    const email = await account();
    const response = await login({ email, password: PASSWORD }, { 'Sec-Fetch-Site': 'cross-site' });

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
    expect(setCookies(response)).toEqual([]);
  });

  it('refuses a foreign Origin with the same 403', async () => {
    const email = await account();
    const response = await login({ email, password: PASSWORD }, { Origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('succeeds with neither header — a non-browser client is not the threat', async () => {
    // The anti-vacuity half: every other test in this file sends neither
    // header, so if absence were refused nothing here would pass. Asserted
    // explicitly anyway, because the day somebody "hardens" this by refusing on
    // absence, this is the test that says what it costs.
    const email = await account();
    expect((await login({ email, password: PASSWORD })).status).toBe(200);
  });

  it('does not refuse a cross-site POST to register — the Task 8 routes are not covered', async () => {
    // Stated as a test rather than as a comment. `@RefuseCrossSite()` is opt-in
    // per handler, and `auth.controller.ts` argues why registration,
    // verification and resend are deliberately reachable cross-site. If that
    // ever changes it should change deliberately, with this test going red.
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/register')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: freshAddress(), password: PASSWORD });
    expect(response.status).toBe(200);
  });
});

describe('POST /auth/login — an account with a confirmed MFA factor', () => {
  async function withFactor(): Promise<string> {
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    await h.prisma.mfaFactor.create({
      data: {
        id: newId('mfa'),
        userId: user.id,
        type: 'TOTP',
        // A fixture, and deliberately not a credential-shaped string:
        // `pnpm check:secrets` reads committed files.
        secretEncrypted: 'FIXTURE-not-a-real-encrypted-secret',
        confirmedAt: new Date(),
      },
    });
    return email;
  }

  it('answers mfaRequired: true with a pending token and NO Set-Cookie', async () => {
    const email = await withFactor();
    const response = await login({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mfaRequired: true });
    expect(typeof (response.body as { pendingToken?: unknown }).pendingToken).toBe('string');
    expect(setCookies(response)).toEqual([]);
  });

  it('writes a PENDING_MFA session row with no mfaCompletedAt', async () => {
    const email = await withFactor();
    const response = await login({ email, password: PASSWORD });
    const pendingToken = (response.body as { pendingToken: string }).pendingToken;

    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(pendingToken) },
    });
    expect(row.status).toBe('PENDING_MFA');
    expect(row.mfaCompletedAt).toBeNull();
  });

  it('does NOT gate on an unconfirmed factor', async () => {
    // Carry-forward ruling 7: an abandoned enrolment occupies the
    // `(userId, type)` unique slot, so the row exists. Gating on it would lock
    // a user out behind a code nobody has.
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    await h.prisma.mfaFactor.create({
      data: {
        id: newId('mfa'),
        userId: user.id,
        type: 'TOTP',
        secretEncrypted: 'FIXTURE-not-a-real-encrypted-secret',
        confirmedAt: null,
      },
    });

    const response = await login({ email, password: PASSWORD });
    expect(response.body).toEqual({ mfaRequired: false });
  });

  it('the pending session cannot reach GET /auth/session', async () => {
    // D9's other half: the refusal is what stops the pending credential being a
    // session. `AuthenticationGuard` reads the cookie, and this token is not in
    // one — so this asserts the refusal through the only door it could use.
    const email = await withFactor();
    const response = await login({ email, password: PASSWORD });
    const pendingToken = (response.body as { pendingToken: string }).pendingToken;

    const probe = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${pendingToken}`);

    expect(probe.status).toBe(401);
    expect(errorEnvelopeSchema.parse(probe.body).error.code).toBe('MFA_REQUIRED');
  });
});

describe('POST /auth/logout', () => {
  it('answers 204, clears both cookies, and revokes the row', async () => {
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });
    const cookies = cookieHeader(signedIn);
    const sessionToken = valueOf(cookieNamed(signedIn, SESSION_COOKIE_NAME) ?? '');

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', deriveCsrfToken(sessionToken))
      .send({});

    expect(response.status).toBe(204);
    expect(response.text).toBe('');

    const cleared = setCookies(response);
    expect(cleared.some((value) => value.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true);
    expect(cleared.some((value) => value.startsWith(`${CSRF_COOKIE_NAME}=;`))).toBe(true);
    for (const value of cleared) expect(value).toContain('Max-Age=0');

    // REVOKED, NOT DELETED. D7: the row is the forensic record that the session
    // existed, and `/settings/security` reads `revokedAt`.
    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(sessionToken) },
    });
    expect(row.revokedAt).not.toBeNull();
  });

  it('tombstones the cache entry, so the next request is refused immediately', async () => {
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });
    const sessionToken = valueOf(cookieNamed(signedIn, SESSION_COOKIE_NAME) ?? '');

    // Warm the cache first, so the tombstone has something to overwrite —
    // otherwise this passes for the trivial reason that nothing was cached.
    await clearRateLimits(h.redis);
    await request(h.server).get('/api/v1/auth/session').set('Cookie', cookieHeader(signedIn));

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader(signedIn))
      .set('X-CSRF-Token', deriveCsrfToken(sessionToken))
      .send({});

    const cached = await h.redis.get(sessionCacheKey(hashSecretToken(sessionToken)));
    expect(cached).toBe('revoked');

    await clearRateLimits(h.redis);
    const after = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', cookieHeader(signedIn));
    expect(after.status).toBe(401);
    expect(errorEnvelopeSchema.parse(after.body).error.code).toBe('SESSION_EXPIRED');
  });

  it('writes one LOGOUT row naming the SESSION', async () => {
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });
    const sessionToken = valueOf(cookieNamed(signedIn, SESSION_COOKIE_NAME) ?? '');
    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(sessionToken) },
    });

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader(signedIn))
      .set('X-CSRF-Token', deriveCsrfToken(sessionToken))
      .send({});

    const events = await platformEvents(row.id, 'LOGOUT');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'USER',
      actorId: row.userId,
      resourceType: 'Session',
      resourceId: row.id,
    });
  });

  it('is 403 CSRF_TOKEN_INVALID without X-CSRF-Token', async () => {
    // THE FIRST COOKIE-AUTHENTICATED ROUTE `CsrfGuard` HAS EVER GOVERNED.
    // Every assertion that guard has had until now was against a fixture
    // controller (carry-forward ruling 58's shape), so this is where we learn
    // it works on a real route rather than on a test double.
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader(signedIn))
      .send({});

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');

    // And nothing was revoked by the refused request.
    const sessionToken = valueOf(cookieNamed(signedIn, SESSION_COOKIE_NAME) ?? '');
    const row = await h.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(sessionToken) },
    });
    expect(row.revokedAt).toBeNull();
  });

  it('is 403 with a CSRF token derived from a DIFFERENT session', async () => {
    // The comparison is against the value derived from THIS session's token,
    // not against whatever is in the `__Host-csrf` cookie — which is the
    // strengthening over plain double-submit that `csrf.guard.ts` describes.
    const first = await login({ email: await account(), password: PASSWORD });
    const second = await login({ email: await account(), password: PASSWORD });
    const otherToken = valueOf(cookieNamed(second, SESSION_COOKIE_NAME) ?? '');

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieHeader(first))
      .set('X-CSRF-Token', deriveCsrfToken(otherToken))
      .send({});

    expect(response.status).toBe(403);
  });

  it('is 401 with no cookie at all', async () => {
    await clearRateLimits(h.redis);
    const response = await request(h.server).post('/api/v1/auth/logout').send({});
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /auth/session', () => {
  it('is 401 UNAUTHENTICATED with no cookie', async () => {
    await clearRateLimits(h.redis);
    const response = await request(h.server).get('/api/v1/auth/session');
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the document for a live session', async () => {
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', cookieHeader(signedIn));

    expect(response.status).toBe(200);
    const document = sessionResponseSchema.parse(response.body);
    expect(document).toEqual({
      userId: user.id,
      activeOrganization: null,
      // Genuinely empty: there is no role assignment until Task 12. D8.
      permissions: [],
      entitlements: {},
    });
    // The session identifier is NOT on the wire.
    expect(JSON.stringify(response.body)).not.toContain('ses_');
  });

  it('resolves a real organisation when the session names one', async () => {
    // THE NON-NULL ARM, WHICH NO SESSION THIS PHASE CAN CREATE WOULD REACH.
    // Nothing writes `Session.activeOrganizationId` until Task 13, so the
    // column is set here directly — an unexercised lookup is one Task 13 has to
    // discover is missing, and it would discover it as a `null` that looks
    // exactly like "no organisation chosen".
    const email = await account();
    const signedIn = await login({ email, password: PASSWORD });
    const sessionToken = valueOf(cookieNamed(signedIn, SESSION_COOKIE_NAME) ?? '');

    const organizationId = newId('org');
    await h.prisma.organization.create({
      data: { id: organizationId, slug: `probe-${organizationId}`, name: 'Probe Organisation' },
    });
    await h.prisma.session.update({
      where: { tokenHash: hashSecretToken(sessionToken) },
      data: { activeOrganizationId: organizationId },
    });
    // The cache holds a snapshot with the old column; the lookup reads the row,
    // so poison the entry rather than asserting against a stale one.
    await h.redis.del(sessionCacheKey(hashSecretToken(sessionToken)));

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', cookieHeader(signedIn));

    expect(response.status).toBe(200);
    expect(sessionResponseSchema.parse(response.body).activeOrganization).toEqual({
      id: organizationId,
      slug: `probe-${organizationId}`,
      name: 'Probe Organisation',
    });
  });

  it('reads that organisation over the least-privileged role, not the owner', async () => {
    // THE MEASUREMENT THAT MAKES THE TEST ABOVE MEAN ANYTHING.
    //
    // The harness's main client is the container owner, a superuser that
    // bypasses row-level security — so the test above would pass over a lookup
    // that returns `null` in production. `Organization` carries FORCE RLS keyed
    // on `id`, and the API connects as `sentinel_app`. This asserts both halves
    // directly: invisible without `app.organization_id`, visible with it, which
    // is precisely what `withTenantTransaction` sets.
    const organizationId = newId('org');
    await h.prisma.organization.create({
      data: { id: organizationId, slug: `rls-${organizationId}`, name: 'RLS Probe' },
    });

    const blind = await h.appPrisma.organization.findMany({ where: { id: organizationId } });
    expect(blind).toEqual([]);

    const scoped = await h.appPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      return tx.organization.findMany({ where: { id: organizationId } });
    });
    expect(scoped).toHaveLength(1);
  });
});
