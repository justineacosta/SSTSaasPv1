import type { Server } from 'node:http';
import { newId, seedReferenceData } from '@sentinel/db';
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRateLimits, startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { deriveCsrfToken } from '../auth/csrf-token.js';
import { mintSecretToken } from '../auth/secret-token.js';

/**
 * INVARIANT 1 — "AN ORGANISATION ALWAYS HAS AT LEAST ONE `OWNER`" — AND THE
 * RACE THAT MAKES A COUNT-THEN-WRITE VERSION OF IT WORTHLESS.
 *
 * `product/permissions.md` invariant 1 and the Phase 2 plan's Task 14: "Test
 * the race too — two concurrent demotions of the two remaining owners must not
 * both succeed. That needs a transaction with the right isolation or a
 * constraint, not two independent reads."
 *
 * # Why a row lock and not the alternatives
 *
 * - **A CHECK constraint cannot express it.** "At least one row matching X
 *   exists" is not a row-level predicate; Postgres has no declarative form for
 *   it.
 * - **A trigger alone does not close the race.** Two concurrent transactions
 *   each demote a different one of the two remaining owners. Each trigger
 *   counts under its own snapshot, each sees two owners, both commit, and the
 *   organisation has none. The snapshot is the problem, not the check — which
 *   is exactly what the first test below measures.
 * - **`SERIALIZABLE` would work and is rejected.** It detects the anomaly and
 *   aborts one transaction with `40001`, which then needs a retry loop; an
 *   unhandled `40001` surfaces as a 500 on a routine role change. The lock
 *   serialises the same window with no retry and no new failure mode.
 *
 * # THE FIRST TEST IS THE ONE THAT MAKES THE OTHERS MEAN ANYTHING
 *
 * D2: "If you cannot make the unlocked version fail, you have not tested the
 * race." So this file does not only assert that the shipped endpoint refuses.
 * It runs the **unlocked** algorithm — count, then write, on two real
 * connections with a real interleaving — and asserts it leaves the organisation
 * with **zero owners**. Then it runs the same interleaving **with** the lock and
 * asserts the second transaction sees the first one's write. A test that only
 * exercised the endpoint would pass just as happily over a service that counted
 * twice and hoped.
 */

let harness: AuthHarness;
let owner: PrismaClient;
let server: Server;
/** Two more `sentinel_app` connections, so a transaction can actually block. */
let alice: PrismaClient;
let bob: PrismaClient;

beforeAll(async () => {
  harness = await startAuthHarness({ connectAs: 'app' });
  owner = harness.prisma;
  server = harness.server;
  alice = createUnscopedPrismaClient(harness.postgres.appUrl);
  bob = createUnscopedPrismaClient(harness.postgres.appUrl);
  await seedReferenceData(owner);
}, 240_000);

afterAll(async () => {
  await alice?.$disconnect();
  await bob?.$disconnect();
  await harness?.stop();
});

let counter = 0;
const unique = (): string => {
  counter += 1;
  return `${String(counter)}-${String(Date.now())}`;
};

interface TwoOwners {
  readonly organizationId: string;
  readonly first: { userId: string; membershipId: string };
  readonly second: { userId: string; membershipId: string };
}

/** An organisation with exactly two live `ACTIVE` `OWNER` memberships. */
async function organizationWithTwoOwners(): Promise<TwoOwners> {
  const suffix = unique();
  const organization = await owner.organization.create({
    data: { id: newId('org'), slug: `lastowner-${suffix}`, name: `Last owner ${suffix}` },
    select: { id: true },
  });
  const ownerRole = await owner.role.findUniqueOrThrow({
    where: { key: 'OWNER' },
    select: { id: true },
  });

  const make = async (): Promise<{ userId: string; membershipId: string }> => {
    const account = await owner.user.create({
      data: {
        id: newId('usr'),
        email: `lastowner-${unique()}@example.test`,
        emailVerifiedAt: new Date(),
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const created = await owner.membership.create({
      data: {
        id: newId('mbr'),
        organizationId: organization.id,
        userId: account.id,
        roleId: ownerRole.id,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    return { userId: account.id, membershipId: created.id };
  };

  return { organizationId: organization.id, first: await make(), second: await make() };
}

async function liveOwnerCount(organizationId: string): Promise<number> {
  return owner.membership.count({
    where: { organizationId, status: 'ACTIVE', deletedAt: null, role: { key: 'OWNER' } },
  });
}

/**
 * The count the service takes inside its lock, issued here as raw SQL so the
 * two arms below differ in **one statement** — the `FOR UPDATE` — and in
 * nothing else.
 */
const COUNT_OWNERS = `
  SELECT count(*)::int AS owners
  FROM "Membership" m
  JOIN "Role" r ON r.id = m."roleId"
  WHERE m."organizationId" = $1
    AND m.status = 'ACTIVE'
    AND m."deletedAt" IS NULL
    AND r.key = 'OWNER'
`;

/** A deferred promise, so a test can hold a transaction open across an await. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = (): void => {
      resolve();
    };
  });
  return { wait, open };
}

/**
 * A COUNTING BARRIER, BECAUSE A ONE-SIDED GATE IS NOT ONE.
 *
 * The first version of the unlocked race test below used a `gate()` opened by
 * Alice: she opened it and immediately fell through her own `await`, so nothing
 * made her wait for Bob. `bothCounted` guaranteed "Alice has counted", never
 * "both have counted". When Bob was slow to acquire a connection or start a
 * transaction — which is what a loaded lane does — Alice's `UPDATE` landed
 * first, Bob's snapshot was taken after her commit, and he counted **one**
 * owner and returned without writing. `expect(seenByBob).toBe(2)` then failed,
 * intermittently, on the file's own headline evidence. The adversarial review
 * measured it: one full-lane run red at `:211`, the next green, and red
 * deterministically with a 500 ms delay inserted before Bob's count.
 *
 * `arrive()` resolves for **every** participant only once `parties` of them
 * have called it, so neither transaction can leave the barrier until both have
 * taken their snapshot and counted. The interleaving is then arranged, which is
 * what the paragraph beside it claimed and did not deliver.
 */
function barrier(parties: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    release = (): void => {
      resolve();
    };
  });
  return {
    arrive: async (): Promise<void> => {
      arrived += 1;
      if (arrived >= parties) release();
      await opened;
    },
  };
}

const MEMBER_ROLE_ID = async (): Promise<string> =>
  (await owner.role.findUniqueOrThrow({ where: { key: 'MEMBER' }, select: { id: true } })).id;

describe('the race, measured directly against Postgres', () => {
  it('WITHOUT the row lock, two concurrent demotions both commit and the organisation is left with ZERO owners', async () => {
    const org = await organizationWithTwoOwners();
    const memberRoleId = await MEMBER_ROLE_ID();
    expect(await liveOwnerCount(org.organizationId)).toBe(2);

    // TWO parties, not a gate one of them opens for itself. See `barrier`.
    const bothCounted = barrier(2);
    const aliceWrote = gate();

    const demote = async (
      client: PrismaClient,
      membershipId: string,
      after: 'first' | 'second',
    ): Promise<number> =>
      client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.organization_id', ${org.organizationId}, true)`;

          // NO `SELECT ... FOR UPDATE`. This is the naive shape D1 rejects:
          // count under this transaction's own snapshot, then write.
          const counted = await tx.$queryRawUnsafe<{ owners: number }[]>(
            COUNT_OWNERS,
            org.organizationId,
          );
          const owners = counted[0]?.owners ?? 0;

          // Both transactions must have counted before either writes, which is
          // the interleaving that produces the anomaly. **Arranged, and this is
          // the statement that arranges it**: `arrive()` releases nobody until
          // both participants have reached it, so neither snapshot can be taken
          // after the other transaction's write. The earlier one-sided version
          // of this gate let Alice through on her own and reported green only on
          // a machine fast enough to start Bob before she committed.
          await bothCounted.arrive();
          if (after === 'second') await aliceWrote.wait;

          if (owners <= 1) return owners;
          await tx.$executeRaw`
            UPDATE "Membership" SET "roleId" = ${memberRoleId}, "updatedAt" = now()
            WHERE id = ${membershipId}
          `;
          if (after === 'first') aliceWrote.open();
          return owners;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );

    const [seenByAlice, seenByBob] = await Promise.all([
      demote(alice, org.first.membershipId, 'first'),
      demote(bob, org.second.membershipId, 'second'),
    ]);

    // Both read two owners under their own snapshots — the snapshot is the
    // problem, and this is it in one assertion.
    expect(seenByAlice).toBe(2);
    expect(seenByBob).toBe(2);
    expect(await liveOwnerCount(org.organizationId)).toBe(0);
  });

  it('WITH the row lock, the second transaction waits and then sees ONE owner, so it refuses', async () => {
    const org = await organizationWithTwoOwners();
    const memberRoleId = await MEMBER_ROLE_ID();
    expect(await liveOwnerCount(org.organizationId)).toBe(2);

    const aliceHasLock = gate();

    const demote = async (
      client: PrismaClient,
      membershipId: string,
      after: 'first' | 'second',
    ): Promise<number> =>
      client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.organization_id', ${org.organizationId}, true)`;

          // THE ONE STATEMENT THAT DIFFERS FROM THE TEST ABOVE.
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.organizationId} FOR UPDATE`;

          if (after === 'first') aliceHasLock.open();

          const counted = await tx.$queryRawUnsafe<{ owners: number }[]>(
            COUNT_OWNERS,
            org.organizationId,
          );
          const owners = counted[0]?.owners ?? 0;
          if (owners <= 1) return owners;
          await tx.$executeRaw`
            UPDATE "Membership" SET "roleId" = ${memberRoleId}, "updatedAt" = now()
            WHERE id = ${membershipId}
          `;
          return owners;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );

    const first = demote(alice, org.first.membershipId, 'first');
    // Bob only starts once Alice holds the lock, so his `FOR UPDATE` blocks on
    // hers rather than winning a coin toss.
    await aliceHasLock.wait;
    const second = demote(bob, org.second.membershipId, 'second');

    const [seenByAlice, seenByBob] = await Promise.all([first, second]);

    expect(seenByAlice).toBe(2);
    // The whole point: Bob's count runs after Alice's commit, so it is 1 and
    // his write never happens.
    expect(seenByBob).toBe(1);
    expect(await liveOwnerCount(org.organizationId)).toBe(1);
  });
});

describe('the shipped endpoints hold the invariant under contention', () => {
  interface Actor {
    readonly cookie: string;
    readonly token: string;
  }

  async function sessionFor(userId: string, organizationId: string): Promise<Actor> {
    const minted = mintSecretToken();
    const now = Date.now();
    await owner.session.create({
      data: {
        id: newId('ses'),
        userId,
        tokenHash: minted.tokenHash,
        activeOrganizationId: organizationId,
        status: 'ACTIVE',
        idleExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
        absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    return { cookie: `${SESSION_COOKIE_NAME}=${minted.token}`, token: minted.token };
  }

  const headers = (actor: Actor): Record<string, string> => ({
    Cookie: actor.cookie,
    [CSRF_HEADER]: deriveCsrfToken(actor.token),
  });

  /**
   * THE DETERMINISTIC DETECTOR FOR THE LOCK ITSELF.
   *
   * A `Promise.all` of two demotions proves the outcome is right but not that
   * the lock is what made it right: the two requests may simply not have
   * overlapped. This does. The test takes a conflicting row lock on the
   * organisation on its own connection and holds it; a handler that takes
   * `FOR UPDATE` cannot get past its first statement until the test lets go,
   * and one that does not takes no notice. The assertion is a *timing* one in
   * the only direction that is safe to assert: a request blocked on a lock has
   * **not** answered while the lock is held.
   *
   * # `FOR NO KEY UPDATE`, and the first version of this test was wrong
   *
   * The blocker originally took `FOR UPDATE`, and **the mutation survived it**:
   * with `FOR UPDATE` deleted from `membership.service.ts` this test still
   * passed, taking 1325ms to do so. It was measuring something real and not the
   * thing it is named after.
   *
   * What it was measuring is the foreign key. The tenant-scoping client
   * extension forces the scope column into the payload of every `updateMany`
   * (`withScopedData` in `packages/db/src/tenant-scope.ts`), so the removal's
   * `UPDATE "Membership"` writes `organizationId` explicitly even though the
   * value is unchanged — which makes Postgres re-check
   * `Membership_organizationId_fkey` and take `FOR KEY SHARE` on the parent
   * `Organization` row. `FOR KEY SHARE` conflicts with `FOR UPDATE`, so a
   * blocker holding `FOR UPDATE` stalls the handler whether or not the handler
   * asked for a lock of its own.
   *
   * `FOR NO KEY UPDATE` is the discriminator, from Postgres's row-lock conflict
   * table: it conflicts with `FOR UPDATE` (so the handler's lock still waits)
   * and **not** with `FOR KEY SHARE` (so the foreign-key re-check does not).
   * With this lock the mutation goes red, which is what the test claims to be
   * able to do.
   */
  it('a membership write waits for a lock held on the organisation row', async () => {
    await clearRateLimits(harness.redis);
    const org = await organizationWithTwoOwners();
    const actor = await sessionFor(org.first.userId, org.organizationId);

    const released = gate();
    let requestSettled = false;

    const blocker = alice.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${org.organizationId}, true)`;
        // NOT `FOR UPDATE` — see the docblock. `FOR NO KEY UPDATE` blocks the
        // handler's own `FOR UPDATE` and lets the foreign-key re-check's
        // `FOR KEY SHARE` through, which is the only lock mode that tells the
        // two apart.
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.organizationId} FOR NO KEY UPDATE`;
        await released.wait;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    // Give the blocker a moment to actually acquire the lock before the request
    // starts, so "did not answer" cannot mean "started before the lock existed".
    await new Promise((resolve) => setTimeout(resolve, 250));

    const pending = request(server)
      .delete(`/api/v1/organizations/${org.organizationId}/members/${org.second.membershipId}`)
      .set(headers(actor))
      .then((response) => {
        requestSettled = true;
        return response;
      });

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(
      requestSettled,
      'The membership write answered while another transaction held the organisation row lock, ' +
        'so it never took that lock. The last-owner invariant is then two independent reads and ' +
        'the race in the first describe block of this file is open.',
    ).toBe(false);

    released.open();
    await blocker;

    const response = await pending;
    expect(response.status).toBe(204);
    expect(await liveOwnerCount(org.organizationId)).toBe(1);
  }, 60_000);

  it('two concurrent demotions of the two remaining owners leave the organisation with one', async () => {
    await clearRateLimits(harness.redis);
    const org = await organizationWithTwoOwners();
    const one = await sessionFor(org.first.userId, org.organizationId);
    const two = await sessionFor(org.second.userId, org.organizationId);
    const path = `/api/v1/organizations/${org.organizationId}/members`;

    const [a, b] = await Promise.all([
      request(server)
        .patch(`${path}/${org.second.membershipId}`)
        .set(headers(one))
        .send({ roleKey: 'ADMIN' }),
      request(server)
        .patch(`${path}/${org.first.membershipId}`)
        .set(headers(two))
        .send({ roleKey: 'ADMIN' }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 422]);
    expect(await liveOwnerCount(org.organizationId)).toBe(1);
  }, 60_000);

  it('two concurrent removals of the two remaining owners leave the organisation with one', async () => {
    await clearRateLimits(harness.redis);
    const org = await organizationWithTwoOwners();
    const one = await sessionFor(org.first.userId, org.organizationId);
    const two = await sessionFor(org.second.userId, org.organizationId);
    const path = `/api/v1/organizations/${org.organizationId}/members`;

    const [a, b] = await Promise.all([
      request(server).delete(`${path}/${org.second.membershipId}`).set(headers(one)),
      request(server).delete(`${path}/${org.first.membershipId}`).set(headers(two)),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([204, 422]);
    expect(await liveOwnerCount(org.organizationId)).toBe(1);
  }, 60_000);
});
