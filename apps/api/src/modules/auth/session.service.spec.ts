import { describe, expect, it } from 'vitest';
import { datamodelEnums, newId } from '@sentinel/db';
import { createLogger } from '@sentinel/observability';
import { hashSecretToken } from './secret-token.js';
import { SESSION_TOMBSTONE, type SessionCache } from './session.cache.js';
import {
  SESSION_STATUSES,
  type SessionCreateData,
  SessionRepository,
  type SessionRow,
  type SessionStore,
  type SessionTransaction,
} from './session.repository.js';
import {
  IP_MAX_LENGTH,
  SESSION_CACHE_KEY_PREFIX,
  type SessionPolicy,
  SessionService,
  USER_AGENT_MAX_LENGTH,
  absoluteLifetimeSeconds,
  isRenewalDue,
  sessionCacheKey,
} from './session.service.js';

/**
 * WHAT A FAKE CAN HONESTLY PROVE ABOUT A SESSION, AND WHAT IT CANNOT.
 *
 * Everything here is arithmetic, input handling, or the order in which two
 * components are asked to do something. None of it is a claim about
 * concurrency, and none of it is a claim that revocation is immediate — a fake
 * makes both true by construction, which is why they live in
 * `session.service.integration.spec.ts` against a real Postgres and the real
 * compose Redis. The same split `token.service.spec.ts` and its integration
 * sibling record.
 */
const POLICY: SessionPolicy = {
  absoluteLifetimeSeconds: 604_800,
  rememberMeLifetimeSeconds: 2_592_000,
  idleTimeoutSeconds: 86_400,
  pendingMfaLifetimeSeconds: 600,
  cacheTtlSeconds: 60,
};

/** One thing the service asked one of its two collaborators to do. */
interface Call {
  readonly target: 'db' | 'cache';
  readonly method: string;
  readonly args?: unknown;
}

interface Harness {
  readonly service: SessionService;
  readonly calls: Call[];
  readonly created: SessionCreateData[];
  readonly store: Map<string, string>;
}

/**
 * A recording double for the narrow Prisma port and a real in-memory cache.
 *
 * The database side records rather than stores, for the reason
 * `token.service.spec.ts` gives: what this file can honestly assert is which
 * statements are issued and in what order. The cache side *does* store, because
 * the tombstone rule is a property of the values and is cheap to model
 * faithfully — and modelling it here is what lets the ordering assertions below
 * (poison before write) mean something.
 */
function harness(rows: readonly SessionRow[] = []): Harness {
  const calls: Call[] = [];
  const created: SessionCreateData[] = [];
  const store = new Map<string, string>();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byHash = new Map(rows.map((row) => [row.tokenHash, row]));

  const session = {
    create: (args: { data: SessionCreateData }) => {
      calls.push({ target: 'db', method: 'create', args: args.data });
      created.push(args.data);
      return Promise.resolve({});
    },
    findUnique: (args: { where: { tokenHash: string } | { id: string } }) => {
      calls.push({ target: 'db', method: 'findUnique', args: args.where });
      const where = args.where;
      const found =
        'id' in where ? (byId.get(where.id) ?? null) : (byHash.get(where.tokenHash) ?? null);
      return Promise.resolve(found);
    },
    findMany: (args: unknown) => {
      calls.push({ target: 'db', method: 'findMany', args });
      return Promise.resolve(rows);
    },
    updateMany: (args: unknown) => {
      calls.push({ target: 'db', method: 'updateMany', args });
      return Promise.resolve({ count: 1 });
    },
  };

  const store_: SessionStore = {
    session,
    $transaction: <T>(run: (tx: SessionTransaction) => Promise<T>) => {
      calls.push({ target: 'db', method: 'transaction' });
      return run({ session });
    },
  };

  const cache: SessionCache = {
    read: (key) => {
      calls.push({ target: 'cache', method: 'read', args: key });
      return Promise.resolve(store.get(key) ?? null);
    },
    writeLive: (key, value, ttl) => {
      calls.push({ target: 'cache', method: 'writeLive', args: { key, ttl } });
      if (store.get(key) === SESSION_TOMBSTONE) return Promise.resolve(false);
      store.set(key, value);
      return Promise.resolve(true);
    },
    writeTombstone: (key, ttl) => {
      calls.push({ target: 'cache', method: 'writeTombstone', args: { key, ttl } });
      store.set(key, SESSION_TOMBSTONE);
      return Promise.resolve(true);
    },
  };

  const service = new SessionService(
    new SessionRepository(store_),
    cache,
    POLICY,
    createLogger({ service: 'test', level: 'warn', pretty: false, silent: true }),
  );

  return { service, calls, created, store };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date();
  return {
    id: newId('ses'),
    userId: newId('usr'),
    tokenHash: hashSecretToken('a-token-nobody-issued'),
    activeOrganizationId: null,
    ip: null,
    userAgent: null,
    idleExpiresAt: new Date(now.getTime() + 86_400_000),
    absoluteExpiresAt: new Date(now.getTime() + 604_800_000),
    status: 'ACTIVE',
    lastSeenAt: now,
    mfaCompletedAt: null,
    rememberMe: false,
    rotatedFromId: null,
    revokedAt: null,
    createdAt: now,
    ...overrides,
  };
}

describe('SESSION_STATUSES', () => {
  it('matches every value of the Prisma SessionStatus enum', () => {
    // Carry-forward ruling 13: a restatement needs something that reads the
    // schema. Adding a third value to `enum SessionStatus` without adding it
    // here turns this red, rather than leaving a status the service silently
    // cannot express.
    const declared = datamodelEnums().find((entry) => entry.name === 'SessionStatus');
    expect(declared).toBeDefined();
    expect([...(declared?.values ?? [])].sort()).toEqual([...SESSION_STATUSES].sort());
  });
});

describe('sessionCacheKey', () => {
  it('namespaces under a prefix nothing else in the suite uses', () => {
    // Carry-forward ruling 33. The integration suite shares one compose Redis
    // with the rate-limit specs, whose keys start `ratelimit:`.
    expect(SESSION_CACHE_KEY_PREFIX).toBe('session:v1:');
    expect(sessionCacheKey('abc')).toBe('session:v1:abc');
  });

  it('is a pure function of the hash, so two callers derive the same key', () => {
    expect(sessionCacheKey('abc')).toBe(sessionCacheKey('abc'));
    expect(sessionCacheKey('abc')).not.toBe(sessionCacheKey('abd'));
  });
});

describe('absoluteLifetimeSeconds', () => {
  it('is 7 days, and 30 with remember-me — §3', () => {
    expect(absoluteLifetimeSeconds(POLICY, { status: 'ACTIVE', rememberMe: false })).toBe(604_800);
    expect(absoluteLifetimeSeconds(POLICY, { status: 'ACTIVE', rememberMe: true })).toBe(2_592_000);
  });

  it('gives a pending-MFA session §5 minutes, remember-me or not', () => {
    // "Remember me" ticked on the login form must not turn the credential that
    // has proved only a password into a thirty-day one.
    expect(absoluteLifetimeSeconds(POLICY, { status: 'PENDING_MFA', rememberMe: false })).toBe(600);
    expect(absoluteLifetimeSeconds(POLICY, { status: 'PENDING_MFA', rememberMe: true })).toBe(600);
  });
});

describe('isRenewalDue', () => {
  const idleTimeoutSeconds = 86_400;
  const now = new Date('2026-08-26T12:00:00.000Z');

  it('is false before the halfway mark', () => {
    const lastSeenAt = new Date(now.getTime() - 11 * 60 * 60 * 1_000);
    expect(isRenewalDue({ lastSeenAt, now, idleTimeoutSeconds })).toBe(false);
  });

  it('is true exactly at the halfway mark', () => {
    // The boundary is inclusive. Off by one in the other direction would mean a
    // session used at exactly twelve-hour intervals never renews and expires.
    const lastSeenAt = new Date(now.getTime() - 12 * 60 * 60 * 1_000);
    expect(isRenewalDue({ lastSeenAt, now, idleTimeoutSeconds })).toBe(true);
  });

  it('is true past it', () => {
    const lastSeenAt = new Date(now.getTime() - 13 * 60 * 60 * 1_000);
    expect(isRenewalDue({ lastSeenAt, now, idleTimeoutSeconds })).toBe(true);
  });

  it('is false for a session used a moment ago — the whole point of the rule', () => {
    // If this were true, every authenticated read would be a database write,
    // which is the cost ADR-0005 spends the cache to avoid.
    expect(isRenewalDue({ lastSeenAt: now, now, idleTimeoutSeconds })).toBe(false);
  });
});

describe('issue', () => {
  it('stores only the hash and returns the raw token once', async () => {
    const { service, created } = harness();
    const issued = await service.issue({ userId: newId('usr'), status: 'ACTIVE' });

    expect(created[0]?.tokenHash).toBe(hashSecretToken(issued.token));
    expect(JSON.stringify(created[0])).not.toContain(issued.token);
  });

  it('states the status on every insert — ruling 6', async () => {
    // `Session.status` has no `@default`. The insert must carry it, and this is
    // the assertion that notices if a later refactor drops it into a spread.
    const { service, created } = harness();
    await service.issue({ userId: newId('usr'), status: 'PENDING_MFA' });
    expect(created[0]?.status).toBe('PENDING_MFA');
  });

  it('sets both clocks, independently', async () => {
    const { service, created } = harness();
    await service.issue({ userId: newId('usr'), status: 'ACTIVE' });

    const data = created[0];
    const span = (a?: Date, b?: Date): number => (a?.getTime() ?? 0) - (b?.getTime() ?? 0);
    expect(span(data?.absoluteExpiresAt, data?.lastSeenAt)).toBeGreaterThan(604_000_000);
    expect(span(data?.idleExpiresAt, data?.lastSeenAt)).toBeLessThan(86_401_000);
  });

  it('clamps the idle clock to the absolute one', async () => {
    // A pending-MFA session lives ten minutes and the idle window is 24h, so
    // the unclamped idle expiry would sit a day past the absolute one. Nothing
    // depends on the clamp — both clocks are checked — but the row would state
    // something untrue, and this table is read during incidents.
    const { service, created } = harness();
    await service.issue({ userId: newId('usr'), status: 'PENDING_MFA' });

    expect(created[0]?.idleExpiresAt.toISOString()).toBe(
      created[0]?.absoluteExpiresAt.toISOString(),
    );
  });

  it('gives a remember-me session a cookie Max-Age and an ordinary one none', async () => {
    const { service } = harness();
    const remembered = await service.issue({
      userId: newId('usr'),
      status: 'ACTIVE',
      rememberMe: true,
    });
    const ordinary = await service.issue({ userId: newId('usr'), status: 'ACTIVE' });

    expect(remembered.cookieMaxAgeSeconds).toBeGreaterThan(2_591_000);
    expect(ordinary.cookieMaxAgeSeconds).toBeNull();
  });

  it('caps a user-controlled User-Agent at the boundary where it is written', async () => {
    const { service, created } = harness();
    await service.issue({
      userId: newId('usr'),
      status: 'ACTIVE',
      userAgent: 'x'.repeat(5_000),
    });

    expect(created[0]?.userAgent?.length).toBe(USER_AGENT_MAX_LENGTH);
  });

  it('records a null IP rather than a truncated one', async () => {
    // A truncated address is a different address, and this column is read
    // during an incident. Null says "not recorded"; a prefix says something
    // false.
    const { service, created } = harness();
    await service.issue({
      userId: newId('usr'),
      status: 'ACTIVE',
      ip: '9'.repeat(IP_MAX_LENGTH + 1),
    });

    expect(created[0]?.ip).toBeNull();
  });

  it('keeps an ordinary address', async () => {
    const { service, created } = harness();
    await service.issue({ userId: newId('usr'), status: 'ACTIVE', ip: '203.0.113.7' });
    expect(created[0]?.ip).toBe('203.0.113.7');
  });

  it('refuses a userId that is not one', async () => {
    // Zod at the boundary, on a call that never crosses the network. Types are
    // not validation, and this is the field a later caller will take from
    // somewhere it should not have.
    const { service } = harness();
    await expect(service.issue({ userId: 'not-an-id', status: 'ACTIVE' })).rejects.toThrow();
  });

  it('does not warm the cache', async () => {
    // The credential has not been presented yet. A write here costs a Redis
    // round trip on the login path and saves at most one Postgres read.
    const { service, calls } = harness();
    await service.issue({ userId: newId('usr'), status: 'ACTIVE' });
    expect(calls.filter((call) => call.target === 'cache')).toEqual([]);
  });
});

describe('resolve', () => {
  it('refuses from a tombstone without asking Postgres at all', async () => {
    // The immediacy property's cheap half: once a key is poisoned, no read of
    // the database can turn that answer back into a session.
    const live = row({ tokenHash: hashSecretToken('poisoned') });
    const { service, calls, store } = harness([live]);
    store.set(sessionCacheKey(live.tokenHash), SESSION_TOMBSTONE);

    expect(await service.resolve('poisoned')).toEqual({ outcome: 'revoked' });
    expect(calls.filter((call) => call.target === 'db')).toEqual([]);
  });

  it('falls through to Postgres when the cached payload does not parse', async () => {
    // Redis content is external input. A value that fails the schema is treated
    // as a miss, never as an error and never as a session.
    const live = row({ tokenHash: hashSecretToken('present') });
    const { service, calls, store } = harness([live]);
    store.set(sessionCacheKey(live.tokenHash), '{"v":1,"id":"nonsense"}');

    const resolution = await service.resolve('present');
    expect(resolution.outcome).toBe('resolved');
    expect(calls.some((call) => call.method === 'findUnique')).toBe(true);
  });

  it('reports an unknown token as unknown, not as expired', async () => {
    // `api/authentication.md` §6 keeps UNAUTHENTICATED and SESSION_EXPIRED
    // distinct, and Task 7 cannot make that distinction if this returns null.
    const { service } = harness();
    expect(await service.resolve('never-issued')).toEqual({ outcome: 'unknown' });
  });

  it('reports a revoked row as revoked even with an empty cache', async () => {
    const revoked = row({ tokenHash: hashSecretToken('revoked'), revokedAt: new Date() });
    const { service } = harness([revoked]);
    expect(await service.resolve('revoked')).toEqual({ outcome: 'revoked' });
  });

  it('caches what it resolved, so the next call needs no database read', async () => {
    const live = row({ tokenHash: hashSecretToken('warm') });
    const { service, calls } = harness([live]);

    await service.resolve('warm');
    const afterFirst = calls.filter((call) => call.target === 'db').length;
    await service.resolve('warm');

    expect(calls.filter((call) => call.target === 'db').length).toBe(afterFirst);
  });
});

describe('revoke', () => {
  it('poisons the cache before it writes the row', async () => {
    // The order is the control. Writing the row first leaves a window in which
    // a resolve that already read the live row can still populate the cache;
    // the tombstone is what makes that populate fail. See `session.cache.ts`.
    const live = row();
    const { service, calls } = harness([live]);

    await service.revoke(live.id);

    const poison = calls.findIndex((call) => call.method === 'writeTombstone');
    const update = calls.findIndex((call) => call.method === 'updateMany');
    expect(poison).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(poison);
  });

  it('reports false for a session that does not exist', async () => {
    const { service } = harness();
    expect(await service.revoke(newId('ses'))).toBe(false);
  });
});

describe('rotate', () => {
  it('inherits the absolute clock rather than restarting it', async () => {
    // §3: the absolute lifetime never moves. A rotation that reset it would let
    // a user hold a session indefinitely by changing their password weekly.
    const predecessor = row();
    const { service, created } = harness([predecessor]);

    await service.rotate({ sessionId: predecessor.id });

    expect(created[0]?.absoluteExpiresAt.toISOString()).toBe(
      predecessor.absoluteExpiresAt.toISOString(),
    );
    expect(created[0]?.rotatedFromId).toBe(predecessor.id);
  });

  it('starts a fresh absolute clock when MFA completes', async () => {
    // The pending session's clock is §5's few minutes to type a code. Inheriting
    // it would expire the real session moments after MFA succeeded.
    const now = Date.now();
    const pending = row({
      status: 'PENDING_MFA',
      absoluteExpiresAt: new Date(now + 600_000),
      idleExpiresAt: new Date(now + 600_000),
    });
    const { service, created } = harness([pending]);

    await service.rotate({ sessionId: pending.id, status: 'ACTIVE' });

    expect(created[0]?.absoluteExpiresAt.getTime()).toBeGreaterThan(now + 600_000_000);
    expect(created[0]?.status).toBe('ACTIVE');
  });

  it('refuses to rotate a session that is already past its absolute clock', async () => {
    // Rotation must not be a way to extend a dead session.
    const stale = row({ absoluteExpiresAt: new Date(Date.now() - 1_000) });
    const { service } = harness([stale]);
    expect(await service.rotate({ sessionId: stale.id })).toBeNull();
  });

  it('refuses to rotate an already-revoked session', async () => {
    const revoked = row({ revokedAt: new Date() });
    const { service } = harness([revoked]);
    expect(await service.rotate({ sessionId: revoked.id })).toBeNull();
  });

  it('poisons the predecessor before opening the transaction', async () => {
    const predecessor = row();
    const { service, calls } = harness([predecessor]);

    await service.rotate({ sessionId: predecessor.id });

    const poison = calls.findIndex((call) => call.method === 'writeTombstone');
    const transaction = calls.findIndex((call) => call.method === 'transaction');
    expect(poison).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThan(poison);
  });

  it('carries the predecessor forward and lets the caller override', async () => {
    const organizationId = newId('org');
    const predecessor = row({ rememberMe: true, ip: '203.0.113.7', userAgent: 'curl/8' });
    const { service, created } = harness([predecessor]);

    await service.rotate({ sessionId: predecessor.id, activeOrganizationId: organizationId });

    expect(created[0]?.rememberMe).toBe(true);
    expect(created[0]?.ip).toBe('203.0.113.7');
    expect(created[0]?.userAgent).toBe('curl/8');
    expect(created[0]?.activeOrganizationId).toBe(organizationId);
    expect(created[0]?.userId).toBe(predecessor.userId);
  });
});

describe('bulk revocation', () => {
  it('poisons every affected session before revoking any row', async () => {
    const userId = newId('usr');
    const rows = [
      row({ userId, tokenHash: hashSecretToken('one') }),
      row({ userId, tokenHash: hashSecretToken('two') }),
    ];
    const { service, calls } = harness(rows);

    await service.revokeAllForUser(userId);

    const poisons = calls.filter((call) => call.method === 'writeTombstone');
    expect(poisons).toHaveLength(2);
    const lastPoison = calls.lastIndexOf(poisons[1] as Call);
    expect(calls.findIndex((call) => call.method === 'updateMany')).toBeGreaterThan(lastPoison);
  });

  it('scopes the organisation variant to activeOrganizationId', async () => {
    // `permissions.md` invariant 5: a consultant removed from one organisation
    // stays signed in to the others, which is why userId alone is not the
    // filter.
    const userId = newId('usr');
    const organizationId = newId('org');
    const { service, calls } = harness([row({ userId, activeOrganizationId: organizationId })]);

    await service.revokeAllForUserInOrganization(userId, organizationId);

    const listed = calls.find((call) => call.method === 'findMany')?.args;
    expect(JSON.stringify(listed)).toContain(organizationId);
  });

  it('refuses an organisation id that is not one', async () => {
    const { service } = harness();
    await expect(
      service.revokeAllForUserInOrganization(newId('usr'), 'not-an-org'),
    ).rejects.toThrow();
  });
});
