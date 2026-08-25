import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@sentinel/db';
import { startPostgresHarness, type PostgresHarness } from '@sentinel/db/testing';
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import { hashSecretToken } from './secret-token.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * THE PROPERTIES ONLY A REAL DATABASE CAN PROVE.
 *
 * Single use, expiry and supersession are all statements about what one
 * `UPDATE` does to a row that another statement may be touching at the same
 * instant. A fake makes every one of them true by construction, so the only
 * honest place to assert them is against Postgres — and the concurrency case is
 * the one that actually distinguishes this implementation from the wrong one.
 * A read-then-write `consume` passes every sequential test in this file and
 * loses only that test, which is why it is the deliverable.
 *
 * **The Testcontainers harness, not the compose stack.** Every other `apps/api`
 * integration spec reaches Redis or MinIO through the root `.env` and the
 * running compose stack, and CI never applies migrations to that database —
 * `.github/workflows/ci.yml` brings compose up and goes straight to
 * `pnpm test:integration`. A spec that inserts into `VerificationToken` against
 * the compose database would pass locally and fail in CI with "relation does
 * not exist". `startPostgresHarness` starts its own Postgres 16 and runs
 * `prisma migrate deploy` first, which is why every table-touching integration
 * spec in this repository uses it.
 */
const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

/**
 * A service whose tokens are born an hour expired.
 *
 * `packages/config` refuses a TTL below 1, so this shape is unreachable through
 * configuration — the spec constructs it directly. It is preferred over
 * back-dating the row with an UPDATE because it exercises the real
 * issue-then-consume path and proves the predicate reads the stored column
 * rather than anything the consume call was told.
 */
const EXPIRED_TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: -3_600,
  PASSWORD_RESET: -3_600,
  INVITATION: -3_600,
};

let harness: PostgresHarness;
let prisma: PrismaClient;
let service: TokenService;

const userA = newId('usr');
const userB = newId('usr');

beforeAll(async () => {
  harness = await startPostgresHarness();
  prisma = createUnscopedPrismaClient(harness.ownerUrl);
  service = new TokenService(prisma, TTL);

  await prisma.user.createMany({
    data: [
      { id: userA, email: 'token-a@example.test' },
      { id: userB, email: 'token-b@example.test' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await harness?.stop();
});

describe('issuing a token', () => {
  it('stores only the hash — the database cannot mint a valid token', async () => {
    // Critical security rule 5, and schema.prisma's own comment on the model.
    const issued = await service.issue({ userId: userA, purpose: 'EMAIL_VERIFICATION' });
    const row = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });

    expect(row.tokenHash).toBe(hashSecretToken(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.consumedAt).toBeNull();
    expect(row.userId).toBe(userA);
  });

  it('stamps the expiry from the purpose TTL, in the database', async () => {
    const issued = await service.issue({ userId: userA, purpose: 'PASSWORD_RESET' });
    const row = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });

    // Timestamptz(6) round-trips to the same instant the caller was given.
    expect(row.expiresAt.toISOString()).toBe(issued.expiresAt.toISOString());
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(3_500_000);
  });
});

describe('consuming a token', () => {
  it('accepts a valid token once and reports whose it was', async () => {
    const issued = await service.issue({ userId: userA, purpose: 'EMAIL_VERIFICATION' });
    const result = await service.consume({
      token: issued.token,
      purpose: 'EMAIL_VERIFICATION',
    });

    expect(result?.userId).toBe(userA);
    const row = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.consumedAt).not.toBeNull();
  });

  it('refuses the second sequential redemption of the same token', async () => {
    // Single use, §6. The first call set consumedAt, so the predicate's
    // `consumedAt IS NULL` no longer matches and the count is 0.
    const issued = await service.issue({ userId: userA, purpose: 'PASSWORD_RESET' });
    expect(
      await service.consume({ token: issued.token, purpose: 'PASSWORD_RESET' }),
    ).not.toBeNull();
    expect(await service.consume({ token: issued.token, purpose: 'PASSWORD_RESET' })).toBeNull();
  });

  it('refuses an expired token', async () => {
    const expiring = new TokenService(prisma, EXPIRED_TTL);
    const issued = await expiring.issue({ userId: userA, purpose: 'PASSWORD_RESET' });

    expect(await expiring.consume({ token: issued.token, purpose: 'PASSWORD_RESET' })).toBeNull();
    // Refused, and NOT consumed: a refusal must not burn the row, or an
    // attacker could invalidate someone's live link by replaying an expired one.
    const row = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.consumedAt).toBeNull();
  });

  it('refuses a token that never existed', async () => {
    expect(
      await service.consume({ token: 'not-a-token-anyone-issued', purpose: 'PASSWORD_RESET' }),
    ).toBeNull();
  });

  it('refuses a token presented for the wrong purpose', async () => {
    // A verification link must not be redeemable at the reset endpoint. The
    // purpose is part of the UPDATE's predicate, so the count is 0 and the row
    // survives for its real purpose.
    const issued = await service.issue({ userId: userB, purpose: 'EMAIL_VERIFICATION' });

    expect(await service.consume({ token: issued.token, purpose: 'PASSWORD_RESET' })).toBeNull();
    expect(
      await service.consume({ token: issued.token, purpose: 'EMAIL_VERIFICATION' }),
    ).not.toBeNull();
  });
});

describe('supersession', () => {
  it('invalidates the previous token of the same purpose when a new one is issued', async () => {
    // §6: "invalidated by use or by a newer token". The user who clicks "resend"
    // and then opens the first email must find that link dead.
    const first = await service.issue({ userId: userB, purpose: 'PASSWORD_RESET' });
    const second = await service.issue({ userId: userB, purpose: 'PASSWORD_RESET' });

    expect(await service.consume({ token: first.token, purpose: 'PASSWORD_RESET' })).toBeNull();
    expect(
      await service.consume({ token: second.token, purpose: 'PASSWORD_RESET' }),
    ).not.toBeNull();
  });

  it("leaves the same user's other purpose alone", async () => {
    const verification = await service.issue({ userId: userA, purpose: 'EMAIL_VERIFICATION' });
    await service.issue({ userId: userA, purpose: 'PASSWORD_RESET' });

    expect(
      await service.consume({ token: verification.token, purpose: 'EMAIL_VERIFICATION' }),
    ).not.toBeNull();
  });

  it("leaves another user's token of the same purpose alone", async () => {
    const mine = await service.issue({ userId: userA, purpose: 'PASSWORD_RESET' });
    await service.issue({ userId: userB, purpose: 'PASSWORD_RESET' });

    expect(await service.consume({ token: mine.token, purpose: 'PASSWORD_RESET' })).not.toBeNull();
  });
});

describe('two concurrent redemptions of one reset link', () => {
  it('produces exactly one success and one refusal', async () => {
    // THE TEST THIS TASK EXISTS FOR. A read-then-write consume passes every
    // sequential case above and loses this one: both requests read
    // `consumedAt IS NULL`, both decide to accept, and one password-reset link
    // resets the account twice. Proven to fail by temporarily reimplementing
    // consume that way — both outputs are in the task's report.
    const issued = await service.issue({ userId: userA, purpose: 'PASSWORD_RESET' });

    const results = await Promise.all([
      service.consume({ token: issued.token, purpose: 'PASSWORD_RESET' }),
      service.consume({ token: issued.token, purpose: 'PASSWORD_RESET' }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.find((result) => result !== null)?.userId).toBe(userA);
  });

  it('holds across a wider burst', async () => {
    // Two is the case the plan names; eight is cheap and catches an
    // implementation that happens to serialise two requests by accident.
    const issued = await service.issue({ userId: userB, purpose: 'EMAIL_VERIFICATION' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.consume({ token: issued.token, purpose: 'EMAIL_VERIFICATION' }),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('lets two different tokens through concurrently — the lock is per row', async () => {
    // The negative control. A test that accepted exactly one of everything
    // would also pass if `consume` took a global lock and only ever succeeded
    // once, which would be a correctness disaster wearing this spec's green.
    const first = await service.issue({ userId: userA, purpose: 'EMAIL_VERIFICATION' });
    const second = await service.issue({ userId: userB, purpose: 'PASSWORD_RESET' });

    const results = await Promise.all([
      service.consume({ token: first.token, purpose: 'EMAIL_VERIFICATION' }),
      service.consume({ token: second.token, purpose: 'PASSWORD_RESET' }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(2);
  });
});

describe('two concurrent issue calls for the same user and purpose', () => {
  it('leave exactly one live token — supersession is not a sequential-only promise', async () => {
    // THE DEFECT THE FIRST ROUND SHIPPED, one layer above the one it was
    // commissioned to close. `security/authentication.md` §6 says a token is
    // "invalidated by use or by a newer token", unqualified, and `issue`'s
    // supersede-then-insert runs inside a transaction — which is exactly why it
    // looks safe and is not. Under Postgres's default READ COMMITTED, a second
    // transaction's `UPDATE ... WHERE consumedAt IS NULL` cannot see the first
    // one's uncommitted `INSERT`, so it supersedes nothing and both rows commit
    // live. `@@index([userId, purpose])` is not unique, so the database does not
    // arbitrate either.
    //
    // Ten rounds rather than one: a race that resolves correctly by luck once is
    // a green test, and the reviewer measured this failing 24 times in 25.
    const userId = newId('usr');
    await prisma.user.create({ data: { id: userId, email: `race-${userId}@example.test` } });

    const liveCounts: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        service.issue({ userId, purpose: 'PASSWORD_RESET' }),
        service.issue({ userId, purpose: 'PASSWORD_RESET' }),
      ]);
      liveCounts.push(
        await prisma.verificationToken.count({
          where: { userId, purpose: 'PASSWORD_RESET', consumedAt: null },
        }),
      );
      await prisma.verificationToken.deleteMany({ where: { userId } });
    }

    expect(liveCounts).toEqual(Array.from({ length: 10 }, () => 1));
  });

  it('still supersede across purposes independently — the lock is not global', async () => {
    // The negative control, matching the one on `consume` above: a fix that
    // serialised every issue in the process would also make the test above
    // green, and would be a throughput disaster wearing a passing spec. Two
    // different purposes for one user must both end up live.
    const userId = newId('usr');
    await prisma.user.create({ data: { id: userId, email: `pair-${userId}@example.test` } });

    await Promise.all([
      service.issue({ userId, purpose: 'PASSWORD_RESET' }),
      service.issue({ userId, purpose: 'EMAIL_VERIFICATION' }),
    ]);

    const live = await prisma.verificationToken.count({
      where: { userId, consumedAt: null },
    });
    expect(live).toBe(2);
  });
});
