import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@sentinel/db';
import { type PostgresHarness, startPostgresHarness } from '@sentinel/db/testing';
import { type PrismaClient, createUnscopedPrismaClient } from '@sentinel/db/unscoped';
import { createLogger } from '@sentinel/observability';
import { config as loadDotenv } from 'dotenv';
import { Redis } from 'ioredis';
import { hashSecretToken, mintSecretToken } from './secret-token.js';
import { RedisSessionCache } from './session.cache.js';
import { SessionRepository } from './session.repository.js';
import {
  type SessionPolicy,
  SessionService,
  type SessionResolution,
  sessionCacheKey,
} from './session.service.js';

/**
 * THE PROPERTIES ONLY A REAL DATABASE AND A REAL REDIS CAN PROVE.
 *
 * Four of them, and every one is false-by-construction against a fake:
 *
 * 1. **Revocation is immediate**, including when a resolve is already in flight
 *    over the revocation. This is one of the three Phase 2 exit criteria and it
 *    is the one most easily satisfied only *eventually*.
 * 2. **The two lifetimes are enforced independently.** `schema.prisma`'s comment
 *    on `Session` describes exactly the failure a single-column design produces;
 *    a test that exercises only one clock reproduces it.
 * 3. **Rotation under concurrency yields exactly one live successor.**
 *    Carry-forward ruling 31 requires this to be measured rather than argued.
 * 4. **An unreachable Redis degrades to Postgres**, which is the promise
 *    ADR-0005 makes in its Consequences section.
 *
 * **Postgres comes from the Testcontainers harness, Redis from compose.** The
 * split is not arbitrary. CI never applies migrations to the compose database
 * (`.github/workflows/ci.yml` brings compose up and goes straight to
 * `pnpm test:integration`), so a spec inserting into `Session` against it would
 * pass locally and fail in CI with "relation does not exist". Redis has no
 * schema, so the compose instance is the real thing at no cost — which is also
 * why carry-forward ruling 33 applies: **this file deletes the keys it created,
 * by key, and never `FLUSHDB`.** The rate-limit specs live in the same instance.
 */
loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });

const POLICY: SessionPolicy = {
  absoluteLifetimeSeconds: 604_800,
  rememberMeLifetimeSeconds: 2_592_000,
  idleTimeoutSeconds: 86_400,
  pendingMfaLifetimeSeconds: 600,
  cacheTtlSeconds: 60,
};

const HOUR = 60 * 60 * 1_000;

const logger = createLogger({ service: 'test', level: 'warn', pretty: false, silent: true });

let harness: PostgresHarness;
let prisma: PrismaClient;
let redis: Redis;
let repository: SessionRepository;
let service: SessionService;
/** A second service whose Redis is a port nothing listens on. */
let offline: SessionService;
let offlineRedis: Redis;

const userA = newId('usr');
const userB = newId('usr');
/** Used by exactly one test, which counts every session this user has. */
const userC = newId('usr');
const orgA = newId('org');
const orgB = newId('org');

beforeAll(async () => {
  harness = await startPostgresHarness();
  prisma = createUnscopedPrismaClient(harness.ownerUrl);
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
  });

  repository = new SessionRepository(prisma);
  service = new SessionService(repository, new RedisSessionCache(redis, logger), POLICY, logger);

  // A second application pointed at a port nothing is listening on, rather than
  // stopping the shared container: the compose Redis is used by every other
  // integration suite and by the developer's own session. The same device
  // `rate-limit.integration.spec.ts` uses, and for the same reason.
  offlineRedis = new Redis('redis://127.0.0.1:6399', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  offlineRedis.on('error', () => {
    // Expected, continuously. Node terminates a process for an unhandled
    // 'error' event on an EventEmitter, which would kill the whole run.
  });
  offline = new SessionService(
    repository,
    new RedisSessionCache(offlineRedis, logger),
    POLICY,
    logger,
  );

  await prisma.user.createMany({
    data: [
      { id: userA, email: 'session-a@example.test' },
      { id: userB, email: 'session-b@example.test' },
      { id: userC, email: 'session-c@example.test' },
    ],
  });
}, 180_000);

afterAll(async () => {
  // Ruling 33: by key, never FLUSHDB. Every session this file created lives in
  // its own container, so the table is the complete list of keys it touched.
  const rows = await prisma.session.findMany({ select: { tokenHash: true } });
  const keys = rows.map((row) => sessionCacheKey(row.tokenHash));
  if (keys.length > 0) await redis.del(...keys);

  await redis.quit();
  offlineRedis.disconnect();
  await prisma?.$disconnect();
  await harness?.stop();
});

/**
 * A session row written directly, so a clock can be set to a value `issue`
 * would never produce.
 *
 * `issue` clamps the idle expiry to the absolute one, which is right for a real
 * session and useless for testing the two clocks *independently* — the whole
 * point is to expire one while the other is fresh.
 */
async function plant(input: {
  userId?: string;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  lastSeenAt?: Date;
  activeOrganizationId?: string | null;
  revokedAt?: Date | null;
}): Promise<{ token: string; id: string }> {
  const minted = mintSecretToken();
  const id = newId('ses');
  await prisma.session.create({
    data: {
      id,
      userId: input.userId ?? userA,
      tokenHash: minted.tokenHash,
      status: 'ACTIVE',
      absoluteExpiresAt: input.absoluteExpiresAt,
      idleExpiresAt: input.idleExpiresAt,
      lastSeenAt: input.lastSeenAt ?? new Date(),
      activeOrganizationId: input.activeOrganizationId ?? null,
      revokedAt: input.revokedAt ?? null,
    },
  });
  return { token: minted.token, id };
}

describe('revocation is immediate', () => {
  it('refuses the very next resolve after a revoke', async () => {
    // THE PHASE EXIT CRITERION. Resolve first, so the entry is genuinely warm
    // in Redis and the refusal cannot come from a cache that never held it.
    const issued = await service.issue({ userId: userA, status: 'ACTIVE' });
    expect((await service.resolve(issued.token)).outcome).toBe('resolved');
    expect(await redis.get(sessionCacheKey(hashSecretToken(issued.token)))).not.toBeNull();

    expect(await service.revoke(issued.session.id)).toBe(true);

    expect(await service.resolve(issued.token)).toEqual({ outcome: 'revoked' });
  });

  it('refuses even when a resolve was already in flight over the revocation', async () => {
    // THE TEST THIS DESIGN EXISTS FOR, and the one a `DEL`-then-`SET` cache
    // fails. The racing resolve has already read a live row from Postgres when
    // the revocation lands; all that is left of it is the cache write. If that
    // write can land on the key, the revoked session is served from cache until
    // the TTL expires — "eventually immediate", which is not what §3 promises.
    //
    // The pause is injected by wrapping the repository, not by adding a seam to
    // the service: production code with a test hook in it is production code
    // that can be paused in production.
    const issued = await service.issue({ userId: userA, status: 'ACTIVE' });

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Two signals, not one. Without `hasRead` the revocation could land before
    // the racing resolve had read anything, and the test would pass without ever
    // creating the interleaving it exists to test — green for the wrong reason.
    let markRead = (): void => {};
    const hasRead = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const paused = new Proxy(repository, {
      get(target, property, receiver: unknown) {
        if (property !== 'findByTokenHash') return Reflect.get(target, property, receiver);
        return async (tokenHash: string) => {
          const row = await target.findByTokenHash(tokenHash);
          markRead();
          await gate;
          return row;
        };
      },
    });

    const racing = new SessionService(paused, new RedisSessionCache(redis, logger), POLICY, logger);

    const inFlight = racing.resolve(issued.token);
    await hasRead;
    await service.revoke(issued.session.id);
    release();

    // The in-flight request is served: it read a live row before the revocation
    // committed, and no design can retract an answer already computed.
    expect((await inFlight).outcome).toBe('resolved');
    // What must not happen is that it left a live entry behind for the NEXT
    // request. This assertion first, because it is the user-visible property;
    // the key's contents below are the mechanism that produces it.
    expect(await service.resolve(issued.token)).toEqual({ outcome: 'revoked' });
    expect(await redis.get(sessionCacheKey(hashSecretToken(issued.token)))).toBe('revoked');
  });

  it('refuses a session revoked while its cache entry was warm and Redis was reachable', async () => {
    const issued = await service.issue({ userId: userB, status: 'ACTIVE' });
    await service.resolve(issued.token);

    await service.revoke(issued.session.id);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.session.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(await service.resolve(issued.token)).toEqual({ outcome: 'revoked' });
  });
});

describe('the two lifetimes, independently', () => {
  it('refuses a session past its ABSOLUTE clock while its idle clock is fresh', async () => {
    // The half a single `expiresAt` column silently stops enforcing if you renew
    // it on activity: the seven-day cap disappears and a session used daily
    // lives forever.
    const now = Date.now();
    const planted = await plant({
      absoluteExpiresAt: new Date(now - HOUR),
      idleExpiresAt: new Date(now + 12 * HOUR),
      lastSeenAt: new Date(now - 60_000),
    });

    expect(await service.resolve(planted.token)).toEqual({ outcome: 'expired' });
  });

  it('refuses a session past its IDLE clock while its absolute clock is fresh', async () => {
    // The other half, which disappears if you do not renew: there is no idle
    // timeout at all and an abandoned session on a shared machine stays usable
    // for seven days.
    const now = Date.now();
    const planted = await plant({
      absoluteExpiresAt: new Date(now + 6 * 24 * HOUR),
      idleExpiresAt: new Date(now - HOUR),
      lastSeenAt: new Date(now - 25 * HOUR),
    });

    expect(await service.resolve(planted.token)).toEqual({ outcome: 'expired' });
  });

  it('accepts a session fresh on both — the negative control', async () => {
    // Without this, a `resolve` that refused everything would pass both tests
    // above.
    const now = Date.now();
    const planted = await plant({
      absoluteExpiresAt: new Date(now + 6 * 24 * HOUR),
      idleExpiresAt: new Date(now + 12 * HOUR),
      lastSeenAt: new Date(now - 60_000),
    });

    expect((await service.resolve(planted.token)).outcome).toBe('resolved');
  });
});

describe('rolling renewal', () => {
  it('moves the idle clock once past the halfway mark', async () => {
    const now = Date.now();
    const planted = await plant({
      absoluteExpiresAt: new Date(now + 6 * 24 * HOUR),
      idleExpiresAt: new Date(now + 11 * HOUR),
      lastSeenAt: new Date(now - 13 * HOUR),
    });

    await service.resolve(planted.token);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: planted.id } });
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(now - HOUR);
    expect(row.idleExpiresAt.getTime()).toBeGreaterThan(now + 23 * HOUR);
  });

  it('leaves the row untouched before the halfway mark — a read is not a write', async () => {
    // The property the halfway rule exists for. If this failed, every
    // authenticated request would be an UPDATE, which is the cost ADR-0005
    // spends the Redis cache to avoid.
    const now = Date.now();
    const lastSeenAt = new Date(now - HOUR);
    const planted = await plant({
      absoluteExpiresAt: new Date(now + 6 * 24 * HOUR),
      idleExpiresAt: new Date(now + 23 * HOUR),
      lastSeenAt,
    });

    await service.resolve(planted.token);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: planted.id } });
    expect(row.lastSeenAt.toISOString()).toBe(lastSeenAt.toISOString());
  });

  it('never renews past the absolute clock', async () => {
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + 2 * HOUR);
    const planted = await plant({
      absoluteExpiresAt,
      idleExpiresAt: new Date(now + HOUR),
      lastSeenAt: new Date(now - 13 * HOUR),
    });

    await service.resolve(planted.token);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: planted.id } });
    expect(row.idleExpiresAt.toISOString()).toBe(absoluteExpiresAt.toISOString());
  });
});

describe('rotation', () => {
  it('kills the old credential and mints a new one — the session-fixation defence', async () => {
    // §3: rotated on every privilege change. An attacker who planted a session
    // value in the victim's browser must not be riding the same credential
    // after the victim's privilege changes.
    const issued = await service.issue({ userId: userA, status: 'ACTIVE' });
    await service.resolve(issued.token);

    const rotated = await service.rotate({ sessionId: issued.session.id });

    expect(rotated).not.toBeNull();
    expect(rotated?.token).not.toBe(issued.token);
    expect(await service.resolve(issued.token)).toEqual({ outcome: 'revoked' });
    expect((await service.resolve(rotated?.token ?? '')).outcome).toBe('resolved');

    const successor = await prisma.session.findUniqueOrThrow({
      where: { id: rotated?.session.id ?? '' },
    });
    expect(successor.rotatedFromId).toBe(issued.session.id);
  });

  it('leaves exactly one live successor when two rotations race — ten rounds', async () => {
    // CARRY-FORWARD RULING 31, DISCHARGED BY MEASUREMENT. Two live sessions
    // descending from one credential is a session-fixation defence that does
    // not defend: the attacker's rotation and the victim's rotation both
    // succeed and both hold a working token.
    //
    // Ten rounds rather than one, for the reason `token.service.integration
    // .spec.ts` gives: a race that resolves correctly by luck once is a green
    // test.
    const liveSuccessors: number[] = [];

    for (let round = 0; round < 10; round += 1) {
      const issued = await service.issue({ userId: userA, status: 'ACTIVE' });
      const results = await Promise.all([
        service.rotate({ sessionId: issued.session.id }),
        service.rotate({ sessionId: issued.session.id }),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      liveSuccessors.push(
        await prisma.session.count({
          where: { rotatedFromId: issued.session.id, revokedAt: null },
        }),
      );
    }

    expect(liveSuccessors).toEqual(Array.from({ length: 10 }, () => 1));
  });

  it('rotates two different sessions concurrently — the gate is per row, not global', async () => {
    // The negative control. A rotation serialised process-wide would also make
    // the ten rounds above green, and would be a throughput disaster wearing a
    // passing spec.
    const first = await service.issue({ userId: userA, status: 'ACTIVE' });
    const second = await service.issue({ userId: userB, status: 'ACTIVE' });

    const results = await Promise.all([
      service.rotate({ sessionId: first.session.id }),
      service.rotate({ sessionId: second.session.id }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(2);
  });
});

describe('bulk revocation', () => {
  it('revokes every other session of a user and keeps the one excepted', async () => {
    // §2: a password change revokes all other sessions. The user changing their
    // own password keeps the session they are sitting in.
    // `userC` exists for this test alone: the assertion counts every live
    // session the user has, and a user shared with the tests above would make
    // the number depend on the order they ran in.
    const keep = await service.issue({ userId: userC, status: 'ACTIVE' });
    const others = [
      await service.issue({ userId: userC, status: 'ACTIVE' }),
      await service.issue({ userId: userC, status: 'ACTIVE' }),
    ];
    for (const session of [keep, ...others]) await service.resolve(session.token);

    const revoked = await service.revokeAllForUser(userC, { exceptSessionId: keep.session.id });

    expect(revoked).toBe(2);
    // Immediately, not eventually — every one of these was warm in Redis a
    // moment ago.
    for (const session of others) {
      expect(await service.resolve(session.token)).toEqual({ outcome: 'revoked' });
    }
    expect((await service.resolve(keep.token)).outcome).toBe('resolved');
  });

  it('revokes only the sessions acting in the named organisation', async () => {
    // `permissions.md` invariant 5. A consultant removed from one organisation
    // stays signed in to the others.
    const inA = await plant({
      userId: userA,
      activeOrganizationId: orgA,
      absoluteExpiresAt: new Date(Date.now() + 6 * 24 * HOUR),
      idleExpiresAt: new Date(Date.now() + 12 * HOUR),
    });
    const inB = await plant({
      userId: userA,
      activeOrganizationId: orgB,
      absoluteExpiresAt: new Date(Date.now() + 6 * 24 * HOUR),
      idleExpiresAt: new Date(Date.now() + 12 * HOUR),
    });
    await service.resolve(inA.token);
    await service.resolve(inB.token);

    await service.revokeAllForUserInOrganization(userA, orgA);

    expect(await service.resolve(inA.token)).toEqual({ outcome: 'revoked' });
    expect((await service.resolve(inB.token)).outcome).toBe('resolved');
  });
});

describe('when Redis is unavailable', () => {
  it('resolves from Postgres instead of failing — ADR-0005 promises this', async () => {
    const issued = await offline.issue({ userId: userA, status: 'ACTIVE' });
    const resolution: SessionResolution = await offline.resolve(issued.token);

    expect(resolution.outcome).toBe('resolved');
  });

  it('still refuses a revoked session, because Postgres is the authority', async () => {
    const issued = await offline.issue({ userId: userA, status: 'ACTIVE' });
    expect(await offline.revoke(issued.session.id)).toBe(true);

    expect(await offline.resolve(issued.token)).toEqual({ outcome: 'revoked' });
  });

  it('revokes the row even though it cannot poison a cache entry', async () => {
    // The one residual the tombstone design cannot close, asserted rather than
    // assumed: revocation must not fail because the cache is down, or an
    // operator containing an incident cannot revoke during the outage that
    // tends to accompany one. The row is what makes every cold instance refuse.
    const issued = await offline.issue({ userId: userA, status: 'ACTIVE' });
    await offline.revoke(issued.session.id);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.session.id } });
    expect(row.revokedAt).not.toBeNull();
  });

  it('still enforces both clocks with no cache at all', async () => {
    const now = Date.now();
    const planted = await plant({
      absoluteExpiresAt: new Date(now - HOUR),
      idleExpiresAt: new Date(now + 12 * HOUR),
    });

    expect(await offline.resolve(planted.token)).toEqual({ outcome: 'expired' });
  });
});

describe('the stored row', () => {
  it('holds only a hash — the database cannot mint a session', async () => {
    // Critical security rule 5, and `schema.prisma`'s own comment on the model.
    const issued = await service.issue({
      userId: userA,
      status: 'ACTIVE',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (probe)',
    });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.session.id } });

    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.tokenHash).toBe(hashSecretToken(issued.token));
    expect(row.ip).toBe('203.0.113.7');
    expect(row.userAgent).toBe('Mozilla/5.0 (probe)');
  });

  it('never stores the raw token in Redis either', async () => {
    const issued = await service.issue({ userId: userA, status: 'ACTIVE' });
    await service.resolve(issued.token);

    const cached = await redis.get(sessionCacheKey(hashSecretToken(issued.token)));
    expect(cached).not.toBeNull();
    expect(cached).not.toContain(issued.token);
  });
});
