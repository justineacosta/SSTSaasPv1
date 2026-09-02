import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import request from 'supertest';
import { hash as argon2Hash } from '@node-rs/argon2';
import {
  errorEnvelopeSchema,
  loginResponseSchema,
  mfaEnrollResponseSchema,
  sessionResponseSchema,
} from '@sentinel/contracts';
import { type AuthHarness, clearRateLimits, startAuthHarness } from '../../testing/auth-harness.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.js';
import { decryptMfaSecret } from './mfa-secret.js';
import { replaySpendWhere } from './mfa-verification.service.js';
import { TOTP_PRODUCTION, stepAt, totpCode } from './totp.js';

/**
 * TOTP MFA, RECOVERY CODES AND THE PENDING-SESSION PROMOTION, DRIVEN THROUGH
 * THE REAL APPLICATION.
 *
 * Real Postgres (Testcontainers, migrated — including D6's `lastAcceptedStep`
 * column, which is replayed from empty by `postgres-harness.ts` and has never
 * been applied to the operator's database), real Redis (compose), the real
 * `AppModule` and the real `configureApp`, so every guard in
 * `architecture/backend.md` §3's pipeline sits in front of these routes.
 *
 * What is here rather than in the unit lane is everything a fake would have
 * made true by construction:
 *
 * - **Concurrency, four ways.** Carry-forward ruling 74: Task 9's lockout
 *   ladder was green over a control that never engaged, because every test of
 *   it was sequential; ruling 84 records the same defect recurring inside a fix
 *   round. Two `mfa/verify` calls carrying the SAME valid TOTP code in one
 *   `Promise.all`; two carrying the same recovery code; five wrong codes in one
 *   `Promise.all` against the attempt counter; and a login racing a completed
 *   password reset. Every one of those passes over a broken implementation if
 *   it is written sequentially.
 * - **Ruling 87's sharpening.** Two concurrent requests must differ only in the
 *   property under test. The replay probes use TWO pending sessions, one per
 *   request, so the loser is refused by the replay predicate rather than by a
 *   pending session the sibling had already spent — a single shared session
 *   would let the promotion, not the replay defence, decide the race. Review
 *   L2: this paragraph said "ONE", which is the opposite of both the code and
 *   the reason.
 * - **The credential race (D4)**, with survivors measured both with the check
 *   disabled and with it enabled, because ruling 83 exists precisely because a
 *   fix was explained with the wrong mechanism named and the control doing the
 *   real work had no test at all.
 * - **The audit rows against a real append-only table**, and their ABSENCE when
 *   a transaction rolled back.
 * - **`GET /auth/session` with a pending token**, which `api/authentication.md`
 *   §2 has promised answers 401 `MFA_REQUIRED` since Phase 2 Task 7. Review L1:
 *   this file used to claim nothing had ever tested that, and Task 9 had —
 *   `auth.login.integration.spec.ts`'s "the pending session cannot reach GET
 *   /auth/session" presents the token as a session cookie, and
 *   `authentication.integration.spec.ts` asserts the same property at the guard
 *   layer. What is new here is only the coverage from the far side of a
 *   completed challenge.
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
  return `mfa-${String(counter)}-${String(Date.now())}@example.test`;
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

/** One real login that issues a full session (no MFA on the account). */
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

/**
 * The pending token from a login against an MFA-enrolled account.
 *
 * The MFA arm sets NO cookie, which this asserts rather than assumes: it is
 * ADR-0018's delivery decision and `api/authentication.md` §2's promise.
 */
async function pendingLogin(email: string, password = PASSWORD): Promise<string> {
  await clearRateLimits(h.redis);
  const response = await request(h.server)
    .post('/api/v1/auth/login')
    .send({ email, password, rememberMe: true });
  expect(response.status).toBe(200);
  // Parsed with the SHIPPED contract rather than cast. `loginResponseSchema` is
  // a discriminated union, so narrowing on `mfaRequired` is what makes
  // `pendingToken` reachable at all — the property Task 2 chose the union for.
  const body = loginResponseSchema.parse(response.body);
  expect(body.mfaRequired).toBe(true);
  expect(setCookies(response)).toEqual([]);
  if (!body.mfaRequired) throw new Error('login did not take the MFA arm');
  return body.pendingToken;
}

/**
 * The plaintext secret, read the way `mfa-verification.service.ts` reads it.
 *
 * The spec decrypts with the SAME key the application booted with — the
 * harness loads the repository `.env`, so `MFA_SECRET_ENCRYPTION_KEY` is the
 * one `auth.module.ts` decoded. That is what makes a code computed here the
 * code a real authenticator would produce, rather than one this spec and the
 * service happen to agree on.
 */
async function secretFor(email: string): Promise<Buffer> {
  const factor = await h.prisma.mfaFactor.findFirstOrThrow({ where: { user: { email } } });
  const key = Buffer.from(process.env['MFA_SECRET_ENCRYPTION_KEY'] ?? '', 'base64');
  return decryptMfaSecret(key, factor.secretEncrypted, factor.secretKeyVersion);
}

const codeFor = (secret: Buffer, atMs = Date.now()): string =>
  totpCode(secret, stepAt(atMs, TOTP_PRODUCTION.stepSeconds), TOTP_PRODUCTION);

/**
 * The code for step `t+1`, which is what a caller must use straight after
 * confirming — AND THAT IS D6 WORKING, NOT A TEST WORKAROUND.
 *
 * `mfa/confirm` spends the code it verified: it writes the accepted step to
 * `MfaFactor.lastAcceptedStep`, so the same six digits are refused at
 * `mfa/verify` for the rest of that thirty-second window. The first draft of
 * this file used `codeFor` after confirming and got 401s, which is exactly the
 * replay defence doing its job on a spec that had assumed it away.
 *
 * `t+1` is inside the ±1 drift window, so the server accepts it now — this is
 * the same thing a real authenticator app shows a user who waits for the digits
 * to roll over. `refuses the confirming code at mfa/verify` below asserts the
 * refusal directly rather than leaving it as a fact only this helper knows.
 */
const nextCodeFor = (secret: Buffer): string =>
  totpCode(secret, stepAt(Date.now(), TOTP_PRODUCTION.stepSeconds) + 1, TOTP_PRODUCTION);

/**
 * Enrols and confirms MFA through the real endpoints, returning the recovery
 * codes **and the exact six digits that were confirmed**.
 *
 * **Review L4 — returning `confirmingCode` is what makes the replay test
 * deterministic.** A caller that wanted the confirming code used to recompute
 * `codeFor(secret)` after this helper returned, which re-reads the clock: if the
 * thirty-second step rolled over in between, the "replay" was a code for step
 * `N+1`, which the server legitimately accepts, and a test asserting 401 went
 * red. Observed once in four runs. The code is captured here, on the near side
 * of the rollover, so the assertion is about the replay defence and never about
 * where the wall clock happened to be.
 */
async function enableMfa(email: string): Promise<{
  secret: Buffer;
  recoveryCodes: string[];
  signed: Signed;
  confirmingCode: string;
  /**
   * The step the confirming code was generated at, captured here rather than
   * recomputed by the caller.
   *
   * **This is the fix for a real flake, not defensive tidiness.** A TOTP step
   * is 30 seconds wide, and `lastAcceptedStep` is fixed at the instant the code
   * is generated. A caller asserting
   * `toBe(stepAt(Date.now(), TOTP_PRODUCTION.stepSeconds))` is therefore
   * comparing against whatever step is current *at assertion time*, which is a
   * different number whenever a boundary falls in between — and the boundary
   * does not care that the test is correct. Measured arithmetic: with a
   * generate-to-assert span of D milliseconds the assertion fails on D/30000 of
   * runs, so roughly 3% at a one-second span. Found by Task 13's reviewer as a
   * one-off failure in an otherwise green suite, which is exactly how a defect
   * of this shape presents.
   *
   * Returning the step makes the assertion independent of wall-clock timing
   * instead of merely less likely to trip. The general rule, worth more than
   * this fix: **never recompute a time-derived value the system under test
   * already committed to — capture it at the moment it was committed.**
   */
  confirmingStep: number;
}> {
  const signed = await signIn(email);
  await clearRateLimits(h.redis);

  const enrolled = await request(h.server)
    .post('/api/v1/auth/mfa/enroll')
    .set('Cookie', signed.cookie)
    .set('X-CSRF-Token', signed.csrf)
    .send({ password: PASSWORD });
  expect(enrolled.status).toBe(200);

  const secret = await secretFor(email);
  // One clock reading, used for both the code and the step it belongs to. Two
  // readings would reintroduce the boundary race this is here to remove.
  const confirmingAtMs = Date.now();
  const confirmingCode = codeFor(secret, confirmingAtMs);
  const confirmingStep = stepAt(confirmingAtMs, TOTP_PRODUCTION.stepSeconds);
  const confirmed = await request(h.server)
    .post('/api/v1/auth/mfa/confirm')
    .set('Cookie', signed.cookie)
    .set('X-CSRF-Token', signed.csrf)
    .send({ code: confirmingCode });
  expect(confirmed.status).toBe(200);

  return {
    secret,
    recoveryCodes: (confirmed.body as { recoveryCodes: string[] }).recoveryCodes,
    signed,
    confirmingCode,
    confirmingStep,
  };
}

async function platformEvents(resourceId: string, action?: string) {
  return h.prisma.platformAuditEvent.findMany({
    where: { resourceId, ...(action === undefined ? {} : { action }) },
    orderBy: { createdAt: 'asc' },
  });
}

const userIdOf = async (email: string): Promise<string> =>
  (await h.prisma.user.findUniqueOrThrow({ where: { email } })).id;

/**
 * Live `ACTIVE` sessions that were **promoted from a pending one**, which is
 * the only number the survivor counts below are about.
 *
 * A plain count of live `ACTIVE` sessions is the wrong question and the first
 * draft asked it: `enableMfa` signs in with an ordinary login to reach the
 * enrolment routes, so every account in this file already holds one before any
 * promotion happens, and a probe counting all of them reports 1 when it means 0.
 * `rotatedFromId IS NOT NULL` is exactly "this row came out of `mfa/verify`".
 */
const promotedSessions = async (userId: string): Promise<number> =>
  h.prisma.session.count({
    where: { userId, status: 'ACTIVE', revokedAt: null, rotatedFromId: { not: null } },
  });

/**
 * A valid Argon2id PHC string at the parameters `.env` configures.
 *
 * Built with the same library the service uses rather than pasted, so it cannot
 * drift out of being a hash the login path accepts — the same device
 * `auth.password.integration.spec.ts` uses for its weak hash.
 */
const hashOf = async (password: string): Promise<string> =>
  argon2Hash(password, {
    memoryCost: Number(process.env['PASSWORD_ARGON2_MEMORY_KIB'] ?? 65_536),
    timeCost: Number(process.env['PASSWORD_ARGON2_TIME_COST'] ?? 3),
    parallelism: Number(process.env['PASSWORD_ARGON2_PARALLELISM'] ?? 4),
    algorithm: 2,
  });

describe('POST /auth/mfa/enroll', () => {
  it('stores an UNCONFIRMED factor with the key version written explicitly', async () => {
    const email = await account();
    const signed = await signIn(email);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    const enrolled = mfaEnrollResponseSchema.parse(response.body);
    expect(enrolled.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrolled.otpauthUri).toContain('otpauth://totp/Sentinel:');
    // The URI carries the same secret the body does, so a user who cannot scan
    // can type it in and get the same factor.
    expect(enrolled.otpauthUri).toContain(`secret=${enrolled.secret}`);

    const factor = await h.prisma.mfaFactor.findFirstOrThrow({ where: { user: { email } } });
    expect(factor.confirmedAt).toBeNull();
    // CARRY-FORWARD RULING 8. The column existed from Task 1 and nothing wrote
    // it. If this is null, the rotation story is a comment again.
    expect(factor.secretKeyVersion).toBe(1);
    // The stored value is not the secret. A ciphertext that happened to equal
    // the plaintext would pass every other test in this file.
    expect(factor.secretEncrypted).not.toContain(enrolled.secret);
  });

  it('does not gate login: an unconfirmed factor still signs in with a cookie', async () => {
    const email = await account();
    const signed = await signIn(email);
    await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    // D3 and ruling 7: `confirmedAt IS NOT NULL` is the only test for "has
    // MFA". Gating on the row existing would lock the user out behind a code
    // nobody has.
    const again = await signIn(email);
    expect(again.sessionToken).not.toBe('');
  });

  it('refuses a wrong password, writes the denial row, and creates nothing', async () => {
    const email = await account();
    const signed = await signIn(email);
    const userId = await userIdOf(email);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: 'not the right password at all' });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_CREDENTIALS');
    expect(await h.prisma.mfaFactor.count({ where: { userId } })).toBe(0);

    const denials = await platformEvents(userId, 'MFA_MANAGEMENT_DENIED');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.metadata).toEqual({ operation: 'ENROLL', reason: 'WRONG_PASSWORD' });
  });

  it('refuses with 409 when a confirmed factor already exists', async () => {
    const email = await account();
    const { signed } = await enableMfa(email);
    await clearRateLimits(h.redis);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    // D3. Replacing a working factor without proving a code is an
    // account-takeover step, so this is a refusal rather than an overwrite.
    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('DUPLICATE_RESOURCE');
  });

  /**
   * THE PLAN'S OWN TEST, VERBATIM, AND IT IS CARRY-FORWARD RULING 7.
   *
   * `MfaFactor` has `@@unique([userId, type])`. Before this task an abandoned
   * unconfirmed row occupied the slot and the next enrolment died on P2002 — a
   * user who closed the tab had locked themselves out of ever enabling MFA.
   */
  it('leaves the account exactly as it was when enrolment is abandoned, and lets it start again', async () => {
    const email = await account();
    const signed = await signIn(email);
    const userId = await userIdOf(email);

    const first = await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });
    expect(first.status).toBe(200);

    // Abandoned: nothing is confirmed, no recovery codes exist, and login is
    // unchanged.
    expect(await h.prisma.mfaFactor.count({ where: { userId, confirmedAt: { not: null } } })).toBe(
      0,
    );
    expect(await h.prisma.recoveryCode.count({ where: { userId } })).toBe(0);
    const stillOrdinary = await signIn(email);
    expect(stillOrdinary.sessionToken).not.toBe('');

    // And the next attempt succeeds rather than dying on the unique index.
    await clearRateLimits(h.redis);
    const second = await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', stillOrdinary.cookie)
      .set('X-CSRF-Token', stillOrdinary.csrf)
      .send({ password: PASSWORD });
    expect(second.status).toBe(200);
    expect(mfaEnrollResponseSchema.parse(second.body).secret).not.toBe(
      mfaEnrollResponseSchema.parse(first.body).secret,
    );
    // Exactly one factor row: the abandoned one was replaced, not accumulated.
    expect(await h.prisma.mfaFactor.count({ where: { userId } })).toBe(1);
  });

  /**
   * REVIEW M1. Ruling 7 moved to the concurrent path.
   *
   * Both transactions found no unconfirmed factor to delete, and the loser's
   * `create` raised P2002 against `@@unique([userId, type])` with nothing
   * catching it — measured as `statuses=[500,200]` with an `INTERNAL_ERROR`
   * envelope, from an ordinary double-click on an authenticated route.
   */
  it('two concurrent enrolments never answer 500, and leave exactly one factor', async () => {
    const email = await account();
    const signed = await signIn(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);

    const enroll = () =>
      request(h.server)
        .post('/api/v1/auth/mfa/enroll')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ password: PASSWORD });

    const [first, second] = await Promise.all([enroll(), enroll()]);

    // Asserted as "no 5xx" rather than as a pair of exact codes: both serialise
    // and both may legitimately answer 200, since neither factor is confirmed
    // and replacing an unconfirmed one is what ruling 7's fix does.
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);
    expect(await h.prisma.mfaFactor.count({ where: { userId } })).toBe(1);
    expect(await h.prisma.mfaFactor.count({ where: { userId, confirmedAt: { not: null } } })).toBe(
      0,
    );
  });
});

describe('POST /auth/mfa/confirm', () => {
  it('enables the factor, issues ten recovery codes, and emails the owner', async () => {
    const email = await account();
    const userId = await userIdOf(email);
    const { recoveryCodes, confirmingStep } = await enableMfa(email);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const factor = await h.prisma.mfaFactor.findFirstOrThrow({ where: { userId } });
    expect(factor.confirmedAt).not.toBeNull();
    // D6: the confirming code is SPENT, so it cannot be replayed at
    // `mfa/verify` inside its drift window.
    //
    // Compared against the step the code was GENERATED at, not the step current
    // now. This line read `stepAt(Date.now(), ...)` until Task 13's residual
    // sweep, which made it fail on roughly 3% of runs — every run where a
    // 30-second boundary happened to fall between `enableMfa` generating the
    // code and this assertion reading the clock again. The reviewer hit it once
    // in an otherwise green suite. See `enableMfa`'s `confirmingStep`.
    expect(factor.lastAcceptedStep).toBe(confirmingStep);

    const stored = await h.prisma.recoveryCode.findMany({ where: { userId } });
    expect(stored).toHaveLength(10);
    // Argon2id, not SHA-256 — 50 bits of human-typed entropy needs the work
    // factor, and `schema.prisma` says so.
    for (const code of stored) expect(code.codeHash).toMatch(/^\$argon2id\$/);
    // No stored hash is any code in plaintext.
    for (const code of recoveryCodes) {
      expect(stored.some((row) => row.codeHash.includes(code))).toBe(false);
    }

    expect(h.sent.map((mail) => mail.templateId)).toContain('mfaEnabled');

    const enabled = await platformEvents(userId, 'MFA_ENABLED');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.metadata).toMatchObject({ recoveryCodesIssued: 10 });
    // The secret is in no audit row, in any form.
    for (const event of await platformEvents(userId)) {
      expect(JSON.stringify(event.metadata)).not.toContain(factor.secretEncrypted);
    }
  });

  it('refuses a wrong code and leaves the factor unconfirmed', async () => {
    const email = await account();
    const signed = await signIn(email);
    const userId = await userIdOf(email);
    await request(h.server)
      .post('/api/v1/auth/mfa/enroll')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/confirm')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ code: '000000' });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('MFA_INVALID');
    const factor = await h.prisma.mfaFactor.findFirstOrThrow({ where: { userId } });
    expect(factor.confirmedAt).toBeNull();
    expect(await h.prisma.recoveryCode.count({ where: { userId } })).toBe(0);
    // THE ROLLBACK, ASSERTED. No `MFA_ENABLED` row for an enable that did not
    // happen.
    expect(await platformEvents(userId, 'MFA_ENABLED')).toHaveLength(0);
  });

  it('refuses with 422 when there is no enrolment in progress', async () => {
    const email = await account();
    const signed = await signIn(email);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/confirm')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ code: '000000' });

    expect(response.status).toBe(422);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('the full journey', () => {
  it('enrol -> confirm -> login -> mfa/verify -> an authenticated request succeeds', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const userId = await userIdOf(email);

    const pendingToken = await pendingLogin(email);

    // §2's promise, tested for the first time: a pending token can read
    // nothing. It is not even in a cookie, so this is the strongest form —
    // presenting it AS a session cookie must not work either.
    const withPending = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${pendingToken}`);
    expect(withPending.status).toBe(401);
    expect(errorEnvelopeSchema.parse(withPending.body).error.code).toBe('MFA_REQUIRED');

    await clearRateLimits(h.redis);
    const verified = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: nextCodeFor(secret) });

    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ status: 'AUTHENTICATED' });

    const session = cookieNamed(verified, SESSION_COOKIE_NAME);
    const csrf = cookieNamed(verified, CSRF_COOKIE_NAME);
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();

    // The promoted session works.
    const document = await request(h.server)
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${valueOf(session ?? '')}`);
    expect(document.status).toBe(200);
    expect(sessionResponseSchema.parse(document.body).userId).toBe(userId);

    // RULING 50, END TO END. The promoted row carries the evidence.
    const promoted = await h.prisma.session.findFirstOrThrow({
      where: { userId, status: 'ACTIVE', revokedAt: null },
    });
    expect(promoted.mfaCompletedAt).not.toBeNull();
    expect(promoted.rotatedFromId).not.toBeNull();

    // The pending session it replaced is revoked, so the token in the caller's
    // hand before the promotion cannot be used after it.
    const pendingRow = await h.prisma.session.findUniqueOrThrow({
      where: { id: promoted.rotatedFromId ?? '' },
    });
    expect(pendingRow.status).toBe('PENDING_MFA');
    expect(pendingRow.revokedAt).not.toBeNull();

    const succeeded = await platformEvents(pendingRow.id, 'MFA_CHALLENGE_SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.metadata).toMatchObject({ method: 'TOTP' });
  });

  /**
   * D9, AND IT IS TASK 9'S DEBT.
   *
   * `login.service.ts:139-142` recorded that no new-device notice is sent on
   * the MFA arm, so an MFA-enrolled account got NO unfamiliar-session notice at
   * all. The trap on this side is that the pending session already carries the
   * login's `(userId, ip, userAgent)` triple, so an unexcluded familiarity
   * lookup matches ITSELF and the notice never fires.
   */
  it('sends the unfamiliar-sign-in notice on MFA completion, from a device never seen before', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);

    await clearRateLimits(h.redis);
    const login = await request(h.server)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'a-user-agent-this-account-has-never-carried/1.0')
      .send({ email, password: PASSWORD });
    const pendingToken = (login.body as { pendingToken: string }).pendingToken;

    h.sent.length = 0;
    await clearRateLimits(h.redis);
    const verified = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .set('User-Agent', 'a-user-agent-this-account-has-never-carried/1.0')
      .send({ pendingToken, code: nextCodeFor(secret) });

    expect(verified.status).toBe(200);
    const notice = h.sent.find((mail) => mail.templateId === 'newDeviceSignIn');
    expect(notice).toBeDefined();
    // RULING 71 AND 85. The notice renders no user agent and no display name —
    // the parameters do not exist — so the attacker-chosen header above cannot
    // appear in a message sent to the account owner.
    expect(notice?.text).not.toContain('a-user-agent-this-account-has-never-carried');
    expect(notice?.html).not.toContain('a-user-agent-this-account-has-never-carried');
  });
});

describe('POST /auth/mfa/verify — the replay defence (D6)', () => {
  it('refuses the code that CONFIRMED the factor, at the very next request', async () => {
    // The sharpest instance of the defence and the one a naive implementation
    // misses entirely: `mfa/confirm` accepted these six digits a moment ago and
    // wrote the step, so `mfa/verify` must refuse them for the rest of the
    // window even though they are still arithmetically valid.
    const email = await account();
    const { secret, confirmingCode } = await enableMfa(email);

    const pendingToken = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const replay = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: confirmingCode });

    expect(replay.status).toBe(401);
    expect(errorEnvelopeSchema.parse(replay.body).error.code).toBe('MFA_INVALID');

    // And the next window's code works, which is what a user's phone shows
    // after the digits roll over.
    await clearRateLimits(h.redis);
    const fresh = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: nextCodeFor(secret) });
    expect(fresh.status).toBe(200);
  });

  it('refuses a code that has already been accepted, sequentially', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);

    const code = nextCodeFor(secret);
    const first = await pendingLogin(email);
    await clearRateLimits(h.redis);
    expect(
      (await request(h.server).post('/api/v1/auth/mfa/verify').send({ pendingToken: first, code }))
        .status,
    ).toBe(200);

    // A SECOND pending session, so the refusal cannot be about the first
    // session being spent. The code is the only thing being reused.
    const second = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const replay = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken: second, code });

    expect(replay.status).toBe(401);
    expect(errorEnvelopeSchema.parse(replay.body).error.code).toBe('MFA_INVALID');
  });

  /**
   * RULING 74. TWO CONCURRENT REQUESTS, ON TWO SEPARATE PENDING SESSIONS.
   *
   * Two sessions deliberately, so the per-session advisory lock on the failure
   * path cannot be what serialises them — ruling 87's sharpening: the two
   * requests must differ only in the property under test.
   *
   * **WHAT THIS PROBE DOES AND DOES NOT PROVE, MEASURED RATHER THAN CLAIMED.**
   * The replay defence has two layers: the in-memory floor passed to
   * `verifyTotpCode`, and the conditional `UPDATE` on `lastAcceptedStep`.
   * Mutating each in turn (Task 11's report has the four rows):
   *
   * - widen the `UPDATE` predicate alone -> this test stays **green**;
   * - remove the in-memory floor alone -> this test stays **green**;
   * - remove both -> this test goes **red**, as do the two sequential ones.
   *
   * So the honest reading is that this probe proves *at least one* of the two
   * refuses the second request, and does not by itself pin which. Over HTTP the
   * interleaving that would separate them — both requests reading before either
   * writes — is a distribution rather than a determinism, which is
   * carry-forward ruling 88's shape. `the conditional UPDATE arbitrates`
   * below is the probe that pins the database half, at the layer where the
   * interleaving IS controllable.
   */
  it('accepts the same code exactly once when two requests race', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);

    const code = nextCodeFor(secret);
    const a = await pendingLogin(email);
    const b = await pendingLogin(email);
    await clearRateLimits(h.redis);

    const [first, second] = await Promise.all([
      request(h.server).post('/api/v1/auth/mfa/verify').send({ pendingToken: a, code }),
      request(h.server).post('/api/v1/auth/mfa/verify').send({ pendingToken: b, code }),
    ]);

    const statuses = [first.status, second.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 401]);
    // Exactly one PROMOTION happened. Two would mean the same code completed
    // MFA twice, which is the defect this probe exists to see.
    expect(await promotedSessions(await userIdOf(email))).toBe(1);
  });

  /**
   * THE CONDITIONAL `UPDATE` ARBITRATES, PROVED AT THE LAYER WHERE THE
   * INTERLEAVING CAN BE FORCED.
   *
   * The endpoint probe above cannot separate the two layers of the defence,
   * because over HTTP "both requests read before either writes" is a
   * distribution (ruling 88). Here both statements are issued against the same
   * row with the SAME `step`, from two transactions that have both already
   * decided, which is exactly the interleaving the in-memory floor cannot help
   * with — it is not in this picture at all.
   *
   * Postgres arbitrates on the row lock: the second `UPDATE` blocks, then
   * re-evaluates `lastAcceptedStep < step` against the committed version and
   * reports `count: 0`. Widening that predicate makes this go red, which the
   * endpoint probe does not.
   */
  it('the conditional UPDATE arbitrates: exactly one of two identical spends affects a row', async () => {
    const email = await account();
    await enableMfa(email);
    const factor = await h.prisma.mfaFactor.findFirstOrThrow({ where: { user: { email } } });
    const step = (factor.lastAcceptedStep ?? 0) + 5;

    // THE SERVICE'S OWN PREDICATE, imported rather than copied. Ruling 75's
    // reason one layer over: a probe carrying its own copy would assert that
    // Postgres arbitrates, not that this code asks it to, and would stay green
    // while the service was widened underneath it.
    const spend = async () =>
      h.prisma.mfaFactor.updateMany({
        where: replaySpendWhere(factor.id, step),
        data: { lastAcceptedStep: step, lastUsedAt: new Date() },
      });

    const [first, second] = await Promise.all([spend(), spend()]);
    expect([first.count, second.count].sort((x, y) => x - y)).toEqual([0, 1]);

    const after = await h.prisma.mfaFactor.findUniqueOrThrow({ where: { id: factor.id } });
    expect(after.lastAcceptedStep).toBe(step);
  });
});

describe('POST /auth/mfa/verify — recovery codes (D7)', () => {
  it('completes MFA with a recovery code and then refuses the same code', async () => {
    const email = await account();
    const { recoveryCodes } = await enableMfa(email);
    const code = recoveryCodes[0] ?? '';
    const userId = await userIdOf(email);

    const first = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const used = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken: first, code });
    expect(used.status).toBe(200);

    expect(await h.prisma.recoveryCode.count({ where: { userId, usedAt: null } })).toBe(9);
    const codeUsed = await platformEvents(userId, 'MFA_RECOVERY_CODE_USED');
    expect(codeUsed).toHaveLength(1);
    expect(codeUsed[0]?.metadata).toMatchObject({ remaining: 9 });
    // The code itself is in no audit row.
    expect(JSON.stringify(codeUsed[0]?.metadata)).not.toContain(code.replace('-', ''));

    const second = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const again = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken: second, code });
    expect(again.status).toBe(401);
    expect(errorEnvelopeSchema.parse(again.body).error.code).toBe('MFA_INVALID');
  });

  it('spends a recovery code exactly once when two requests race', async () => {
    const email = await account();
    const { recoveryCodes } = await enableMfa(email);
    const code = recoveryCodes[3] ?? '';
    const userId = await userIdOf(email);

    const a = await pendingLogin(email);
    const b = await pendingLogin(email);
    await clearRateLimits(h.redis);

    const [first, second] = await Promise.all([
      request(h.server).post('/api/v1/auth/mfa/verify').send({ pendingToken: a, code }),
      request(h.server).post('/api/v1/auth/mfa/verify').send({ pendingToken: b, code }),
    ]);

    expect([first.status, second.status].sort((x, y) => x - y)).toEqual([200, 401]);
    expect(await h.prisma.recoveryCode.count({ where: { userId, usedAt: null } })).toBe(9);
  });

  it('accepts a recovery code typed in lower case with the hyphen dropped', async () => {
    const email = await account();
    const { recoveryCodes } = await enableMfa(email);
    const typed = (recoveryCodes[7] ?? '').replace('-', '').toLowerCase();

    const pendingToken = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: typed });
    expect(response.status).toBe(200);
  });
});

describe('POST /auth/mfa/verify — the five-attempt lock (D5)', () => {
  it('revokes the pending session on the fifth failure, and a correct code then fails', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const pendingToken = await pendingLogin(email);
    await clearRateLimits(h.redis);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(h.server)
        .post('/api/v1/auth/mfa/verify')
        .send({ pendingToken, code: '000000' });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401]);

    // THE SIXTH ATTEMPT FAILS EVEN WITH A CORRECT CODE, which is the property
    // §5 names and the one a wrong implementation would not have.
    const sixth = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: codeFor(secret) });
    expect(sixth.status).toBe(401);
    expect(errorEnvelopeSchema.parse(sixth.body).error.code).toBe('MFA_INVALID');

    const userId = await userIdOf(email);
    const pendingRow = await h.prisma.session.findFirstOrThrow({
      where: { userId, status: 'PENDING_MFA' },
      orderBy: { createdAt: 'desc' },
    });
    expect(pendingRow.revokedAt).not.toBeNull();

    const locks = await platformEvents(pendingRow.id, 'MFA_PENDING_SESSION_LOCKED');
    expect(locks).toHaveLength(1);
    // ONCE PER LOCK. The sixth attempt found a revoked session and wrote
    // nothing, so the table cannot be grown by an attacker who keeps knocking.
    expect(await platformEvents(pendingRow.id, 'MFA_CHALLENGE_FAILED')).toHaveLength(5);
  });

  /**
   * RULING 74, AND IT IS THE EXACT SHAPE THAT KEEPS BITING.
   *
   * Task 9's lockout ladder was green over a control that never engaged because
   * every test was sequential; ruling 84 records the same defect recurring
   * inside a fix round, on a counter read at READ COMMITTED. This counter is
   * read inside the transaction that writes the row it counts, so without the
   * per-session advisory lock five parallel wrong codes each see zero prior
   * failures, each count 1, and NOTHING LOCKS.
   */
  it('locks the pending session when the five failures arrive concurrently', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const pendingToken = await pendingLogin(email);
    await clearRateLimits(h.redis);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(h.server)
          .post('/api/v1/auth/mfa/verify')
          .send({ pendingToken, code: String(100_000 + index) }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);

    const userId = await userIdOf(email);
    const pendingRow = await h.prisma.session.findFirstOrThrow({
      where: { userId, status: 'PENDING_MFA' },
      orderBy: { createdAt: 'desc' },
    });
    // THE LOCK ENGAGED. This is the assertion the sequential version cannot
    // make.
    expect(pendingRow.revokedAt).not.toBeNull();
    // ONCE, not five times. The advisory lock is what makes exactly one
    // transaction observe the count crossing the threshold.
    expect(await platformEvents(pendingRow.id, 'MFA_PENDING_SESSION_LOCKED')).toHaveLength(1);
    expect(await platformEvents(pendingRow.id, 'MFA_CHALLENGE_FAILED')).toHaveLength(5);

    // And a correct code afterwards is refused.
    const after = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: codeFor(secret) });
    expect(after.status).toBe(401);
  });

  it('counts per pending session, so signing in again starts a fresh five', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const first = await pendingLogin(email);
    await clearRateLimits(h.redis);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(h.server)
        .post('/api/v1/auth/mfa/verify')
        .send({ pendingToken: first, code: '000000' });
    }

    // A NEW pending session. The count is keyed on the session, and starting
    // over cost the attacker the password again — which is the trade §5's
    // wording implies and this asserts rather than leaves to inference.
    const second = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken: second, code: nextCodeFor(secret) });
    expect(response.status).toBe(200);
  });
});

describe('POST /auth/mfa/disable', () => {
  it('requires the current password; a wrong one changes nothing and writes the denial row', async () => {
    const email = await account();
    const { signed } = await enableMfa(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);
    h.sent.length = 0;

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/disable')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: 'not the right password at all' });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_CREDENTIALS');
    // NOTHING CHANGED.
    expect(await h.prisma.mfaFactor.count({ where: { userId, confirmedAt: { not: null } } })).toBe(
      1,
    );
    expect(await h.prisma.recoveryCode.count({ where: { userId } })).toBe(10);
    expect(await platformEvents(userId, 'MFA_DISABLED')).toHaveLength(0);
    expect(h.sent.map((mail) => mail.templateId)).not.toContain('mfaDisabled');

    const denials = await platformEvents(userId, 'MFA_MANAGEMENT_DENIED');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.metadata).toEqual({ operation: 'DISABLE', reason: 'WRONG_PASSWORD' });
  });

  it('deletes the factor and every recovery code, emails the owner, and login stops requiring MFA', async () => {
    const email = await account();
    const { signed } = await enableMfa(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);
    h.sent.length = 0;

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/disable')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'MFA_DISABLED' });
    expect(await h.prisma.mfaFactor.count({ where: { userId } })).toBe(0);
    expect(await h.prisma.recoveryCode.count({ where: { userId } })).toBe(0);
    expect(await platformEvents(userId, 'MFA_DISABLED')).toHaveLength(1);
    expect(h.sent.map((mail) => mail.templateId)).toContain('mfaDisabled');

    // Login is an ordinary login again.
    const signedAgain = await signIn(email);
    expect(signedAgain.sessionToken).not.toBe('');
  });

  it('refuses with 422 when MFA is not switched on', async () => {
    const email = await account();
    const signed = await signIn(email);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/disable')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    expect(response.status).toBe(422);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('POST /auth/mfa/recovery-codes', () => {
  it('replaces the whole set, and every previous code stops working', async () => {
    const email = await account();
    const { recoveryCodes, signed } = await enableMfa(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/recovery-codes')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    const reissued = (response.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(reissued).toHaveLength(10);
    expect(reissued).not.toEqual(recoveryCodes);
    expect(await h.prisma.recoveryCode.count({ where: { userId } })).toBe(10);
    expect(await platformEvents(userId, 'MFA_RECOVERY_CODES_REGENERATED')).toHaveLength(1);

    // An OLD code no longer completes MFA.
    const pendingToken = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const old = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: recoveryCodes[0] ?? '' });
    expect(old.status).toBe(401);

    // A NEW one does.
    const stillPending = await pendingLogin(email);
    await clearRateLimits(h.redis);
    const fresh = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken: stillPending, code: reissued[0] ?? '' });
    expect(fresh.status).toBe(200);
  });

  it('requires the current password', async () => {
    const email = await account();
    const { signed } = await enableMfa(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);

    const response = await request(h.server)
      .post('/api/v1/auth/mfa/recovery-codes')
      .set('Cookie', signed.cookie)
      .set('X-CSRF-Token', signed.csrf)
      .send({ password: 'not the right password at all' });

    expect(response.status).toBe(401);
    expect(await platformEvents(userId, 'MFA_RECOVERY_CODES_REGENERATED')).toHaveLength(0);
    const denials = await platformEvents(userId, 'MFA_MANAGEMENT_DENIED');
    expect(denials[0]?.metadata).toEqual({
      operation: 'REGENERATE_RECOVERY_CODES',
      reason: 'WRONG_PASSWORD',
    });
  });

  /**
   * REVIEW H1. TWO REQUESTS MEANS TWO CONCURRENT REQUESTS — ruling 74, and
   * ruling 84 which is ruling 74 recurring inside a fix round.
   *
   * Before the per-user advisory lock this measured `statuses=[200,200]` with
   * **twenty** live rows, and the consumer's `take: 10` then refused ten of the
   * twenty codes the API had just handed the account owner. The last code of
   * each returned set is verified rather than the first, because with no
   * `orderBy` the planner decided which half worked and the first code of one
   * set could pass by luck.
   */
  it('two concurrent regenerations leave exactly one live set, and every code it returned works', async () => {
    const email = await account();
    const { signed } = await enableMfa(email);
    const userId = await userIdOf(email);
    await clearRateLimits(h.redis);

    const regenerate = () =>
      request(h.server)
        .post('/api/v1/auth/mfa/recovery-codes')
        .set('Cookie', signed.cookie)
        .set('X-CSRF-Token', signed.csrf)
        .send({ password: PASSWORD });

    // FIVE ROUNDS, AND THE ROUNDS ARE NOT PADDING. Carry-forward ruling 88: over
    // HTTP the destructive interleaving is a distribution, not a determinism.
    // Measured against the unlocked code, one round reproduced the defect in
    // roughly two runs out of three — a guard that misses a High one time in
    // three is a guard that goes green on the regression that reintroduces it.
    // The invariant is asserted after EVERY round, which is the shape ruling 88
    // asks for: assert what must hold every time, not what happened once.
    let lastSurvivingSet: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      await clearRateLimits(h.redis);
      const [first, second] = await Promise.all([regenerate(), regenerate()]);

      // Both are legitimate requests from an authenticated owner, so both may
      // answer 200. What must not happen is both SETS surviving.
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await h.prisma.recoveryCode.count({ where: { userId, usedAt: null } })).toBe(10);

      lastSurvivingSet = [
        ...(first.body as { recoveryCodes: string[] }).recoveryCodes,
        ...(second.body as { recoveryCodes: string[] }).recoveryCodes,
      ];
    }

    // And the surviving set is wholly usable. The LAST code of each candidate
    // rather than the first: with no `orderBy` on the consumer (review L6) the
    // planner chose which ten of twenty rows worked, and a first code could
    // pass by luck while the tenth did not.
    let accepted = 0;
    for (const code of [lastSurvivingSet[9], lastSurvivingSet[19]]) {
      const pendingToken = await pendingLogin(email);
      await clearRateLimits(h.redis);
      const attempt = await request(h.server)
        .post('/api/v1/auth/mfa/verify')
        .send({ pendingToken, code: code ?? '' });
      if (attempt.status === 200) accepted += 1;
    }

    // Exactly one of the two printouts is real, and it is real all the way to
    // its tenth code. The defect this was written for is the state where BOTH
    // responses were 200 and NEITHER printout was wholly usable.
    expect(accepted).toBe(1);
  });
});

/**
 * D4. THE CREDENTIAL RACE, AND THE SURVIVOR COUNT IS THE EVIDENCE.
 *
 * Task 10's H1 measured **25 of 25** survivors on the login path: a login
 * racing a completed password reset kept a fully privileged session minted with
 * the OLD password. The promotion has the same shape and no password to
 * re-verify with — `revokeAllForUser` is one `updateMany` and cannot revoke a
 * row that does not exist yet, so a promotion whose successor lands after the
 * reset's revoke is never swept.
 *
 * **Ruling 83 is why the check is not the timestamp alone**, and the second
 * test in this block is the one that ruling asks for: an availability property
 * with no advocate is a property that gets deleted. A concurrent transparent
 * rehash moves `Credential.updatedAt` without changing the password, and a
 * naive predicate would refuse a legitimate promotion for the duration of a
 * parameter migration.
 */
describe('the credential race (D4)', () => {
  it('refuses the promotion when the password was replaced after the pending session was created', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const userId = await userIdOf(email);

    const pendingToken = await pendingLogin(email);

    // The password is replaced while the pending session is outstanding. A real
    // reset would also revoke the pending session; this writes the credential
    // directly so the probe isolates the PREDICATE rather than the revocation
    // that usually gets there first.
    await h.prisma.$transaction([
      h.prisma.credential.update({
        where: { userId },
        data: { passwordHash: await hashOf(NEW_PASSWORD) },
      }),
      h.prisma.platformAuditEvent.create({
        data: {
          id: `pau_${String(Date.now())}${String(counter)}`,
          actorType: 'USER',
          actorId: userId,
          action: 'PASSWORD_RESET_COMPLETED',
          resourceType: 'User',
          resourceId: userId,
          metadata: {},
          ip: null,
          userAgent: null,
          requestId: null,
        },
      }),
    ]);

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: nextCodeFor(secret) });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('MFA_INVALID');
    // THE SURVIVOR COUNT. Zero: the promotion DID happen — `rotate` inserted a
    // row — and was then taken back by the check. `mfa/verify`'s own log line
    // says so, and the pending session it rotated from is revoked either way,
    // so the caller is left holding nothing.
    expect(await promotedSessions(userId)).toBe(0);
  });

  /**
   * RULING 83's OTHER HALF, AND THE TRADE-OFF THIS TASK CHOSE.
   *
   * A transparent rehash moves `Credential.updatedAt` and writes NO audit row.
   * The naive predicate — refuse whenever the timestamp moved — would refuse
   * this promotion, costing a legitimate user a re-login for a maintenance
   * write they did not make. The predicate this task shipped asks WHY the row
   * moved, and stands.
   */
  it('stands when the credential row moved for a rehash rather than a replacement', async () => {
    const email = await account();
    const { secret } = await enableMfa(email);
    const userId = await userIdOf(email);

    const pendingToken = await pendingLogin(email);

    // A rehash: a new hash of the SAME password, and no audit row — which is
    // exactly what `login.service.ts`'s `rehashCredential` writes.
    await h.prisma.credential.update({
      where: { userId },
      data: { passwordHash: await hashOf(PASSWORD) },
    });

    await clearRateLimits(h.redis);
    const response = await request(h.server)
      .post('/api/v1/auth/mfa/verify')
      .send({ pendingToken, code: nextCodeFor(secret) });

    expect(response.status).toBe(200);
    expect(await promotedSessions(userId)).toBe(1);
  });
});
