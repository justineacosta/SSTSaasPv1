import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import request from 'supertest';
import { hash as argon2Hash } from '@node-rs/argon2';
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

/**
 * An Argon2id hash at parameters BELOW anything `.env` configures, so the
 * login path reports `needsRehash` for it and rewrites the row. Built with the
 * same library the service uses rather than pasted, so it cannot drift out of
 * being a valid PHC string.
 */
const weakHash = async (password: string): Promise<string> =>
  argon2Hash(password, { memoryCost: 8, timeCost: 1, parallelism: 1, algorithm: 2 });

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

  it('notifies the owner on a burst of refused current passwords (M3)', async () => {
    // M3, against the real append-only table — the count is read from
    // `PlatformAuditEvent` rather than from a column, so a fake cannot show
    // that the query works. `login` bounds guessing per account, locks, and
    // tells the owner; this endpoint deliberately does neither of the first two
    // and was telling the owner nothing at all.
    const email = await account();
    const signed = await signIn(email);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    h.sent.length = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clearRateLimits(h.redis);
      const response = await request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD });
      // The response is the same 401 on every attempt, the fifth included. A
      // different answer on the one that sends would tell whoever is guessing
      // exactly where the threshold is.
      expect(response.status).toBe(401);
    }

    expect(await platformEvents(user.id, 'PASSWORD_CHANGE_FAILED')).toHaveLength(5);
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['failedLoginBurst']);

    // AND THE LADDER IS UNTOUCHED. This is the constraint that made the notice
    // the right answer rather than the ladder: a session thief who could move
    // this counter could lock the owner out of `login` outright.
    const after = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  }, 120_000);

  it('SENDS EXACTLY ONE BURST NOTICE WHEN THE REFUSALS ARRIVE IN PARALLEL (NEW-3)', async () => {
    // CARRY-FORWARD RULING 74, IN THE FIX ROUND FOR A FINDING WHOSE OWN
    // DISPOSITIONS CITE RULING 74.
    //
    // The "once per burst" guarantee was written as a comment and asserted only
    // by sequential tests. The count is read inside the same interactive
    // transaction that writes the denial row, and Prisma runs those at Postgres
    // READ COMMITTED — so concurrent denials cannot see one another's
    // uncommitted rows and several can each count exactly `BURST_THRESHOLD`.
    // The second reviewer measured 2 and 3 notices for a single burst in two of
    // four rounds.
    //
    // What that costs is small and real: an outbound send the product pays for,
    // aimed at the account owner, multiplied at will by whoever holds the
    // stolen session — and an owner who receives three identical notices for
    // one burst learns less, not more.
    //
    // The fix is a per-account advisory lock taken before the denial row is
    // written, so the write-count-decide sequence is serialised per account and
    // each transaction's count statement sees every previously committed
    // denial. `TokenService.issue` uses the same mechanism for the same reason.
    const email = await account();
    const signed = await signIn(email);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    h.sent.length = 0;

    // Four sequential refusals first, so the burst threshold is one away and
    // every one of the parallel requests below is a candidate to trip it.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await clearRateLimits(h.redis);
      await request(h.server)
        .post('/api/v1/auth/change-password')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD });
    }
    expect(h.sent).toHaveLength(0);

    await clearRateLimits(h.redis);
    const parallel = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(h.server)
          .post('/api/v1/auth/change-password')
          .set('Cookie', signed.cookie)
          .set('X-CSRF-Token', signed.csrf)
          .send({ currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD }),
      ),
    );

    // Every one of them is refused identically — the notice never changes the
    // answer, which is what keeps the threshold invisible to whoever is
    // guessing.
    expect(parallel.map((response) => response.status)).toEqual(Array(8).fill(401));
    expect(await platformEvents(user.id, 'PASSWORD_CHANGE_FAILED')).toHaveLength(12);

    // ONE notice for one burst, however the refusals were scheduled.
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['failedLoginBurst']);

    // And the ladder is still untouched, which is the constraint that made the
    // notice the right answer in the first place.
    const after = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  }, 120_000);

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

describe('H1 — a login racing a completed reset must not keep a live session', () => {
  /**
   * THE REVIEW'S OWN PROBE, KEPT IN THE SUITE.
   *
   * The first version of this block asserted the residual instead of closing
   * it, on a measurement that said one session survived. The reviewer re-ran it
   * five times and measured **25 of 25** — every racing login survived, each a
   * fully privileged `ACTIVE` session answering `GET /auth/session` with 200 and
   * living 7 days, or 30 with "remember me", with the idle clock renewed on
   * every use. The endpoint exists to evict somebody who knows the old
   * password, and that is exactly the party able to hold logins in flight.
   *
   * **The fix is on the login path, and it is complete rather than a
   * narrowing.** After `SessionService.issue` returns, login re-reads the
   * credential; if it no longer matches what this request authenticated
   * against, the session just issued is revoked and the request answers
   * `INVALID_CREDENTIALS`. There is no third interleaving:
   *
   * - the insert lands BEFORE the reset's revoke → `revokeLiveForUser` sweeps
   *   the row, which is the existing mechanism and works;
   * - the insert lands AFTER the revoke → the credential write necessarily
   *   committed before the insert, so the post-issue re-read observes it and
   *   the login revokes itself.
   *
   * Five rounds rather than one, because a single round of this probe passed
   * over the defect once already.
   */
  it('leaves ZERO usable sessions across five rounds of five racing logins', async () => {
    let survivors = 0;
    let authenticating = 0;

    for (let round = 0; round < 5; round += 1) {
      const email = await account();
      const token = await resetTokenFor(email);

      await clearRateLimits(h.redis);
      const outcomes = await Promise.all([
        request(h.server)
          .post('/api/v1/auth/reset-password')
          .send({ token, password: NEW_PASSWORD }),
        ...Array.from({ length: 5 }, () =>
          request(h.server).post('/api/v1/auth/login').send({ email, password: PASSWORD }),
        ),
      ]);

      const [reset, ...logins] = outcomes;
      expect(reset?.status).toBe(200);

      // Count what is live in the database...
      survivors += (await liveSessions(email)).length;

      // ...and, separately, drive every cookie a racing login actually handed
      // back. A row counted live and a cookie that authenticates are two
      // different claims, and the review measured both.
      for (const login of logins) {
        const cookie = cookieNamed(login, SESSION_COOKIE_NAME);
        if (cookie === undefined) continue;
        await clearRateLimits(h.redis);
        const probe = await request(h.server)
          .get('/api/v1/auth/session')
          .set('Cookie', `${SESSION_COOKIE_NAME}=${valueOf(cookie)}`);
        if (probe.status === 200) authenticating += 1;
      }
    }

    expect(survivors).toBe(0);
    expect(authenticating).toBe(0);
  }, 180_000);

  it('does the same when the racing logins ask to be remembered', async () => {
    // The reviewer's second run: `rememberMe: true` produced 3-4 survivors per
    // round with a 30-day absolute clock. A survivor here is the worst version
    // of this defect, so it gets its own round rather than sharing a fixture.
    const email = await account();
    const token = await resetTokenFor(email);

    await clearRateLimits(h.redis);
    await Promise.all([
      request(h.server).post('/api/v1/auth/reset-password').send({ token, password: NEW_PASSWORD }),
      ...Array.from({ length: 5 }, () =>
        request(h.server)
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD, rememberMe: true }),
      ),
    ]);

    expect(await liveSessions(email)).toHaveLength(0);
  }, 120_000);

  it('still lets an ordinary login through when nothing is racing it', async () => {
    // THE ANTI-VACUITY HALF. Every assertion above is satisfied by a login
    // endpoint that has stopped issuing sessions at all, which is exactly the
    // failure a post-issue self-revocation could introduce.
    const email = await account();

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(await liveSessions(email)).toHaveLength(1);

    const cookie = cookieNamed(response, SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    await clearRateLimits(h.redis);
    const probe = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${valueOf(cookie ?? '')}`);
    expect(probe.status).toBe(200);
  });

  it('does not revoke a login that rehashed its own credential', async () => {
    // THE TRAP THE DISPOSITION NAMES, AND WHAT ACTUALLY HOLDS IT SHUT.
    //
    // D8 rewrites the stored hash on a successful login when the parameters
    // have been raised, so a post-issue comparison against the hash the request
    // originally READ sees a difference it caused itself.
    //
    // **This test does not observe the plumbing that avoids that**, and the
    // docblock here used to say it did — NEW-1. Defeating `hashInForce` leaves
    // this test green, because `credentialStillCurrent` re-verifies on a
    // mismatch and a rehash of the same password verifies. What the plumbing
    // saves is one Argon2id verification per rehashing login. The control that
    // makes the outcome correct is the re-verify fallback, and the test that
    // observes THAT is `two concurrent rehashing logins both succeed` below —
    // deleting the fallback turns that one red and leaves this one green.
    //
    // Reproduced against real Postgres by storing a credential at weaker
    // parameters than the running configuration.
    //
    // `argon2id` at m=8,t=1,p=1 is below anything `.env` configures, so
    // `needsRehash` is true for it and the login path rewrites the row.
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    const weak = await weakHash(PASSWORD);
    await h.prisma.credential.update({
      where: { userId: user.id },
      data: { passwordHash: weak },
    });

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    // The rehash happened...
    const after = await h.prisma.credential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(after.passwordHash).not.toBe(weak);
    // ...and the session it issued is still live and still authenticates.
    expect(await liveSessions(email)).toHaveLength(1);

    const cookie = cookieNamed(response, SESSION_COOKIE_NAME);
    await clearRateLimits(h.redis);
    const probe = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${valueOf(cookie ?? '')}`);
    expect(probe.status).toBe(200);
  });

  it('lets TWO CONCURRENT REHASHING LOGINS both succeed (NEW-1)', async () => {
    // THE CONTROL NOTHING OBSERVED. NEW-1.
    //
    // `credentialStillCurrent` compares the stored hash to the one in force and,
    // **on a mismatch, re-verifies the submitted password against whatever is
    // stored now**. That fallback is what makes concurrent rehashing safe: two
    // correct-password logins during a parameter migration each rewrite the row,
    // so each sees a hash the other wrote, and a byte comparison alone would
    // refuse them.
    //
    // Measured by the fix round's reviewer with the fallback deleted: **three of
    // four** concurrent correct-password sign-ins refused, for the whole duration
    // of a parameter migration — which is the one condition D8's rehash exists to
    // serve. The suite was green throughout, because the only rehash test was the
    // single-login one above, where the fast path answers first.
    //
    // This is an availability property, not a security one, and it is exactly the
    // kind that has no advocate unless a test holds it.
    const email = await account();
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    await h.prisma.credential.update({
      where: { userId: user.id },
      data: { passwordHash: await weakHash(PASSWORD) },
    });

    await clearRateLimits(h.redis);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(h.server).post('/api/v1/auth/login').send({ email, password: PASSWORD }),
      ),
    );

    // Every one of them holds a correct password. Nothing about a parameter
    // migration may turn a correct password into a refusal.
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(await liveSessions(email)).toHaveLength(4);

    // And the row really did move off the weak hash, so the rehash ran rather
    // than the test passing because nothing happened.
    const after = await h.prisma.credential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(after.passwordHash).not.toBe(await weakHash(PASSWORD));
  }, 120_000);
});

describe('M1 — the reset credential predicate, against a real second writer', () => {
  /**
   * WHAT THIS PROBE DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT.
   *
   * The review found that deleting the reset's compare-and-swap left all 25
   * integration tests green: the only thing that saw it was a unit test driving
   * `identityStoreFake`, and that fake's own docblock pointed at "the parallel
   * probe in `auth.password.integration.spec.ts`", which covers
   * `change-password` and not this. Ruling 58's family, in the file that
   * explains ruling 58.
   *
   * **This block puts a real second writer into the reset's window.** The
   * account's credential is stored at weaker-than-configured parameters, so
   * every concurrent login rehashes it (D8) — a genuine, committed, competing
   * write to the same row, not a fake's flag. Measured on this tree, 20 rounds
   * of one reset against five rehashing logins:
   *
   *     predicate present: reset refused (predicate lost) in 3/20 rounds
   *     predicate deleted: reset refused in 0/20 rounds
   *
   * So the predicate is live and reachable, and the branch behind it executes.
   *
   * **It is not a deterministic mutation kill, and this docblock will not
   * pretend otherwise.** The window between the reset's in-transaction
   * credential read and its write is one statement wide, so whether a competing
   * commit lands inside it is scheduling. An assertion on the refusal count
   * would be flaky at roughly one run in twenty-five; this repository has a
   * standing ruling about not trading determinism for coverage (ruling 33), and
   * a flaky red is worse than an honest gap.
   *
   * What is asserted instead is the invariant that holds on EVERY round and is
   * the thing a user would notice if the predicate misbehaved: the account is
   * never left in a state where neither password works, and the reset's status
   * code always agrees with the credential actually in force. Deleting the
   * predicate does **not** turn that red — it changes which legitimate outcome
   * occurs, not whether the end state is coherent — and that is stated here
   * rather than left for the next reviewer to discover.
   *
   * The remaining honest gap is recorded in `fixes.md`.
   */
  it('always ends with exactly one working password, agreeing with the reset status', async () => {
    const ROUNDS = 8;
    let refused = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const email = await account();
      const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
      // Weaker than anything `.env` configures, so every login below rehashes
      // and commits a competing write to this exact row.
      await h.prisma.credential.update({
        where: { userId: user.id },
        data: { passwordHash: await weakHash(PASSWORD) },
      });
      const token = await resetTokenFor(email);

      await clearRateLimits(h.redis);
      const [reset] = await Promise.all([
        request(h.server)
          .post('/api/v1/auth/reset-password')
          .send({ token, password: NEW_PASSWORD }),
        ...Array.from({ length: 5 }, () =>
          request(h.server).post('/api/v1/auth/login').send({ email, password: PASSWORD }),
        ),
      ]);

      // Exactly two outcomes are legitimate, and each pins a different
      // credential.
      if (reset?.status === 422) {
        // The predicate refused: the reset rolled back, so the OLD password is
        // still the account's and the link was not burned.
        refused += 1;
        await clearRateLimits(h.redis);
        const old = await request(h.server)
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD });
        expect(old.status).toBe(200);

        // The link survives a refusal — D4's rollback rule, on the concurrency
        // branch rather than the account-status one.
        await clearRateLimits(h.redis);
        const retry = await request(h.server)
          .post('/api/v1/auth/reset-password')
          .send({ token, password: NEW_PASSWORD });
        expect(retry.status).toBe(200);
      } else {
        expect(reset?.status).toBe(200);
        await clearRateLimits(h.redis);
        const fresh = await request(h.server)
          .post('/api/v1/auth/login')
          .send({ email, password: NEW_PASSWORD });
        expect(fresh.status).toBe(200);

        await clearRateLimits(h.redis);
        const old = await request(h.server)
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD });
        expect(old.status).toBe(401);
      }
    }

    // Not asserted as a number — see the docblock. Reported so a reader of a CI
    // log can see whether the branch was reached on this run at all.
    // eslint-disable-next-line no-console
    console.log(`M1 probe: reset predicate refused in ${String(refused)}/${String(ROUNDS)} rounds`);
  }, 240_000);
});
