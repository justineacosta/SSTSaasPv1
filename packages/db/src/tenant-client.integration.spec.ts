import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnscopedPrismaClient, Prisma, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { createTenantClient, NEVER_MATCHES_ID } from './tenant-client.js';
import { MissingTenantContextError } from './errors.js';
import { newId } from './id.js';

let harness: PostgresHarness;
let root: PrismaClient;

const orgA = newId('org');
const orgB = newId('org');
const userA = newId('usr');
const userB = newId('usr');
const roleId = newId('rol');
let membershipA = '';
let membershipB = '';

beforeAll(async () => {
  harness = await startPostgresHarness();
  root = createUnscopedPrismaClient(harness.ownerUrl);

  await root.role.create({
    data: { id: roleId, key: 'OWNER', name: 'Owner', description: 'Owns the organisation.' },
  });
  await root.organization.createMany({
    data: [
      { id: orgA, slug: 'tenant-a', name: 'Tenant A' },
      { id: orgB, slug: 'tenant-b', name: 'Tenant B' },
    ],
  });
  await root.user.createMany({
    data: [
      { id: userA, email: 'a@example.test' },
      { id: userB, email: 'b@example.test' },
    ],
  });
  membershipA = newId('mbr');
  await root.membership.create({
    data: { id: membershipA, organizationId: orgA, userId: userA, roleId },
  });
  membershipB = newId('mbr');
  await root.membership.create({
    data: { id: membershipB, organizationId: orgB, userId: userB, roleId },
  });
}, 180_000);

afterAll(async () => {
  await root?.$disconnect();
  await harness?.stop();
});

describe('tenant-scoped client', () => {
  it('scopes findMany to the context organisation', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const rows = await db.membership.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgA);
  });

  it('rewrites findUnique into a tenant-scoped lookup — the single easiest mistake to make', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    // membershipB exists and its ID is correct; it simply belongs to Tenant B.
    const row = await db.membership.findUnique({ where: { id: membershipB } });
    expect(row).toBeNull();
  });

  it('returns the row through findUnique for the owning tenant', async () => {
    const db = createTenantClient(root, { organizationId: orgB });
    const row = await db.membership.findUnique({ where: { id: membershipB } });
    expect(row?.id).toBe(membershipB);
  });

  it('rewrites findUnique by a compound unique key, not just by id', async () => {
    // M3 (review): a compound `@@unique` is exactly the shape Phase 2's
    // lookups will use — findUnique's `where` for it is a nested compound
    // object (`{ organizationId_email: { organizationId, email } }`), not a
    // flat `id`. The old findFirst-rewrite merged the scope predicate as a
    // sibling of that nested object, which findFirst's WhereInput has no
    // field for. The current design (run the original query unmodified, check
    // the result) never touches `where` at all, so this shape was never at
    // risk — this test is what proves that.
    //
    // Phase 2 Task 1: this was written against
    // `Membership.@@unique([organizationId, userId])`, which no longer exists
    // — Membership's uniqueness is now a partial unique index in SQL, so
    // Prisma generates no compound `where` input for it. Retargeted to
    // Invitation's `@@unique([organizationId, email])`, the other compound
    // unique on a tenant-owned model. The property under test is the shape of
    // the `where`, not which table carries it.
    const invitationB = newId('inv');
    await root.invitation.create({
      data: {
        id: invitationB,
        organizationId: orgB,
        email: 'compound-unique@example.test',
        roleId,
        tokenHash: `hash_${invitationB}`,
        invitedByUserId: userB,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const asOrgA = createTenantClient(root, { organizationId: orgA });
    const deniedToA = await asOrgA.invitation.findUnique({
      where: {
        organizationId_email: { organizationId: orgB, email: 'compound-unique@example.test' },
      },
    });
    expect(deniedToA).toBeNull();

    const asOrgB = createTenantClient(root, { organizationId: orgB });
    const grantedToB = await asOrgB.invitation.findUnique({
      where: {
        organizationId_email: { organizationId: orgB, email: 'compound-unique@example.test' },
      },
    });
    expect(grantedToB?.id).toBe(invitationB);
  });

  it('scopes count', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    expect(await db.membership.count()).toBe(1);
  });

  it('injects organizationId on create', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const created = await db.auditEvent.create({
      data: {
        id: newId('aud'),
        actorType: 'SYSTEM',
        action: 'TEST_EVENT',
        resourceType: 'Test',
      } as never,
    });
    expect(created.organizationId).toBe(orgA);
  });

  it('refuses to update another tenant row', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const result = await db.membership.updateMany({
      where: { id: membershipB },
      data: { status: 'REMOVED' },
    });
    expect(result.count).toBe(0);
  });

  it('refuses to delete another tenant row', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const result = await db.membership.deleteMany({ where: { id: membershipB } });
    expect(result.count).toBe(0);
  });

  it('refuses to move a row to another tenant via update — data cannot override the injected predicate', async () => {
    // Not in the brief: found while reviewing the extension that `where`
    // scoping alone does not stop a caller from writing a different
    // organizationId into `data`, which would re-parent a row the caller
    // legitimately owns into another tenant. See tenant-client.ts's
    // SCOPED_WHERE_AND_DATA_OPERATIONS and the upsert branch.
    // A fresh user, distinct from userA/userB, so this membership doesn't
    // collide with the (organizationId, userId) unique constraint the other
    // fixtures already occupy.
    const userC = newId('usr');
    await root.user.create({ data: { id: userC, email: 'c@example.test' } });

    const db = createTenantClient(root, { organizationId: orgA });
    const ownRow = await db.membership.create({
      data: { id: newId('mbr'), userId: userC, roleId } as never,
    });
    expect(ownRow.organizationId).toBe(orgA);

    // `deletedAt` is set alongside `status` because the
    // Membership_status_deletedAt_agree_check constraint requires the two to
    // agree — a bare `status: 'REMOVED'` is an invalid write, not a neutral
    // one, so leaving it out makes this test fail on the payload instead of
    // exercising the property. This is also what real removal code writes.
    // The property under test is unchanged: organizationId in `data` must not
    // override the injected tenant predicate.
    const updated = await db.membership.update({
      where: { id: ownRow.id },
      data: { status: 'REMOVED', deletedAt: new Date(), organizationId: orgB } as never,
    });
    expect(updated.organizationId).toBe(orgA);

    // Confirm at the root (unscoped) level too, not just what the tenant
    // client itself echoes back.
    const raw = await root.membership.findUnique({ where: { id: ownRow.id } });
    expect(raw?.organizationId).toBe(orgA);
  });

  it('leaves global models unscoped — User is not tenant-owned', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    expect(await db.user.count()).toBeGreaterThanOrEqual(2);
  });

  it('throws when there is no organisation in context', async () => {
    const db = createTenantClient(root, { organizationId: '' });
    await expect(db.membership.findMany()).rejects.toThrow(MissingTenantContextError);
  });
});

describe('cross-tenant harness over the resource registry', () => {
  it('gives Tenant A nothing for every registered tenant-owned model', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const rows = await Promise.all([
      db.membership.findMany({ where: { organizationId: orgB } }),
      db.invitation.findMany({ where: { organizationId: orgB } }),
      db.auditEvent.findMany({ where: { organizationId: orgB } }),
    ]);
    // The injected predicate wins over the caller-supplied one: asking for
    // Tenant B's rows never yields a row that actually belongs to Tenant B.
    // (Membership and AuditEvent legitimately hold Tenant A's own rows by
    // this point in the suite — from beforeAll and the "injects
    // organizationId on create" test above — so the correct assertion is
    // "no leaked row", not "empty result".)
    for (const result of rows) {
      for (const row of result) {
        expect((row as { organizationId: string }).organizationId).not.toBe(orgB);
      }
    }
  });
});

describe('select/omit do not defeat the scope check (review round 3)', () => {
  it('findUnique with a narrow select still returns an owned row, without the scope column', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const row = await db.membership.findUnique({
      where: { id: membershipA },
      select: { id: true, status: true },
    });
    expect(row).toEqual({ id: membershipA, status: 'ACTIVE' });
    expect(row).not.toHaveProperty('organizationId');
  });

  it('findUnique with omit excluding the scope column still returns an owned row, without it', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const row = await db.membership.findUnique({
      where: { id: membershipA },
      omit: { organizationId: true },
    });
    expect(row?.id).toBe(membershipA);
    expect(row).not.toHaveProperty('organizationId');
  });

  it('findUnique with a select that already asks for the scope column keeps it', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const row = await db.membership.findUnique({
      where: { id: membershipA },
      select: { id: true, organizationId: true },
    });
    expect(row).toEqual({ id: membershipA, organizationId: orgA });
  });

  it('the tenant root: findUnique with select excluding id still returns the row, without id', async () => {
    const db = createTenantClient(root, { organizationId: orgA });
    const row = await db.organization.findUnique({
      where: { id: orgA },
      select: { name: true },
    });
    expect(row).toEqual({ name: 'Tenant A' });
    expect(row).not.toHaveProperty('id');
  });

  it('a narrow select does not let a cross-tenant row through', async () => {
    // The property under test isn't just "select works" — it's that
    // narrowing the projection cannot become a second way to bypass the
    // scope check the way the original design's where-injection could.
    const db = createTenantClient(root, { organizationId: orgA });
    const row = await db.membership.findUnique({
      where: { id: membershipB },
      select: { id: true, status: true },
    });
    expect(row).toBeNull();
  });
});

describe('findUniqueOrThrow is not an existence oracle across tenants (review round 3)', () => {
  it('raises byte-identical message and meta for a cross-tenant row as for one that does not exist', async () => {
    // Round-3 re-review: class and code matching is not enough. Where RLS is
    // absent (the unscoped client, migrations, seeds, the future
    // platform-admin module), a hand-constructed message/meta would still be
    // distinguishable from Prisma's own. This deep-equals message and meta
    // against a genuine miss captured live in this same test run, rather
    // than a hardcoded string — so it also catches drift if Prisma's own
    // wording ever changes, instead of silently rotting.
    //
    // Both attempts are routed through the SAME call site (this one
    // function) deliberately: Prisma's "Invalid `...` invocation" message
    // embeds the caller's own file/line/column, captured at the point
    // `findUniqueOrThrow` was invoked — not anything about the target row.
    // Two calls written on two different lines in this test would differ by
    // that location text alone, which would be a false positive for "the
    // oracle still leaks" (it wouldn't — a single real call site in
    // application code always reports its own location, never the target
    // row's tenant). Funnelling both through one function is what makes this
    // a fair comparison of the same call site's two possible outcomes.
    const db = createTenantClient(root, { organizationId: orgA });
    const attempt = async (
      id: string,
    ): Promise<Prisma.PrismaClientKnownRequestError | undefined> => {
      try {
        await db.membership.findUniqueOrThrow({ where: { id } });
        return undefined;
      } catch (error) {
        return error as Prisma.PrismaClientKnownRequestError;
      }
    };

    const crossTenantError = await attempt(membershipB);
    const genuineMissError = await attempt(newId('mbr'));

    expect(crossTenantError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(genuineMissError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(crossTenantError?.code).toBe('P2025');
    expect(crossTenantError?.code).toBe(genuineMissError?.code);
    expect(crossTenantError?.message).toBe(genuineMissError?.message);
    expect(crossTenantError?.meta).toEqual(genuineMissError?.meta);
  });

  it('still throws not-found even when a row id literally collides with the fallback sentinel', async () => {
    // Found live in review: the fallback query used to be a plain equality
    // lookup (`{ id: NEVER_MATCHES_ID }`), which a row planted with that
    // exact id — reachable only through the unscoped client, exactly the
    // connection this test uses — could satisfy, returning that row's full,
    // unrelated content instead of throwing. Only reachable on a connection
    // that can insert arbitrary ids at all (RLS and newId()'s Crockford
    // format both independently prevent it in normal operation), but this is
    // precisely that connection, so it must still hold here.
    const collisionUser = newId('usr');
    await root.user.create({ data: { id: collisionUser, email: `${collisionUser}@example.test` } });
    await root.membership.create({
      data: { id: NEVER_MATCHES_ID, organizationId: orgB, userId: collisionUser, roleId },
    });

    const db = createTenantClient(root, { organizationId: orgA });
    await expect(
      db.membership.findUniqueOrThrow({ where: { id: membershipB } }),
    ).rejects.toMatchObject({
      code: 'P2025',
    });
  });
});
