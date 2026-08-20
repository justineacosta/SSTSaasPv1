/* eslint-disable no-console */
// Justification: the seed is a CLI script, not application code. Its output is
// for a human running `pnpm db:seed`, and routing it through the structured
// logger would make it strictly less readable at a terminal.

import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, type SystemRole } from '@sentinel/contracts';
import { createUnscopedPrismaClient, type PrismaClient } from './unscoped.js';
import { newId } from './id.js';

const ROLE_DESCRIPTIONS: Record<SystemRole, { name: string; description: string }> = {
  OWNER: { name: 'Owner', description: 'Owns the organisation. Full control, including billing.' },
  ADMIN: { name: 'Admin', description: 'Runs the organisation. Cannot change what it costs.' },
  SECURITY_LEAD: {
    name: 'Security lead',
    description: 'Leads testing. Accepts risk and authorises aggressive scanning.',
  },
  MEMBER: { name: 'Member', description: 'Day-to-day testing and triage.' },
  VIEWER: { name: 'Viewer', description: 'Read-only access to findings and reports.' },
  AUDITOR: {
    name: 'Auditor',
    description: 'Compliance review. Reads the audit log; deliberately cannot read evidence.',
  },
  GUEST: { name: 'Guest', description: 'Read-only, and only for explicitly shared projects.' },
};

/**
 * Loads REFERENCE DATA ONLY: system roles, permissions, and the grants between
 * them. It never creates organisations, users, findings, or scans.
 *
 * Seeding fake tenants would make an empty product look populated, which is
 * exactly the illusion this codebase exists to avoid. E2E fixtures are created
 * through the real API instead, so the tests exercise real code paths.
 *
 * CWE, OWASP, plan definitions, and the engine registry are seeded in the
 * phases that create their tables. See architecture/database.md §8.
 */
export async function seedReferenceData(
  prisma: PrismaClient,
): Promise<{ roles: number; permissions: number; grants: number }> {
  const permissionIds = new Map<string, string>();

  for (const key of PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { id: newId('prm'), key, description: key },
      select: { id: true },
    });
    permissionIds.set(key, row.id);
  }

  let grants = 0;

  for (const key of SYSTEM_ROLES) {
    const meta = ROLE_DESCRIPTIONS[key];
    const role = await prisma.role.upsert({
      where: { key },
      update: { name: meta.name, description: meta.description },
      create: { id: newId('rol'), key, name: meta.name, description: meta.description },
      select: { id: true },
    });

    const wantedIds = ROLE_PERMISSIONS[key].map((permission) => {
      const id = permissionIds.get(permission);
      if (id === undefined) throw new Error(`Unknown permission in matrix: ${permission}`);
      return id;
    });

    // Remove grants the matrix no longer contains, so editing the matrix and
    // re-seeding converges rather than accumulating.
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: wantedIds } },
    });

    await prisma.rolePermission.createMany({
      data: wantedIds.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    grants += wantedIds.length;
  }

  return { roles: SYSTEM_ROLES.length, permissions: PERMISSIONS.length, grants };
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DIRECT_DATABASE_URL or DATABASE_URL must be set.');

  const prisma = createUnscopedPrismaClient(url);
  try {
    const result = await seedReferenceData(prisma);
    console.log(
      `Seeded ${String(result.roles)} roles, ${String(result.permissions)} permissions, ` +
        `${String(result.grants)} grants. No tenant data created.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the integration test can import
// seedReferenceData without opening a database connection on import.
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('seed.ts') || invokedPath.endsWith('seed.js')) {
  await main();
}
