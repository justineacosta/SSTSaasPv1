import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import request from 'supertest';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import {
  type AuthHarness,
  clearRateLimits,
  startAuthHarness,
  tokenFromMail,
} from '../../testing/auth-harness.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.js';
import { deriveCsrfToken } from './csrf-token.js';
import { hashSecretToken } from './secret-token.js';

/**
 * PASSWORD RESET AND PASSWORD CHANGE, DRIVEN THROUGH THE REAL APPLICATION.
 *
 * Real Postgres (Testcontainers, migrated), real Redis (compose), the real
 * `AppModule` and the real `configureApp` — so every guard in
 * `architecture/backend.md` §3's pipeline sits in front of these routes.
 *
 * What is here and not in the unit lane is everything a fake would have made
 * true by construction:
 *
 * - **Concurrency.** Carry-forward ruling 74: Task 9's lockout ladder was green
 *   over a control that did not engage, because every test of it was
 *   sequential. Two change-password requests in one `Promise.all` against the
 *   same account, and two redemptions of one reset token in one `Promise.all`,
 *   are the probes that can see D3's compare-and-swap and the token's
 *   single-use property actually arbitrate. A sequential version of either
 *   passes over a broken implementation.
 * - **The D2 ordering, end to end.** A login racing a completed reset must not
 *   mint a session with the old password. The unit lane asserts the call order;
 *   this asserts the outcome against a real credential row.
 * - **Revocation scope**, against real `Session` rows and a real Redis
 *   tombstone rather than a recorded call.
 * - **The cross-site guard on the SHIPPED routes** (D6), which is the assertion
 *   ruling 64 exists for — `auth.controller.spec.ts` proves the decorator is
 *   present, and this proves it does something.
 */

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new correct horse battery staple';

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
  return `pw-${String(counter)}-${String(Date.now())}@example.test`;
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

/** Registers and confirms an account through the real endpoints. */
async function account(): Promise<string> {
  const email = freshAddress();
  await clearRateLimits(h.redis);
  await request(h.server).post('/api/v1/auth/register').send({ email, password: PASSWORD });
  await h.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  h.sent.length = 0;
  return email;
}

/** One real login, returning what a browser would send back. */
async function signIn(email: string, password = PASSWORD): Promise<Signed> {
  await clearRateLimits(h.redis);
  const response = await request(h.server)
    .post('/api/v1/auth/login')
    .send({ email, password, rememberMe: true });
  const session = cookieNamed(response, SESSION_COOKIE_NAME);
  const csrf = cookieNamed(response, CSRF_COOKIE_NAME);
  if (session === undefined || csrf === undefined) {
    throw new Error(`login did not set cookies (status ${String(response.status)})`);
  }
  const sessionToken = valueOf(session);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${valueOf(csrf)}`,
    csrf: valueOf(csrf),
    sessionToken,
  };
}

/** Asks for a reset link and returns the raw token out of the delivered mail. */
async function resetTokenFor(email: string): Promise<string> {
  await clearRateLimits(h.redis);
  h.sent.length = 0;
  await request(h.server).post('/api/v1/auth/forgot-password').send({ email });
  return tokenFromMail(h.sent.at(-1));
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

const liveSessions = async (email: string) =>
  h.prisma.session.findMany({ where: { user: { email }, revokedAt: null } });

describe('POST /auth/forgot-password', () => {
  it('sends a reset link and writes one PASSWORD_RESET_REQUESTED row', async () => {
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    const response = await request(h.server).post('/api/v1/auth/forgot-password').send({ email });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'RESET_REQUESTED' });
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['passwordReset']);
    expect(await platformEvents(user.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
  });

  it('stores only the HASH of the token, never the token itself', async () => {
    // Critical security rule 5. The raw value exists in the mail and nowhere
    // else — not in the row, not in the audit event.
    const email = await account();
    const token = await resetTokenFor(email);

    const row = await h.prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(token) },
    });
    expect(row.purpose).toBe('PASSWORD_RESET');
    expect(row.consumedAt).toBeNull();

    const events = await platformEvents(row.userId, 'PASSWORD_RESET_REQUESTED');
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('supersedes the previous link, so only the newest one works', async () => {
    // `TokenService.issueInTransaction` supersedes under an advisory lock
    // before inserting, and since Task 8 the partial unique index makes it the
    // database's invariant too. Asserted rather than assumed.
    const email = await account();
    const first = await resetTokenFor(email);
    const second = await resetTokenFor(email);
    expect(second).not.toBe(first);

    await clearRateLimits(h.redis);
    const stale = await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token: first, password: NEW_PASSWORD });

    expect(stale.status).toBe(422);
    expect(errorEnvelopeSchema.parse(stale.body).error.code).toBe('TOKEN_INVALID');
  });

  it('writes a row naming nothing for an address with no account, and sends nothing', async () => {
    const unknown = `never-registered-${String(Date.now())}@example.test`;
    const before = await h.prisma.platformAuditEvent.count({
      where: { action: 'PASSWORD_RESET_REQUESTED', resourceId: null },
    });

    const response = await request(h.server)
      .post('/api/v1/auth/forgot-password')
      .send({ email: unknown });

    expect(response.status).toBe(200);
    expect(h.sent).toEqual([]);
    expect(
      await h.prisma.platformAuditEvent.count({
        where: { action: 'PASSWORD_RESET_REQUESTED', resourceId: null },
      }),
    ).toBe(before + 1);
  });

  it('sends nothing for a DISABLED account but still writes the row', async () => {
    const email = await account();
    await h.prisma.user.update({ where: { email }, data: { status: 'DISABLED' } });
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await request(h.server).post('/api/v1/auth/forgot-password').send({ email });

    expect(h.sent).toEqual([]);
    expect(await platformEvents(user.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
  });
});

describe('POST /auth/reset-password', () => {
  it('replaces the password: the new one signs in and the old one does not', async () => {
    const email = await account();
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'PASSWORD_RESET' });
    // NO cookie at all — the reset does not sign anybody in.
    expect(setCookies(response)).toEqual([]);

    await clearRateLimits(h.redis);
    const withNew = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    await clearRateLimits(h.redis);
    const withOld = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it('MEASURED: a login already in flight can outlive the reset — the residual D2 narrows but does not close', async () => {
    // THIS TEST RECORDS A RESIDUAL RATHER THAN ASSERTING IT AWAY, and finding
    // it is the reason it has to be a race (carry-forward ruling 74). The
    // sequential version — fire the logins after the reset returns — passes
    // under BOTH orderings and shows nothing.
    //
    // **The brief's D2 and `SessionService.revokeAllForUser`'s own docblock
    // both overstate what the ordering buys.** They say writing the hash first
    // means "a racing login cannot mint a session with the old credential once
    // this call has finished". What is actually true is narrower:
    //
    // - A login that STARTS after the reset commits reads the new credential
    //   and fails. That is what committing the hash first buys, and it holds.
    // - A login already IN FLIGHT — one that read the old credential before the
    //   write committed — verifies successfully against the value it read, and
    //   inserts its `Session` row whenever its ~40 ms Argon2 verification
    //   finishes. If that lands after `revokeAllForUser` has run, the row is
    //   never swept: `revokeLiveForUser` is one `updateMany` evaluated at
    //   execution time and cannot revoke a row that does not exist yet
    //   (carry-forward ruling 51 names exactly this boundary).
    //
    // Measured here on the first run of this test: five old-password logins
    // fired alongside the reset left **one** live session behind.
    //
    // The ordering is still strictly better than the alternative, which is why
    // D2 is implemented as written. Under revoke-then-write the vulnerable
    // window is every login in flight from the revocation onwards; under
    // write-then-revoke it is only a login whose verification straddles the
    // commit-to-revoke interval, which is a few milliseconds rather than the
    // whole request.
    //
    // What the test asserts is therefore the two things that ARE true, and the
    // residual is named in `security/authentication.md` §6 and in this task's
    // report rather than left for someone to rediscover.
    const email = await account();
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    const [reset] = await Promise.all([
      request(h.server).post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }),
      ...Array.from({ length: 5 }, () =>
        request(h.server).post('/api/v1/auth/login').send({ email, password: PASSWORD }),
      ),
    ]);

    // 1. The reset committed exactly once, whatever the interleaving.
    expect(reset.status).toBe(200);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await platformEvents(user.id, 'PASSWORD_RESET_COMPLETED')).toHaveLength(1);

    // 2. The credential really changed: no login STARTED from here on can use
    //    the old password. This is the guarantee the ordering delivers, and it
    //    is the one a user is actually promised.
    await clearRateLimits(h.redis);
    const withOld = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(withOld.status).toBe(401);

    await clearRateLimits(h.redis);
    const withNew = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);
  });

  it('revokes every session that existed when the credential committed', async () => {
    // The other half of the pair above, with no race in it: a session held
    // BEFORE the reset starts is always swept, because it exists when
    // `revokeLiveForUser` evaluates its predicate. That is the property the
    // residual above does not touch, and it is the one that matters for the
    // case the endpoint exists for — an attacker sitting in the account when
    // its owner resets the password.
    const email = await account();
    const attacker = await signIn(email);
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });

    expect(await liveSessions(email)).toHaveLength(0);
    await clearRateLimits(h.redis);
    const after = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', attacker.cookie);
    expect(after.status).toBe(401);
  });

  it('lets EXACTLY ONE of two parallel redemptions of the same token succeed', async () => {
    // Carry-forward ruling 74, and the property that matters most on this
    // endpoint: a reset link that redeems twice is an account takeover, not an
    // untidiness. The arbitration is `TokenService.consume`'s single
    // conditional `UPDATE`, which no sequential test can distinguish from a
    // `SELECT` followed by an `update`.
    const email = await account();
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    const responses = await Promise.all([
      request(h.server).post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }),
      request(h.server)
        .post('/api/v1/auth/reset-password')
        .send({ token, password: 'a different new password entirely' }),
    ]);

    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 422]);

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await platformEvents(user.id, 'PASSWORD_RESET_COMPLETED')).toHaveLength(1);
  });

  it('refuses a LOCKED account and does NOT burn the link', async () => {
    // D4 and carry-forward ruling 37, against real rows: the refusal rolls the
    // redemption back, so the same link works once an administrator unlocks the
    // account. A burn-and-refuse implementation passes the first assertion and
    // fails the second.
    const email = await account();
    const token = await resetTokenFor(email);
    await h.prisma.user.update({ where: { email }, data: { status: 'LOCKED' } });

    await clearRateLimits(h.redis);
    const refused = await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(refused.status).toBe(422);
    expect(errorEnvelopeSchema.parse(refused.body).error.code).toBe('TOKEN_INVALID');

    // The token row is still live — the rollback undid the redemption.
    const row = await h.prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(token) },
    });
    expect(row.consumedAt).toBeNull();

    await h.prisma.user.update({ where: { email }, data: { status: 'ACTIVE' } });
    await clearRateLimits(h.redis);
    const accepted = await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
  });

  it('writes one PASSWORD_RESET_COMPLETED row with no secret in it', async () => {
    const email = await account();
    const attacker = await signIn(email);
    void attacker;
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    const rows = await platformEvents(user.id, 'PASSWORD_RESET_COMPLETED');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe('USER');
    expect((rows[0]?.metadata as { liveSessionsAtWrite?: number }).liveSessionsAtWrite).toBe(1);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain('$argon2id$');
  });

  it('sends the password-changed notice', async () => {
    const email = await account();
    const token = await resetTokenFor(email);
    h.sent.length = 0;

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });

    expect(h.sent.map((mail) => mail.templateId)).toEqual(['passwordChanged']);
    // Ruling 70, closed: no stored display name reaches the body, and the
    // notice carries no link at all.
    const notice = h.sent[0];
    expect(notice?.text).not.toMatch(/https?:\/\//);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password, rotates this session and revokes the others', async () => {
    // D2's second half, against real rows.
    const email = await account();
    const first = await signIn(email);
    const second = await signIn(email);
    expect(await liveSessions(email)).toHaveLength(2);

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/change-password')
      .set('Cookie', second.cookie)
      .set('X-CSRF-Token', second.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'PASSWORD_CHANGED' });

    // Exactly one live session: the rotated successor. The predecessor is
    // revoked by the rotation, and the other session by the bulk revoke.
    const live = await liveSessions(email);
    expect(live).toHaveLength(1);
    expect(live[0]?.rotatedFromId).not.toBeNull();

    // The caller's OWN session keeps working, on the new cookie.
    const rotatedSession = cookieNamed(response, SESSION_COOKIE_NAME);
    const rotatedCsrf = cookieNamed(response, CSRF_COOKIE_NAME);
    expect(rotatedSession).toBeDefined();
    expect(rotatedCsrf).toBeDefined();
    const rotatedToken = valueOf(rotatedSession ?? '');
    expect(rotatedToken).not.toBe(second.sessionToken);
    // The CSRF cookie is derived from the session token rather than stored, so
    // it rotates with it — the reason a rotation here does not leave a
    // signed-in user unable to submit a form.
    expect(valueOf(rotatedCsrf ?? '')).toBe(deriveCsrfToken(rotatedToken));

    await clearRateLimits(h.redis);
    const stillIn = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${rotatedToken}`);
    expect(stillIn.status).toBe(200);

    // The OTHER session is gone, immediately.
    await clearRateLimits(h.redis);
    const evicted = await request(h.server).get('/api/v1/auth/session').set('Cookie', first.cookie);
    expect(evicted.status).toBe(401);

    // And the pre-rotation cookie of the caller's own session is gone too.
    await clearRateLimits(h.redis);
    const stale = await request(h.server).get('/api/v1/auth/session').set('Cookie', second.cookie);
    expect(stale.status).toBe(401);
  });

  it('refuses a wrong current password with 401 and writes the denial row', async () => {
    // D9, against the append-only table.
    const email = await account();
    const signed = await signIn(email);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/change-password')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ currentPassword: 'not the current password', newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_CREDENTIALS');
    expect(await platformEvents(user.id, 'PASSWORD_CHANGE_FAILED')).toHaveLength(1);
    // The session survives a failed attempt: a refusal is not a revocation.
    expect(await liveSessions(email)).toHaveLength(1);
  });

  it('does NOT touch the lockout ladder', async () => {
    // Stated as a decision rather than left to be discovered. A caller who
    // could lock an account by failing here could lock it with a stolen
    // session, and `ACCOUNT_LOCKED` would become a distinguishable outcome on
    // an authenticated route. The rate limit is the bound; the audit row is the
    // signal.
    const email = await account();
    const signed = await signIn(email);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await clearRateLimits(h.redis);
      await request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD });
    }

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it('LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT', async () => {
    // D3 and carry-forward ruling 74. Both requests verify against the same
    // stored hash — the read happens before a ~40 ms Argon2 operation — so
    // without the compare-and-swap both commit and the account's password is
    // whichever landed last, with no error anywhere.
    //
    // **BOTH REQUESTS USE THE SAME SESSION, AND THAT IS LOAD-BEARING.** The
    // first version of this test signed in twice and fired one request per
    // session. It was green, and it was green FOR THE WRONG REASON: the winner
    // revokes every other session before the loser reaches its write, so the
    // loser was refused 401 by the authentication guard and never exercised the
    // predicate at all. Removing the compare-and-swap entirely left that
    // version passing — measured, and it is exactly the shape ruling 74 is
    // about. Sharing one session removes the revocation from the picture
    // (`exceptSessionId` covers it for both) so the only thing that can refuse
    // the second request is the credential predicate.
    const email = await account();
    const signed = await signIn(email);

    await clearRateLimits(h.redis);
    const responses = await Promise.all([
      request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: PASSWORD, newPassword: 'a different new password entirely' }),
    ]);

    const statuses = responses.map((response) => response.status).sort((a2, b2) => a2 - b2);
    expect(statuses).toEqual([200, 401]);

    // The assertion that actually discriminates: the append-only table records
    // ONE change, not two. A second commit would be a second row.
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await platformEvents(user.id, 'PASSWORD_CHANGED')).toHaveLength(1);

    // And exactly one of the two new passwords works, with the old one dead.
    await clearRateLimits(h.redis);
    const withOld = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(withOld.status).toBe(401);

    await clearRateLimits(h.redis);
    const withA = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD });
    await clearRateLimits(h.redis);
    const withB = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'a different new password entirely' });
    expect([withA.status, withB.status].filter((status) => status === 200)).toHaveLength(1);
  });

  it('is 403 CSRF_TOKEN_INVALID without X-CSRF-Token', async () => {
    // D6, ON THE SHIPPED ROUTE. `auth.controller.spec.ts` proves the route
    // declares no `@RefuseCrossSite()`; this proves `CsrfGuard` is what governs
    // it instead, which is the pair ruling 64 asks for.
    const email = await account();
    const signed = await signIn(email);

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/change-password')
      .set('Cookie', signed.cookie)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('is 403 with a CSRF token derived from a DIFFERENT session', async () => {
    const email = await account();
    const mine = await signIn(email);
    const other = await signIn(await account());

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/change-password')
      .set('Cookie', mine.cookie)
      .set('X-CSRF-Token', other.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(403);
  });

  it('is 401 with no session at all', async () => {
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it('sends the password-changed notice', async () => {
    const email = await account();
    const signed = await signIn(email);
    h.sent.length = 0;

    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/change-password')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(h.sent.map((mail) => mail.templateId)).toEqual(['passwordChanged']);
  });
});

describe('the cross-site refusal on the two PUBLIC password routes', () => {
  /**
   * D6. Both are public and state-changing, so `CsrfGuard` skips them
   * (carry-forward ruling 56 — the expected token derives from an `HttpOnly`
   * cookie a page cannot read, so a public route demanding one would refuse
   * every caller with no remedy). `@RefuseCrossSite()` is the mechanism Task 9
   * built for exactly this shape, and these assertions are on the shipped
   * routes rather than on a fixture controller.
   */
  it('refuses Sec-Fetch-Site: cross-site on forgot-password', async () => {
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/forgot-password')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: freshAddress() });

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses a foreign Origin on reset-password', async () => {
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/reset-password')
      .set('Origin', 'https://evil.example')
      .send({ token: 'FIXTURE_whatever', password: NEW_PASSWORD });

    expect(response.status).toBe(403);
  });

  it('succeeds with neither header — a non-browser client is not the threat', async () => {
    const email = await account();
    await clearRateLimits(h.redis);
    const response = await request(h.server).post('/api/v1/auth/forgot-password').send({ email });
    expect(response.status).toBe(200);
  });
});

describe('the rate-limit classes bite on the shipped routes', () => {
  it('refuses the 21st reset submission from one IP', async () => {
    // `passwordResetConsume`, 20/hour per IP. Asserted through the real
    // application rather than off the config table (ruling 64): a route that
    // silently fell to `generalSession` would answer 200 here and produce no
    // log line at the default level.
    await clearRateLimits(h.redis);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await request(h.server)
        .post('/api/v1/auth/reset-password')
        .send({ token: `FIXTURE_not_a_real_token_${String(attempt)}`, password: NEW_PASSWORD });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 422)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('refuses the 11th change-password from one IP', async () => {
    // `passwordChange`, 10/hour per IP. This is the class that bounds the
    // credential-guessing oracle described in `abuse-prevention.md` §1.
    const email = await account();
    const signed = await signIn(email);

    await clearRateLimits(h.redis);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
