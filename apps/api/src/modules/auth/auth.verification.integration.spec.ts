import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import {
  type AuthHarness,
  clearRateLimits,
  startAuthHarness,
  tokenFromMail,
} from '../../testing/auth-harness.js';
import { hashSecretToken } from './secret-token.js';

/**
 * REGISTRATION AND VERIFICATION, END TO END, AGAINST A REAL POSTGRES.
 *
 * The unit specs assert ordering and branching against fakes. Everything here
 * needs the database to be real: that the credential stored is an Argon2id PHC
 * string and not the password, that the token row holds only a hash, that a
 * redeemed link cannot be redeemed twice, that a resend invalidates the earlier
 * link, that a refused redemption is rolled back rather than burned, and that
 * `PlatformAuditEvent` is append-only below the application.
 */

const PASSWORD = 'correct horse battery staple';

let h: AuthHarness;
/** A second client, connected as the least-privileged application role. */
let appRole: PrismaClient;

beforeAll(async () => {
  h = await startAuthHarness();
  appRole = createUnscopedPrismaClient(h.postgres.appUrl);
}, 240_000);

afterAll(async () => {
  await appRole?.$disconnect();
  await h?.stop();
});

beforeEach(async () => {
  await clearRateLimits(h.redis);
  h.sent.length = 0;
});

let addressCounter = 0;
const freshAddress = (): string => {
  addressCounter += 1;
  return `task8-${String(addressCounter)}-${String(Date.now())}@example.test`;
};

async function register(email: string, name?: string) {
  return request(h.server)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, ...(name === undefined ? {} : { name }) })
    .expect(200);
}

const codeOf = (body: unknown): string => errorEnvelopeSchema.parse(body).error.code;

describe('registering a new address', () => {
  it('creates the user, the credential and the verification token, and audits it', async () => {
    const email = freshAddress();
    const response = await register(email, 'Ada Lovelace');
    expect(response.body).toEqual({ status: 'VERIFICATION_REQUIRED' });

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.name).toBe('Ada Lovelace');

    const credential = await h.prisma.credential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    // Critical security rule 5. The stored value is a PHC string carrying its
    // own parameters, and the password is nowhere in the row.
    expect(credential.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(credential)).not.toContain(PASSWORD);

    const token = await h.prisma.verificationToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
    });
    expect(token.consumedAt).toBeNull();
    // The raw token exists only in the message.
    expect(token.tokenHash).toBe(hashSecretToken(tokenFromMail(h.sent[0])));

    const events = await h.prisma.platformAuditEvent.findMany({
      where: { resourceId: user.id },
    });
    expect(events.map((event) => event.action)).toEqual(['USER_REGISTERED']);
    expect(events[0]?.actorType).toBe('USER');
    expect(events[0]?.actorId).toBe(user.id);
    expect(JSON.stringify(events[0]?.metadata)).not.toContain(tokenFromMail(h.sent[0]));
  });

  it('writes no AuditEvent row, because there is no organisation to write one for', async () => {
    // ADR-0019's routing rule, asserted rather than described. `AuditEvent`'s
    // `organizationId` is NOT NULL with a `Restrict` FK, so a row here would
    // have needed a fabricated organisation id.
    const before = await h.prisma.auditEvent.count();
    await register(freshAddress());
    expect(await h.prisma.auditEvent.count()).toBe(before);
  });

  it('sends the verification link, and it carries the token as ?token=', async () => {
    await register(freshAddress());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.templateId).toBe('emailVerification');
    expect(tokenFromMail(h.sent[0]).length).toBeGreaterThan(20);
  });
});

describe('registering an address that already exists', () => {
  it('creates nothing, audits the attempt, and sends the notice instead', async () => {
    const email = freshAddress();
    await register(email, 'Ada Lovelace');
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    await clearRateLimits(h.redis);
    h.sent.length = 0;

    await request(h.server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'a completely different password' })
      .expect(200);

    // One user, one credential, one token: nothing was added.
    expect(await h.prisma.user.count({ where: { email } })).toBe(1);
    expect(await h.prisma.verificationToken.count({ where: { userId: user.id } })).toBe(1);
    // The name is untouched, so the second registration's absent name did not
    // overwrite the first's.
    expect((await h.prisma.user.findUniqueOrThrow({ where: { email } })).name).toBe('Ada Lovelace');

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.templateId).toBe('registrationAttempt');
    expect(h.sent[0]?.to).toBe(email);

    const events = await h.prisma.platformAuditEvent.findMany({
      where: { resourceId: user.id, action: 'REGISTRATION_BLOCKED_EXISTING_EMAIL' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBeNull();
    expect(events[0]?.actorType).toBe('SYSTEM');
  });
});

describe('verifying an address', () => {
  it('stamps emailVerifiedAt, consumes the token, and audits it', async () => {
    const email = freshAddress();
    await register(email);
    const token = tokenFromMail(h.sent[0]);
    await clearRateLimits(h.redis);

    const response = await request(h.server)
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);
    expect(response.body).toEqual({ status: 'EMAIL_VERIFIED' });

    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const row = await h.prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashSecretToken(token) },
    });
    expect(row.consumedAt).not.toBeNull();
    // The same instant on both, not two readings of the clock.
    expect(user.emailVerifiedAt?.toISOString()).toBe(row.consumedAt?.toISOString());

    const actions = (
      await h.prisma.platformAuditEvent.findMany({
        where: { resourceId: user.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.action);
    expect(actions).toEqual(['USER_REGISTERED', 'EMAIL_VERIFIED']);
  });

  it('refuses the same link a second time with TOKEN_INVALID', async () => {
    const email = freshAddress();
    await register(email);
    const token = tokenFromMail(h.sent[0]);
    await clearRateLimits(h.redis);

    await request(h.server).post('/api/v1/auth/verify-email').send({ token }).expect(200);
    const second = await request(h.server)
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(422);
    expect(codeOf(second.body)).toBe('TOKEN_INVALID');
  });

  it('refuses an unknown token with the same code and message', async () => {
    // One code for four outcomes. If "unknown" and "already used" differed, the
    // endpoint would confirm that a token had once existed — which confirms the
    // address is registered.
    const email = freshAddress();
    await register(email);
    const real = tokenFromMail(h.sent[0]);
    await clearRateLimits(h.redis);

    await request(h.server).post('/api/v1/auth/verify-email').send({ token: real }).expect(200);
    const used = await request(h.server)
      .post('/api/v1/auth/verify-email')
      .send({ token: real })
      .expect(422);
    const unknown = await request(h.server)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'FIXTURE_not_a_real_token-unknown_0000000000' })
      .expect(422);

    // Everything but the correlation id, which is minted per request and is
    // the one field in the envelope that is meant to differ.
    const withoutRequestId = (body: unknown) => {
      const { requestId: _ignored, ...rest } = errorEnvelopeSchema.parse(body).error;
      return rest;
    };
    expect(withoutRequestId(unknown.body)).toEqual(withoutRequestId(used.body));
  });

  // BOTH non-ACTIVE arms, not just the one. M2: with only the LOCKED case here,
  // narrowing the service's check from `status !== 'ACTIVE'` to
  // `status === 'LOCKED'` left 1085 unit and 39 integration tests green — a
  // DISABLED account's verification link redeemed and nothing went red. The
  // DISABLED fixture that did exist covered `resend`, not `verify`, and `verify`
  // is the path carry-forward ruling 37 named.
  it.each(['LOCKED', 'DISABLED'] as const)(
    'refuses a %s account and leaves the token unconsumed',
    async (status) => {
      // Carry-forward ruling 37. `TokenService.consume` asserts nothing about the
      // user, the FK cascade only clears a DELETED user's rows, and there is no
      // RLS behind `VerificationToken` — so without the endpoint's own check this
      // would succeed. The rollback is the second half: refusing must not destroy
      // a credential that restoring the account would make usable again.
      const email = freshAddress();
      await register(email);
      const token = tokenFromMail(h.sent[0]);
      const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });
      await h.prisma.user.update({ where: { id: user.id }, data: { status } });
      await clearRateLimits(h.redis);

      const refused = await request(h.server)
        .post('/api/v1/auth/verify-email')
        .send({ token })
        .expect(422);
      expect(codeOf(refused.body)).toBe('TOKEN_INVALID');

      const row = await h.prisma.verificationToken.findUniqueOrThrow({
        where: { tokenHash: hashSecretToken(token) },
      });
      expect(row.consumedAt).toBeNull();
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt,
      ).toBeNull();

      // And it works again once the account is ACTIVE.
      await h.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
      await clearRateLimits(h.redis);
      await request(h.server).post('/api/v1/auth/verify-email').send({ token }).expect(200);
    },
  );
});

describe('resending the verification link', () => {
  it('invalidates the previous link — the property that makes a resend safe', async () => {
    // RULING G SAYS VERIFY THIS RATHER THAN ASSUME IT.
    const email = freshAddress();
    await register(email);
    const first = tokenFromMail(h.sent[0]);
    await clearRateLimits(h.redis);
    h.sent.length = 0;

    await request(h.server).post('/api/v1/auth/resend-verification').send({ email }).expect(200);
    const second = tokenFromMail(h.sent[0]);
    expect(second).not.toBe(first);
    await clearRateLimits(h.redis);

    const stale = await request(h.server)
      .post('/api/v1/auth/verify-email')
      .send({ token: first })
      .expect(422);
    expect(codeOf(stale.body)).toBe('TOKEN_INVALID');

    await request(h.server).post('/api/v1/auth/verify-email').send({ token: second }).expect(200);
  });

  it('leaves exactly one live token, which the partial unique index also requires', async () => {
    const email = freshAddress();
    await register(email);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email } });

    for (let round = 0; round < 3; round += 1) {
      await clearRateLimits(h.redis);
      await request(h.server).post('/api/v1/auth/resend-verification').send({ email }).expect(200);
    }

    expect(
      await h.prisma.verificationToken.count({
        where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null },
      }),
    ).toBe(1);
  });

  it('sends nothing for an unknown address, a verified one, or a locked one', async () => {
    const unknown = `never-registered-${String(Date.now())}@example.test`;
    await request(h.server)
      .post('/api/v1/auth/resend-verification')
      .send({ email: unknown })
      .expect(200);
    expect(h.sent).toEqual([]);

    const verified = freshAddress();
    await clearRateLimits(h.redis);
    await register(verified);
    const token = tokenFromMail(h.sent[0]);
    await clearRateLimits(h.redis);
    await request(h.server).post('/api/v1/auth/verify-email').send({ token }).expect(200);
    h.sent.length = 0;
    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/resend-verification')
      .send({ email: verified })
      .expect(200);
    expect(h.sent).toEqual([]);

    const locked = freshAddress();
    await clearRateLimits(h.redis);
    await register(locked);
    await h.prisma.user.update({ where: { email: locked }, data: { status: 'LOCKED' } });
    h.sent.length = 0;
    await clearRateLimits(h.redis);
    await request(h.server)
      .post('/api/v1/auth/resend-verification')
      .send({ email: locked })
      .expect(200);
    expect(h.sent).toEqual([]);
  });
});

describe('PlatformAuditEvent is append-only below the application', () => {
  it('refuses UPDATE and DELETE for the application role', async () => {
    // `security/audit.md` §2, for the second table. Both the revoked grant and
    // the trigger are asserted through the least-privileged role, which is the
    // role the application actually connects as in every environment but this
    // spec's own harness.
    await register(freshAddress());
    expect(await appRole.platformAuditEvent.count()).toBeGreaterThan(0);

    await expect(
      appRole.$executeRaw`UPDATE "PlatformAuditEvent" SET "action" = 'TAMPERED'`,
    ).rejects.toThrow();
    await expect(appRole.$executeRaw`DELETE FROM "PlatformAuditEvent"`).rejects.toThrow();
  });

  it('refuses UPDATE for the owner too, because the trigger is not a grant', async () => {
    // The revoke stops `sentinel_app`; the trigger stops everyone short of a
    // superuser disabling it. Without this the two controls are untestable
    // apart, and a future migration dropping the trigger would go unnoticed.
    await register(freshAddress());
    await expect(
      h.prisma.$executeRaw`UPDATE "PlatformAuditEvent" SET "action" = 'TAMPERED'`,
    ).rejects.toThrow(/append-only/);
  });
});
