import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnscopedPrismaClient, Prisma, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { withTenantTransaction } from './tenant-transaction.js';
import { MissingTenantContextError } from './errors.js';
import { newId } from './id.js';

/**
 * Proves the two isolation layers actually compose in the configuration
 * production will use: a tenant-scoped client, over the real least-privileged
 * `sentinel_app` role, inside `withTenantTransaction`. Every other db spec
 * file proves one layer at a time (tenant-client.integration.spec.ts uses a
 * superuser connection to isolate layer 1; rls.integration.spec.ts drives
 * raw SQL over `sentinel_app` to isolate layer 2). This file is what proves
 * they still work when wired together, including the class of case layer 1
 * structurally cannot see: relation traversal (nested reads and nested
 * writes) — see tenant-client.ts's file-level comment for why.
 */

let harness: PostgresHarness;
let owner: PrismaClient;
let app: PrismaClient;

const orgA = newId('org');
const orgB = newId('org');
const roleId = newId('rol');
const userA = newId('usr');
const userShared = newId('usr');
const inviter = newId('usr');
let membershipSharedA = '';
let membershipSharedB = '';

beforeAll(async () => {
  harness = await startPostgresHarness();
  owner = createUnscopedPrismaClient(harness.ownerUrl);
  app = createUnscopedPrismaClient(harness.appUrl);

  await owner.role.create({
    data: { id: roleId, key: 'OWNER', name: 'Owner', description: 'Owns the organisation.' },
  });
  await owner.organization.createMany({
    data: [
      { id: orgA, slug: 'tx-a', name: 'Tenant A' },
      { id: orgB, slug: 'tx-b', name: 'Tenant B' },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: userA, email: 'tx-a@example.test' },
      { id: userShared, email: 'tx-shared@example.test' },
      { id: inviter, email: 'tx-inviter@example.test' },
    ],
  });
  await owner.membership.create({
    data: { id: newId('mbr'), organizationId: orgA, userId: userA, roleId },
  });
  // userShared is a legitimate member of BOTH orgs — the fixture a nested
  // relation write can reach across a tenant boundary through, without any
  // fabrication. This is what makes the nested-write probes below a real
  // test of the boundary rather than of a fixture that happens not to exist.
  membershipSharedA = newId('mbr');
  membershipSharedB = newId('mbr');
  await owner.membership.createMany({
    data: [
      { id: membershipSharedA, organizationId: orgA, userId: userShared, roleId },
      { id: membershipSharedB, organizationId: orgB, userId: userShared, roleId },
    ],
  });
  // Invitations in both orgs sharing the same (global, non-tenant-owned)
  // Role — what the Role -> invitations nested-read probe below reaches.
  const expiresAt = new Date(Date.now() + 86_400_000);
  await owner.invitation.createMany({
    data: [
      {
        id: newId('inv'),
        organizationId: orgA,
        email: 'invited-a@example.test',
        roleId,
        tokenHash: 'hash_org_a_secret',
        invitedByUserId: inviter,
        expiresAt,
      },
      {
        id: newId('inv'),
        organizationId: orgB,
        email: 'invited-b@example.test',
        roleId,
        tokenHash: 'hash_org_b_secret',
        invitedByUserId: inviter,
        expiresAt,
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  await app?.$disconnect();
  await harness?.stop();
});

describe('both layers composed: tenant-scoped client + sentinel_app + withTenantTransaction', () => {
  it('scopes a top-level read over the real application role', async () => {
    const rows = await withTenantTransaction(app, orgA, (tx) => tx.membership.findMany());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
  });

  it('C4: findUnique still sees the same transaction — read-your-own-writes works', async () => {
    // This is the concrete regression M2 described: if findUnique's rewrite
    // escaped to a connection outside the active transaction, this would
    // either time out waiting on the row lock or simply not see the
    // uncommitted insert. Both create and findUnique run through the same
    // `tx` here, so if they land on different connections this fails.
    await withTenantTransaction(app, orgA, async (tx) => {
      // A fresh user: userA already has a membership in orgA from the
      // fixture, and Membership's (organizationId, userId) unique
      // constraint would collide with a second one for the same pair.
      const freshUser = newId('usr');
      await owner.user.create({ data: { id: freshUser, email: `${freshUser}@example.test` } });
      const id = newId('mbr');
      await tx.membership.create({ data: { id, userId: freshUser, roleId } as never });
      const found = await tx.membership.findUnique({ where: { id } });
      expect(found?.id).toBe(id);
    });
  });

  it("C4: findUnique inside a transaction still refuses another tenant's row", async () => {
    await withTenantTransaction(app, orgA, async (tx) => {
      const found = await tx.membership.findUnique({ where: { id: membershipSharedB } });
      expect(found).toBeNull();
    });
  });

  it('cross-tenant update/delete are still no-ops over the real application role', async () => {
    await withTenantTransaction(app, orgA, async (tx) => {
      const updated = await tx.membership.updateMany({
        where: { id: membershipSharedB },
        data: { status: 'REMOVED' },
      });
      expect(updated.count).toBe(0);

      const deleted = await tx.membership.deleteMany({ where: { id: membershipSharedB } });
      expect(deleted.count).toBe(0);
    });
  });
});

describe('select/omit and the findUniqueOrThrow oracle, over the real application role (review round 3)', () => {
  it('a narrow select still returns an owned row, without the scope column, over sentinel_app', async () => {
    await withTenantTransaction(app, orgA, async (tx) => {
      const row = await tx.membership.findUnique({
        where: { id: membershipSharedA },
        select: { id: true, status: true },
      });
      expect(row).toEqual({ id: membershipSharedA, status: 'ACTIVE' });
      expect(row).not.toHaveProperty('organizationId');
    });
  });

  it('findUniqueOrThrow raises byte-identical message and meta on the sentinel_app connection too', async () => {
    // Verification item 3: the oracle fix must hold on both connections —
    // the superuser one (tenant-client.integration.spec.ts), where only
    // layer 1's own check produces the error, and this one, where RLS would
    // otherwise have made the two cases look identical for a different
    // reason (the fetch returns nothing and Prisma's own P2025 fires first).
    // Proving it here confirms layer 1's guarantee holds independently of
    // whether RLS happens to be engaged. Deep-equals message and meta
    // against a genuine miss captured live in this same run, not a
    // hardcoded string (round 3 re-review) — class and code matching alone
    // was not sufficient, since the message text differed wherever RLS
    // wasn't also masking the difference.
    //
    // Both attempts are routed through the SAME call site deliberately: see
    // the equivalent test in tenant-client.integration.spec.ts for why —
    // Prisma's "Invalid `...` invocation" message embeds the caller's own
    // file/line/column, so two calls on two different lines would differ by
    // that alone, which is not the leak this test is checking for.
    await withTenantTransaction(app, orgA, async (tx) => {
      const attempt = async (
        id: string,
      ): Promise<Prisma.PrismaClientKnownRequestError | undefined> => {
        try {
          await tx.membership.findUniqueOrThrow({ where: { id } });
          return undefined;
        } catch (error) {
          return error as Prisma.PrismaClientKnownRequestError;
        }
      };

      const crossTenantError = await attempt(membershipSharedB);
      const genuineMissError = await attempt(newId('mbr'));

      expect(crossTenantError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(genuineMissError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(crossTenantError?.code).toBe('P2025');
      expect(crossTenantError?.code).toBe(genuineMissError?.code);
      expect(crossTenantError?.message).toBe(genuineMissError?.message);
      expect(crossTenantError?.meta).toEqual(genuineMissError?.meta);
    });
  });
});

describe('C3: the tenant root (Organization) is scoped, over both layers', () => {
  it("scopes Organization reads to the caller's own org", async () => {
    const rows = await withTenantTransaction(app, orgA, (tx) => tx.organization.findMany());
    expect(rows.map((row) => row.id)).toEqual([orgA]);
  });

  it("findUnique on Organization refuses another tenant's id", async () => {
    await withTenantTransaction(app, orgA, async (tx) => {
      const found = await tx.organization.findUnique({ where: { id: orgB } });
      expect(found).toBeNull();
    });
  });

  it('is the backstop for Organization too: raw SQL under orgA sees only orgA', async () => {
    const rows = await withTenantTransaction(
      app,
      orgA,
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Organization" WHERE id IN (${orgA}, ${orgB})`,
    );
    expect(rows.map((row) => row.id)).toEqual([orgA]);
  });

  it("refuses to delete another org rather than silently redirecting onto the caller's own", async () => {
    // M-note (review, tenant-scope.ts): a plain where-override here would
    // have silently turned "delete org B" into "delete my own org" instead
    // of failing, because `id` is both the caller's target field and the
    // scope key. scopeUniqueWhere refuses outright instead.
    await expect(
      withTenantTransaction(app, orgA, (tx) => tx.organization.delete({ where: { id: orgB } })),
    ).rejects.toThrow(MissingTenantContextError);

    // And the caller's own org is provably untouched by that attempt.
    const stillThere = await owner.organization.findUnique({ where: { id: orgA } });
    expect(stillThere?.id).toBe(orgA);
  });

  it('cannot delete Organization at all over sentinel_app — DELETE is revoked', async () => {
    await expect(
      withTenantTransaction(app, orgA, (tx) => tx.organization.delete({ where: { id: orgA } })),
    ).rejects.toThrow();
  });

  it('refuses to create or upsert an Organization through the tenant client', async () => {
    await expect(
      withTenantTransaction(app, orgA, (tx) =>
        tx.organization.create({ data: { id: newId('org'), slug: 'nope', name: 'Nope' } as never }),
      ),
    ).rejects.toThrow(MissingTenantContextError);
  });
});

describe('C1/C2: relation traversal is invisible to layer 1, caught by layer 2 (RLS)', () => {
  it('nested write (create): fabricating a membership under another tenant via a relation is rejected', async () => {
    // model === 'User' here, not 'Membership' — tenant-client.ts's extension
    // never sees this at all (User is neither tenant-owned nor the tenant
    // root). Only RLS's WITH CHECK on Membership stops it.
    await expect(
      withTenantTransaction(app, orgA, (tx) =>
        tx.user.update({
          where: { id: userA },
          data: { memberships: { create: { id: newId('mbr'), organizationId: orgB, roleId } } },
        }),
      ),
    ).rejects.toThrow();
  });

  it("nested write (updateMany): only the caller's own tenant's membership is touched", async () => {
    await withTenantTransaction(app, orgA, (tx) =>
      tx.user.update({
        where: { id: userShared },
        // `deletedAt` accompanies `status` because
        // Membership_status_deletedAt_agree_check requires the pair to agree:
        // a bare `status: 'REMOVED'` is now an invalid write rather than a
        // neutral one. The property under test is unchanged — the nested write
        // must reach only the caller's own tenant's membership.
        data: {
          memberships: {
            updateMany: { where: {}, data: { status: 'REMOVED', deletedAt: new Date() } },
          },
        },
      } as never),
    );

    const [rowA, rowB] = await Promise.all([
      owner.membership.findUnique({ where: { id: membershipSharedA } }),
      owner.membership.findUnique({ where: { id: membershipSharedB } }),
    ]);
    expect(rowA?.status).toBe('REMOVED');
    expect(rowB?.status).toBe('ACTIVE');

    // Restore for later tests in this file. `deletedAt` must be cleared, not
    // just `status` reset: the row was soft-deleted by the write above, and
    // Membership_status_deletedAt_agree_check rejects an ACTIVE row that still
    // carries a deletedAt. Undoing a removal means undoing both halves of it.
    await owner.membership.update({
      where: { id: membershipSharedA },
      data: { status: 'ACTIVE', deletedAt: null },
    });
  });

  it("nested write (deleteMany): only the caller's own tenant's membership is deleted", async () => {
    const extraA = newId('mbr');
    const extraUser = newId('usr');
    await owner.user.create({ data: { id: extraUser, email: `${extraUser}@example.test` } });
    await owner.membership.createMany({
      data: [{ id: extraA, organizationId: orgA, userId: extraUser, roleId }],
    });

    await withTenantTransaction(app, orgA, (tx) =>
      tx.user.update({
        where: { id: userShared },
        data: { memberships: { deleteMany: {} } },
      }),
    );

    const [remainingShared, remainingExtra] = await Promise.all([
      owner.membership.findMany({ where: { userId: userShared } }),
      owner.membership.findUnique({ where: { id: extraA } }),
    ]);
    // Only orgA's membership for userShared was visible under RLS, so only
    // it could be matched by the nested deleteMany — orgB's survives.
    expect(remainingShared.map((row) => row.organizationId)).toEqual([orgB]);
    // Unrelated membership (different user) is untouched either way.
    expect(remainingExtra?.id).toBe(extraA);

    // restore for later tests in this file
    membershipSharedA = newId('mbr');
    await owner.membership.create({
      data: { id: membershipSharedA, organizationId: orgA, userId: userShared, roleId },
    });
  });

  it("nested read: a global model's relation to Invitation leaks nothing outside RLS's reach", async () => {
    // Role is global reference data (no organizationId, not the tenant
    // root) — the extension does not touch it at all. Without RLS on
    // Invitation, `role.findMany({ include: { invitations: true } })` would
    // return every organisation's invitations, tokenHash included, to
    // whichever tenant happened to ask. With RLS engaged, the nested SELECT
    // for `invitations` is still a real SQL query against the Invitation
    // table, so the same per-table policy applies regardless of how the
    // query reached it.
    const roles = await withTenantTransaction(app, orgA, (tx) =>
      tx.role.findMany({ where: { id: roleId }, include: { invitations: true } }),
    );
    expect(roles).toHaveLength(1);
    const invitations = roles[0]?.invitations ?? [];
    expect(invitations.length).toBeGreaterThan(0);
    expect(invitations.every((invitation) => invitation.organizationId === orgA)).toBe(true);
    expect(invitations.some((invitation) => invitation.tokenHash === 'hash_org_b_secret')).toBe(
      false,
    );
  });
});

describe('referential-integrity cascades run below both layers', () => {
  it("deleting a User does not destroy another tenant's Membership through the FK cascade", async () => {
    // RI cascades execute inside Postgres's own constraint machinery, below
    // RLS and entirely outside the tenant-scoped client's view (the top-level
    // operation is `user.delete`, not `membership.delete` — decideScope never
    // sees the cascaded deletes at all). A user who legitimately belongs to
    // two organisations is exactly the shape that exposes this: deleting
    // them from orgA's context must not be able to reach orgB's row.
    const cascadeUser = newId('usr');
    await owner.user.create({ data: { id: cascadeUser, email: `${cascadeUser}@example.test` } });
    const cascadeMembershipA = newId('mbr');
    const cascadeMembershipB = newId('mbr');
    await owner.membership.createMany({
      data: [
        { id: cascadeMembershipA, organizationId: orgA, userId: cascadeUser, roleId },
        { id: cascadeMembershipB, organizationId: orgB, userId: cascadeUser, roleId },
      ],
    });

    // Restrict means Postgres itself refuses the delete while any Membership
    // (in any organisation) still references this user — not just a refusal
    // of the org-A row the caller can see, a refusal of the delete entirely.
    await expect(
      withTenantTransaction(app, orgA, (tx) => tx.user.delete({ where: { id: cascadeUser } })),
    ).rejects.toThrow();

    const [rowA, rowB] = await Promise.all([
      owner.membership.findUnique({ where: { id: cascadeMembershipA } }),
      owner.membership.findUnique({ where: { id: cascadeMembershipB } }),
    ]);
    expect(rowA?.id).toBe(cascadeMembershipA);
    expect(rowB?.id).toBe(cascadeMembershipB);
  });
});
