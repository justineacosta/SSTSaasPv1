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
  await owner.auditEvent.createMany({
    data: [
      { id: newId('aud'), organizationId: orgA, actorType: 'SYSTEM', action: 'A', resourceType: 'T' },
      { id: newId('aud'), organizationId: orgB, actorType: 'SYSTEM', action: 'B', resourceType: 'T' },
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
    const rows = await withTenantTransaction(app, orgA, (tx) =>
      tx.$queryRaw<{ organizationId: string }[]>`SELECT "organizationId" FROM "AuditEvent"`,
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
      withTenantTransaction(app, orgA, (tx) =>
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

  it('enables and forces RLS on every registered tenant-owned table', async () => {
    const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('Membership', 'Invitation', 'AuditEvent')`;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it('revokes UPDATE and DELETE on AuditEvent from the application role', async () => {
    await expect(
      withTenantTransaction(app, orgA, (tx) =>
        tx.$executeRaw`UPDATE "AuditEvent" SET "action" = 'TAMPERED'`,
      ),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(app, orgA, (tx) => tx.$executeRaw`DELETE FROM "AuditEvent"`),
    ).rejects.toThrow();
  });
});
