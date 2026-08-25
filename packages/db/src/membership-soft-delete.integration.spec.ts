import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnscopedPrismaClient, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { newId } from './id.js';

/**
 * Membership soft-deletes: removing a member sets `deletedAt` and moves
 * `status` to `REMOVED`; the row stays for the audit trail rather than
 * disappearing. The uniqueness rule the product actually wants is therefore
 * "at most one *live* membership per (organizationId, userId)", not "at most
 * one row ever" — a removed colleague must be re-invitable.
 *
 * A full unique index cannot express that difference, because a soft-deleted
 * row is still a row to the index. These tests are the behavioural statement
 * of the intended rule, asserted against a real Postgres because it is the
 * index that decides, not any application code.
 *
 * The owner connection is used deliberately: this is about table constraints,
 * not about tenant isolation, and routing through the tenant-scoped client or
 * RLS would only add a second reason a row could fail to insert.
 *
 * Both constraints under test here — the partial unique index and the
 * status/deletedAt CHECK — come from
 * migrations/20260824153519_membership_partial_unique.
 */

let harness: PostgresHarness;
let owner: PrismaClient;

const orgId = newId('org');
const roleId = newId('rol');

beforeAll(async () => {
  harness = await startPostgresHarness();
  owner = createUnscopedPrismaClient(harness.ownerUrl);

  await owner.role.create({
    data: { id: roleId, key: 'OWNER', name: 'Owner', description: 'Owns the organisation.' },
  });
  await owner.organization.create({
    data: { id: orgId, slug: 'membership-soft-delete', name: 'Membership soft delete' },
  });
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  await harness?.stop();
});

/** A fresh user per test, so no test can pass on another's leftovers. */
async function createUser(): Promise<string> {
  const userId = newId('usr');
  await owner.user.create({ data: { id: userId, email: `${userId}@example.test` } });
  return userId;
}

/** Removal as the product performs it: soft delete, not a row delete. */
async function removeMembership(id: string): Promise<void> {
  await owner.membership.update({
    where: { id },
    data: { status: 'REMOVED', deletedAt: new Date() },
  });
}

describe('Membership uniqueness is scoped to live rows', () => {
  it('re-invites a removed member: the same (organizationId, userId) pair inserts again', async () => {
    const userId = await createUser();
    const first = newId('mbr');
    await owner.membership.create({ data: { id: first, organizationId: orgId, userId, roleId } });
    await removeMembership(first);

    const second = newId('mbr');
    await expect(
      owner.membership.create({ data: { id: second, organizationId: orgId, userId, roleId } }),
    ).resolves.toMatchObject({ id: second, organizationId: orgId, userId });

    const both = await owner.membership.findMany({ where: { organizationId: orgId, userId } });
    expect(both.map((row) => row.id).sort()).toEqual([first, second].sort());
  });

  it('permits any number of removed memberships for one (organizationId, userId) pair', async () => {
    // Re-invite, remove, re-invite, remove: the history accumulates. A partial
    // index constrains only the rows where `deletedAt IS NULL`, so the count of
    // removed rows is unbounded by construction — this is the half of the rule
    // that a full unique index gets wrong even when nobody is currently a
    // member.
    const userId = await createUser();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newId('mbr');
      await owner.membership.create({ data: { id, organizationId: orgId, userId, roleId } });
      await removeMembership(id);
    }

    const removed = await owner.membership.count({
      where: { organizationId: orgId, userId, deletedAt: { not: null } },
    });
    expect(removed).toBe(3);
  });

  it('still refuses a second LIVE membership for the same (organizationId, userId) pair', async () => {
    // The invariant the index exists to protect. Relaxing uniqueness for
    // soft-deleted rows must not relax it for live ones — a user with two
    // active memberships in one organisation has two roles there, and every
    // authorization decision downstream would have to pick one.
    const userId = await createUser();
    await owner.membership.create({
      data: { id: newId('mbr'), organizationId: orgId, userId, roleId },
    });

    await expect(
      owner.membership.create({
        data: { id: newId('mbr'), organizationId: orgId, userId, roleId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

/**
 * REMOVAL IS ONE FACT, NOT TWO.
 *
 * The partial index keys on `deletedAt`, but `status` is an independent column
 * and nothing above the database correlates them. That leaves two divergent
 * states reachable by any code path that sets one and forgets the other, and
 * both are worse than the bug the partial index just fixed:
 *
 *   * status = 'ACTIVE' with `deletedAt` SET — outside the index's predicate,
 *     so it does not occupy the unique slot, so a SECOND live membership for
 *     the same pair inserts happily. An authorization query written the obvious
 *     way (`WHERE status = 'ACTIVE'`) then returns two memberships and two
 *     roles for one user in one organisation, and something downstream picks
 *     one.
 *   * status = 'REMOVED' with `deletedAt` NULL — inside the predicate, so it
 *     holds the unique slot while claiming to be removed, which is the original
 *     Phase 1 re-invite failure wearing different clothes.
 *
 * A CHECK constraint makes the two columns one fact. Asserted here rather than
 * trusted to a service method, because the service method is exactly what would
 * forget.
 *
 * The constraint ships in the SAME migration as the partial index
 * (20260824153519_membership_partial_unique), not a later one: they are two
 * halves of one invariant, and a database stopped between them would sit in
 * precisely the state described above. So every test in this file — the
 * uniqueness block and this one — is verifying that single migration.
 */
describe('removal state cannot diverge from deletedAt', () => {
  it('rejects an ACTIVE membership that is also soft-deleted', async () => {
    const userId = await createUser();
    await expect(
      owner.membership.create({
        data: {
          id: newId('mbr'),
          organizationId: orgId,
          userId,
          roleId,
          status: 'ACTIVE',
          deletedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a REMOVED membership that is not soft-deleted', async () => {
    const userId = await createUser();
    await expect(
      owner.membership.create({
        data: { id: newId('mbr'), organizationId: orgId, userId, roleId, status: 'REMOVED' },
      }),
    ).rejects.toThrow();
  });

  it('rejects an INVITED membership that is soft-deleted', async () => {
    // The third enum value, and the one a biconditional keyed on 'REMOVED'
    // could plausibly get wrong. An invitation that has not been accepted is a
    // LIVE row — it holds the (organizationId, userId) slot so the same person
    // cannot be invited twice — so it must not carry a deletedAt either.
    const userId = await createUser();
    await expect(
      owner.membership.create({
        data: {
          id: newId('mbr'),
          organizationId: orgId,
          userId,
          roleId,
          status: 'INVITED',
          deletedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a half-done removal performed by UPDATE, which is how it would really happen', async () => {
    // Nobody inserts a divergent row on purpose. They write
    // `update({ data: { status: 'REMOVED' } })` and forget deletedAt.
    const userId = await createUser();
    const id = newId('mbr');
    await owner.membership.create({ data: { id, organizationId: orgId, userId, roleId } });

    await expect(
      owner.membership.update({ where: { id }, data: { status: 'REMOVED' } }),
    ).rejects.toThrow();
  });

  it('accepts an INVITED membership that is not soft-deleted', async () => {
    // The other half: the constraint must not reject the legitimate state. A
    // pending invitation is a live membership row.
    const userId = await createUser();
    const id = newId('mbr');
    await expect(
      owner.membership.create({
        data: { id, organizationId: orgId, userId, roleId, status: 'INVITED' },
      }),
    ).resolves.toMatchObject({ id, status: 'INVITED', deletedAt: null });
  });
});
