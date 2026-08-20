import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@sentinel/contracts';
import { createUnscopedPrismaClient, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { seedReferenceData } from './seed.js';

let harness: PostgresHarness;
let prisma: PrismaClient;

beforeAll(async () => {
  harness = await startPostgresHarness();
  prisma = createUnscopedPrismaClient(harness.ownerUrl);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await harness?.stop();
});

describe('seedReferenceData', () => {
  it('creates every system role and every permission', async () => {
    const result = await seedReferenceData(prisma);
    expect(result.roles).toBe(SYSTEM_ROLES.length);
    expect(result.permissions).toBe(PERMISSIONS.length);
    expect(await prisma.role.count()).toBe(SYSTEM_ROLES.length);
    expect(await prisma.permission.count()).toBe(PERMISSIONS.length);
  });

  it('grants each role exactly the permissions the matrix says', async () => {
    for (const roleKey of SYSTEM_ROLES) {
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: roleKey },
        select: { permissions: { select: { permission: { select: { key: true } } } } },
      });
      const granted = role.permissions.map((row) => row.permission.key).sort();
      expect(granted, roleKey).toEqual([...ROLE_PERMISSIONS[roleKey]].sort());
    }
  });

  it('is idempotent — a second run changes nothing', async () => {
    const before = {
      roles: await prisma.role.count(),
      permissions: await prisma.permission.count(),
      grants: await prisma.rolePermission.count(),
    };
    await seedReferenceData(prisma);
    expect({
      roles: await prisma.role.count(),
      permissions: await prisma.permission.count(),
      grants: await prisma.rolePermission.count(),
    }).toEqual(before);
  });

  it('creates no organisations, users, or audit events — an empty product must look empty', async () => {
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});
