import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnscopedPrismaClient, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { withTenantTransaction } from './tenant-transaction.js';
import { newId } from './id.js';

let harness: PostgresHarness;
let owner: PrismaClient;
let app: PrismaClient;

const orgA = newId('org');
const orgB = newId('org');
const roleId = newId('rol');
const sharedUserId = newId('usr');

beforeAll(async () => {
  harness = await startPostgresHarness();
  owner = createUnscopedPrismaClient(harness.ownerUrl);
  app = createUnscopedPrismaClient(harness.appUrl);

  await owner.role.create({
    data: { id: roleId, key: 'OWNER', name: 'Owner', description: 'Owns the organisation.' },
  });
  await owner.organization.createMany({
    data: [
      { id: orgA, slug: 'rls-a', name: 'A' },
      { id: orgB, slug: 'rls-b', name: 'B' },
    ],
  });
  await owner.user.create({ data: { id: sharedUserId, email: `${sharedUserId}@example.test` } });
  await owner.auditEvent.createMany({
    data: [
      {
        id: newId('aud'),
        organizationId: orgA,
        actorType: 'SYSTEM',
        action: 'A',
        resourceType: 'T',
      },
      {
        id: newId('aud'),
        organizationId: orgB,
        actorType: 'SYSTEM',
        action: 'B',
        resourceType: 'T',
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  await app?.$disconnect();
  await harness?.stop();
});

describe('row-level security', () => {
  it('is the backstop: raw SQL that skips the client extension still sees only one tenant', async () => {
    const rows = await withTenantTransaction(
      app,
      orgA,
      (tx) => tx.$queryRaw<{ organizationId: string }[]>`SELECT "organizationId" FROM "AuditEvent"`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
  });

  it('returns nothing when no organisation setting is present — deny by default', async () => {
    const rows = await app.$queryRaw<unknown[]>`SELECT 1 FROM "AuditEvent"`;
    expect(rows).toHaveLength(0);
  });

  it('refuses an insert claiming another tenant', async () => {
    await expect(
      withTenantTransaction(
        app,
        orgA,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "AuditEvent" ("id","organizationId","actorType","action","resourceType","createdAt")
          VALUES (${newId('aud')}, ${orgB}, 'SYSTEM', 'X', 'T', now())`,
      ),
    ).rejects.toThrow();
  });

  it('does not grant BYPASSRLS to the application role', async () => {
    const rows = await owner.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sentinel_app'`;
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('enables and forces RLS on every registered tenant-owned table and the tenant root', async () => {
    // Organization (the tenant root) added in review round 3: its RLS flags
    // were correct from the moment the migration landed, but untested —
    // this only asserted the three TENANT_OWNED_MODELS.
    const rows = await owner.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('Membership', 'Invitation', 'AuditEvent', 'Organization')`;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it('revokes UPDATE and DELETE on AuditEvent from the application role', async () => {
    await expect(
      withTenantTransaction(
        app,
        orgA,
        (tx) => tx.$executeRaw`UPDATE "AuditEvent" SET "action" = 'TAMPERED'`,
      ),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(app, orgA, (tx) => tx.$executeRaw`DELETE FROM "AuditEvent"`),
    ).rejects.toThrow();
  });

  // N3 (review): AuditEvent's backstop test above was the only behavioural
  // proof RLS actually filters rows for the app role. The "enables and
  // forces" test checks pg_class flags for Membership and Invitation too,
  // but never proves either table's policy actually filters a row for
  // sentinel_app. These two close that gap the same way AuditEvent's does:
  // one shared user with a legitimate membership in both orgs (so the
  // fixture cannot accidentally pass by having nothing to leak), a raw
  // SELECT under orgA's transaction, and an assertion that only orgA's row
  // comes back.
  it('is the backstop for Membership: raw SQL under orgA sees only orgA membership rows', async () => {
    const membershipA = newId('mbr');
    const membershipB = newId('mbr');
    await owner.membership.createMany({
      data: [
        { id: membershipA, organizationId: orgA, userId: sharedUserId, roleId },
        { id: membershipB, organizationId: orgB, userId: sharedUserId, roleId },
      ],
    });

    const rows = await withTenantTransaction(
      app,
      orgA,
      (tx) =>
        tx.$queryRaw<{ id: string; organizationId: string }[]>`
        SELECT id, "organizationId" FROM "Membership" WHERE id IN (${membershipA}, ${membershipB})`,
    );
    expect(rows.map((row) => row.id)).toEqual([membershipA]);
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
  });

  it('is the backstop for Invitation: raw SQL under orgA sees only orgA invitation rows', async () => {
    const invitationA = newId('inv');
    const invitationB = newId('inv');
    const expiresAt = new Date(Date.now() + 86_400_000);
    await owner.invitation.createMany({
      data: [
        {
          id: invitationA,
          organizationId: orgA,
          email: `${invitationA}@example.test`,
          roleId,
          tokenHash: `hash_${invitationA}`,
          invitedByUserId: sharedUserId,
          expiresAt,
        },
        {
          id: invitationB,
          organizationId: orgB,
          email: `${invitationB}@example.test`,
          roleId,
          tokenHash: `hash_${invitationB}`,
          invitedByUserId: sharedUserId,
          expiresAt,
        },
      ],
    });

    const rows = await withTenantTransaction(
      app,
      orgA,
      (tx) =>
        tx.$queryRaw<{ id: string; organizationId: string }[]>`
        SELECT id, "organizationId" FROM "Invitation" WHERE id IN (${invitationA}, ${invitationB})`,
    );
    expect(rows.map((row) => row.id)).toEqual([invitationA]);
    expect(rows.every((row) => row.organizationId === orgA)).toBe(true);
  });

  it('FORCE ROW LEVEL SECURITY is load-bearing: without it, a non-superuser table owner bypasses its own policy', async () => {
    // The suite's existing tables can't demonstrate this: the owner
    // connection (harness.ownerUrl) is a Postgres superuser, which bypasses
    // RLS unconditionally regardless of FORCE, and sentinel_app is neither
    // the table owner nor a superuser, so RLS already applies to it with or
    // without FORCE. FORCE only changes behaviour for a role that owns the
    // table but isn't a superuser — so proving it needs exactly that role,
    // built here rather than borrowed from elsewhere in the suite.
    const probeRole = `force_probe_${newId('rol').slice(-13).toLowerCase()}`;
    const probePassword = 'force_probe_local';
    await owner.$executeRawUnsafe(
      `CREATE ROLE "${probeRole}" LOGIN PASSWORD '${probePassword}' NOSUPERUSER NOBYPASSRLS`,
    );
    await owner.$executeRawUnsafe(
      `CREATE TABLE "force_probe" (id text PRIMARY KEY, tenant text NOT NULL)`,
    );
    await owner.$executeRawUnsafe(`ALTER TABLE "force_probe" OWNER TO "${probeRole}"`);
    await owner.$executeRawUnsafe(`ALTER TABLE "force_probe" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY "p" ON "force_probe" USING (tenant = current_setting('app.organization_id', true))`,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "force_probe" VALUES ('row-1', 'someone-elses-tenant')`,
    );

    const probeUrl = new URL(harness.appUrl);
    probeUrl.username = probeRole;
    probeUrl.password = probePassword;
    const asOwner = createUnscopedPrismaClient(probeUrl.toString());
    try {
      // RLS is enabled but not forced, and this connection is the table's
      // own owner with no app.organization_id set at all — by Postgres's
      // default rule, a non-forced policy does not apply to the owner, so
      // the row from a completely different tenant is visible anyway.
      const withoutForce = await asOwner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "force_probe"`,
      );
      expect(withoutForce).toHaveLength(1);

      await owner.$executeRawUnsafe(`ALTER TABLE "force_probe" FORCE ROW LEVEL SECURITY`);

      const withForce = await asOwner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "force_probe"`,
      );
      expect(withForce).toHaveLength(0);
    } finally {
      await asOwner.$disconnect();
      await owner.$executeRawUnsafe(`DROP TABLE "force_probe"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${probeRole}"`);
    }
  });
});
