import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import request from 'supertest';
import {
  type AuthHarness,
  clearRateLimits,
  startAuthHarness,
  tokenFromMail,
} from '../../testing/auth-harness.js';

/**
 * THE ENUMERATION PROPERTY, AS A BYTE COMPARISON.
 *
 * The plan says byte comparison rather than an eyeball check, so this compares
 * the raw response body buffers and the full header set — not a hand-picked
 * subset of fields, which is how a comparison quietly stops covering the field
 * that moved.
 *
 * **Ruling E is about whether this spec can fail.** Carry-forward ruling 58:
 * a suite whose fixtures all sit on one side of the branch under test cannot
 * fail for the right reason, and Task 7's CSRF suite is the standing example.
 * So the property was broken deliberately before this file was believed —
 * `RegistrationService.recordBlockedAttempt` made to throw a 409 — and the
 * failing output is recorded in this task's report. Two guards keep that
 * meaningful here:
 *
 * 1. Every comparison below is against a pair of responses where one address
 *    EXISTS and the other does not, verified by reading the database in the
 *    same test. A pair that were both new addresses would compare identical for
 *    a reason that has nothing to do with the property.
 * 2. `the two paths really did do different things` asserts the mailbox
 *    difference. If registration ever stopped taking the existing-address path
 *    at all, every byte comparison here would pass vacuously and that test
 *    would be the one that went red.
 */

const PASSWORD = 'correct horse battery staple';

/**
 * Headers that differ between any two responses for reasons that have nothing
 * to do with the account, and are therefore excluded from the comparison.
 *
 * Kept as short as it can be, and every entry justified, because this list is
 * the only way the comparison below can be weakened:
 *
 * - `date` is a clock reading to the second.
 * - `x-request-id` is minted per request by `RequestIdMiddleware`, which is the
 *   point of it.
 *
 * `ratelimit-*` are deliberately NOT excluded. They vary with the window's
 * state, so both measured requests are made with the buckets cleared
 * immediately beforehand — which means they must come out equal, and a
 * limiter that charged one path differently from the other would be caught
 * here rather than excused by an exclusion list.
 */
const VOLATILE_HEADERS = new Set(['date', 'x-request-id']);

/**
 * The CSP nonce, blanked rather than the whole header excluded.
 *
 * `SecurityHeadersMiddleware` mints a fresh nonce per response, so
 * `content-security-policy` differs between any two responses — but the rest of
 * that header is a long policy string, and dropping the header entirely would
 * stop comparing all of it. Substituting the nonce keeps every other directive
 * inside the comparison.
 */
const NONCE = /'nonce-[^']+'/g;

/**
 * The per-request correlation id, blanked in an error body the same way the CSP
 * nonce is blanked in a header.
 *
 * Task 8's comparisons were all of 200 responses whose bodies are a single
 * constant literal, so nothing in a body varied. Task 9's login comparisons are
 * of **error envelopes**, and `errorEnvelopeSchema` carries `requestId` — minted
 * per request by `RequestIdMiddleware`, which is the entire point of it, and
 * already excluded from the header comparison as `x-request-id`.
 *
 * Substituted rather than dropped: `code`, `message`, `details` and `timestamp`
 * stay inside the comparison, and it is `code` and `message` that would carry an
 * oracle. The timestamp is a second-resolution clock reading and is left in
 * deliberately — the two requests are made back to back, and if it ever does
 * differ the comparison should fail and be looked at rather than silently
 * excluded.
 */
const REQUEST_ID = /"requestId":"[^"]*"/g;

const comparableBody = (response: Response): Buffer =>
  Buffer.from(response.text.replace(REQUEST_ID, '"requestId":"PER-REQUEST"'));

function comparableHeaders(response: Response): [string, string][] {
  return Object.entries(response.headers)
    .filter(([name]) => !VOLATILE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]): [string, string] => [
      name.toLowerCase(),
      String(value).replace(NONCE, "'nonce-PER-RESPONSE'"),
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

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
  return `enum-${String(counter)}-${String(Date.now())}@example.test`;
};

/** One request, with the rate-limit windows cleared first so its headers are comparable. */
async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  await clearRateLimits(h.redis);
  return request(h.server).post(path).send(body);
}

describe('POST /auth/register answers identically for a new and an existing address', () => {
  it('is byte-identical in status, headers and body', async () => {
    const existingEmail = freshAddress();
    await post('/api/v1/auth/register', { email: existingEmail, password: PASSWORD });
    // The fixtures are on OPPOSITE sides of the branch, and that is checked
    // rather than assumed — see this file's docblock.
    expect(await h.prisma.user.count({ where: { email: existingEmail } })).toBe(1);

    const newEmail = freshAddress();
    expect(await h.prisma.user.count({ where: { email: newEmail } })).toBe(0);

    const forExisting = await post('/api/v1/auth/register', {
      email: existingEmail,
      password: PASSWORD,
    });
    const forNew = await post('/api/v1/auth/register', { email: newEmail, password: PASSWORD });

    expect(forExisting.status).toBe(forNew.status);
    expect(forExisting.status).toBe(200);
    expect(comparableHeaders(forExisting)).toEqual(comparableHeaders(forNew));
    // The bytes, not the parsed object. A body that differed only in key order
    // or in whitespace would still be a difference a client could observe.
    expect(Buffer.from(forExisting.text)).toEqual(Buffer.from(forNew.text));
  });

  it('the two paths really did do different things', async () => {
    // THE ANTI-VACUITY TEST. Everything above compares two responses; this is
    // what proves there were two paths to compare. If the existing-address
    // branch ever stopped being taken, every comparison in this file would go
    // on passing and this would go red.
    const email = freshAddress();
    await post('/api/v1/auth/register', { email, password: PASSWORD });
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['emailVerification']);

    h.sent.length = 0;
    await post('/api/v1/auth/register', { email, password: PASSWORD });
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['registrationAttempt']);
  });

  it('answers the same way whether the existing account is verified or not', async () => {
    const unverified = freshAddress();
    await post('/api/v1/auth/register', { email: unverified, password: PASSWORD });

    const verified = freshAddress();
    await post('/api/v1/auth/register', { email: verified, password: PASSWORD });
    const token = tokenFromMail(h.sent.at(-1));
    await post('/api/v1/auth/verify-email', { token });
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { email: verified } })).emailVerifiedAt,
    ).not.toBeNull();

    const a = await post('/api/v1/auth/register', { email: unverified, password: PASSWORD });
    const b = await post('/api/v1/auth/register', { email: verified, password: PASSWORD });

    expect(a.status).toBe(b.status);
    expect(comparableHeaders(a)).toEqual(comparableHeaders(b));
    expect(Buffer.from(a.text)).toEqual(Buffer.from(b.text));
  });

  it('answers the same way for a LOCKED account', async () => {
    const locked = freshAddress();
    await post('/api/v1/auth/register', { email: locked, password: PASSWORD });
    await h.prisma.user.update({ where: { email: locked }, data: { status: 'LOCKED' } });

    const a = await post('/api/v1/auth/register', { email: locked, password: PASSWORD });
    const b = await post('/api/v1/auth/register', {
      email: freshAddress(),
      password: PASSWORD,
    });

    expect(a.status).toBe(b.status);
    expect(comparableHeaders(a)).toEqual(comparableHeaders(b));
    expect(Buffer.from(a.text)).toEqual(Buffer.from(b.text));
  });
});

describe('POST /auth/resend-verification answers identically in all three cases', () => {
  it('is byte-identical for no account, an unverified account and a verified one', async () => {
    // Ruling G: three cases, one response.
    const unknown = `never-registered-${String(Date.now())}@example.test`;

    const unverified = freshAddress();
    await post('/api/v1/auth/register', { email: unverified, password: PASSWORD });

    const verified = freshAddress();
    await post('/api/v1/auth/register', { email: verified, password: PASSWORD });
    await post('/api/v1/auth/verify-email', { token: tokenFromMail(h.sent.at(-1)) });

    // The three fixtures are genuinely in three different states.
    expect(await h.prisma.user.count({ where: { email: unknown } })).toBe(0);
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { email: unverified } })).emailVerifiedAt,
    ).toBeNull();
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { email: verified } })).emailVerifiedAt,
    ).not.toBeNull();

    const responses = [
      await post('/api/v1/auth/resend-verification', { email: unknown }),
      await post('/api/v1/auth/resend-verification', { email: unverified }),
      await post('/api/v1/auth/resend-verification', { email: verified }),
    ];

    const [first, ...rest] = responses;
    if (first === undefined) throw new Error('unreachable');
    for (const other of rest) {
      expect(other.status).toBe(first.status);
      expect(comparableHeaders(other)).toEqual(comparableHeaders(first));
      expect(Buffer.from(other.text)).toEqual(Buffer.from(first.text));
    }
    expect(first.status).toBe(200);
  });

  it('really did take three different paths', async () => {
    // The anti-vacuity test again, for the resend. Only the unverified account
    // produces a message; if all three started sending, or none did, this goes
    // red while the comparison above stays green.
    const unverified = freshAddress();
    await post('/api/v1/auth/register', { email: unverified, password: PASSWORD });
    h.sent.length = 0;

    await post('/api/v1/auth/resend-verification', {
      email: `never-registered-${String(Date.now())}@example.test`,
    });
    expect(h.sent).toEqual([]);

    await post('/api/v1/auth/resend-verification', { email: unverified });
    expect(h.sent.map((mail) => mail.templateId)).toEqual(['emailVerification']);
  });
});

describe('POST /auth/login answers identically for a wrong password and an unknown address', () => {
  /**
   * THE COMPARISON TASK 9 OWES, AND IT IS THE SHARPEST ONE IN THIS FILE.
   *
   * Registration's two paths differ in a mailbox. Login's two failing paths
   * differ in nothing at all — one has an account behind it and one does not —
   * and the whole of `security/authentication.md` §7's "responses that do not
   * distinguish existing from non-existing accounts" rests on that being true
   * byte for byte, not approximately.
   *
   * The fixtures sit on opposite sides of the branch and it is checked rather
   * than assumed, exactly as the registration block above does it: the
   * existing account is read back out of the database, and the unknown address
   * is confirmed absent.
   */
  it('is byte-identical in status, headers and body', async () => {
    const registered = freshAddress();
    await post('/api/v1/auth/register', { email: registered, password: PASSWORD });
    expect(await h.prisma.user.count({ where: { email: registered } })).toBe(1);

    const unknown = `never-registered-${String(Date.now())}@example.test`;
    expect(await h.prisma.user.count({ where: { email: unknown } })).toBe(0);

    const forExisting = await post('/api/v1/auth/login', {
      email: registered,
      password: 'a completely different password',
    });
    const forUnknown = await post('/api/v1/auth/login', {
      email: unknown,
      password: 'a completely different password',
    });

    expect(forExisting.status).toBe(401);
    expect(forUnknown.status).toBe(forExisting.status);
    expect(comparableHeaders(forUnknown)).toEqual(comparableHeaders(forExisting));
    expect(comparableBody(forUnknown)).toEqual(comparableBody(forExisting));
  });

  it('is byte-identical for an account that has no credential row at all', async () => {
    // A third case reaching the same 401: `Credential` is a separate table and
    // a `User` can exist without one. It takes the nullable-hash path, so it
    // costs the same Argon2id verification and answers the same bytes.
    const orphaned = freshAddress();
    await post('/api/v1/auth/register', { email: orphaned, password: PASSWORD });
    await h.prisma.credential.deleteMany({
      where: { user: { email: orphaned } },
    });

    const unknown = `never-registered-${String(Date.now())}@example.test`;
    const a = await post('/api/v1/auth/login', { email: orphaned, password: PASSWORD });
    const b = await post('/api/v1/auth/login', { email: unknown, password: PASSWORD });

    expect(a.status).toBe(401);
    expect(comparableHeaders(a)).toEqual(comparableHeaders(b));
    expect(comparableBody(a)).toEqual(comparableBody(b));
  });

  it('does not distinguish a LOCKED account from an unknown one on a WRONG password', async () => {
    // D3's rule, as a byte comparison. `ACCOUNT_LOCKED` is returned only when
    // the password was otherwise correct; answering it to any attempt would
    // confirm the address is registered to exactly the caller who has just
    // demonstrated they will make five attempts.
    const locked = freshAddress();
    await post('/api/v1/auth/register', { email: locked, password: PASSWORD });
    await h.prisma.user.update({
      where: { email: locked },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 600_000) },
    });

    const unknown = `never-registered-${String(Date.now())}@example.test`;
    const a = await post('/api/v1/auth/login', { email: locked, password: 'wrong wrong wrong' });
    const b = await post('/api/v1/auth/login', { email: unknown, password: 'wrong wrong wrong' });

    expect(a.status).toBe(401);
    expect(comparableHeaders(a)).toEqual(comparableHeaders(b));
    expect(comparableBody(a)).toEqual(comparableBody(b));
  });

  it('really did take two different paths', async () => {
    // THE ANTI-VACUITY TEST, and this file's own docblock explains why it is
    // here: every comparison above would pass identically if login had simply
    // stopped finding accounts. The difference between the paths is in the
    // audit table — one row names the account, one names nothing — and that is
    // where it is checked, because the wire deliberately shows nothing.
    const registered = freshAddress();
    await post('/api/v1/auth/register', { email: registered, password: PASSWORD });
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email: registered } });

    await post('/api/v1/auth/login', { email: registered, password: 'wrong wrong wrong' });
    expect(
      await h.prisma.platformAuditEvent.count({
        where: { action: 'LOGIN_FAILED', resourceId: user.id },
      }),
    ).toBe(1);

    const before = await h.prisma.platformAuditEvent.count({
      where: { action: 'LOGIN_FAILED', resourceId: null },
    });
    await post('/api/v1/auth/login', {
      email: `never-registered-${String(Date.now())}@example.test`,
      password: 'wrong wrong wrong',
    });
    expect(
      await h.prisma.platformAuditEvent.count({
        where: { action: 'LOGIN_FAILED', resourceId: null },
      }),
    ).toBe(before + 1);
  });
});

describe('the response body is a constant', () => {
  it('carries exactly one field, whose value cannot vary with the account', async () => {
    // The structural reason the comparisons above hold: there is no field that
    // could carry an account-dependent value. A later task widening these
    // response schemas has to come past this test.
    const response = await post('/api/v1/auth/register', {
      email: freshAddress(),
      password: PASSWORD,
    });
    expect(response.body).toEqual({ status: 'VERIFICATION_REQUIRED' });

    const resend = await post('/api/v1/auth/resend-verification', { email: freshAddress() });
    expect(resend.body).toEqual({ status: 'VERIFICATION_REQUIRED' });
  });

  it('returns 200 rather than 201, so the status line is not the oracle', async () => {
    // `api/conventions.md` §2 gives 201 to a creation "with `Location`". A 201
    // for a new address beside a 200 for an existing one would put the whole
    // disclosure in the status line, and a `Location` header would name the
    // account outright.
    const response = await post('/api/v1/auth/register', {
      email: freshAddress(),
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(response.headers['location']).toBeUndefined();
  });
});
