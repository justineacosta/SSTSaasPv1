### Task 7: Seed — system roles and permissions

**Files:**
- Create: `packages/db/src/seed.ts`
- Test: `packages/db/src/seed.integration.spec.ts`

**Interfaces:**
- Consumes: `PERMISSIONS`, `SYSTEM_ROLES`, `ROLE_PERMISSIONS` (Task 5); `newId` (Task 4); `createUnscopedPrismaClient` (Task 4); `startPostgresHarness` (Task 6)
- Produces: `seedReferenceData(prisma: PrismaClient): Promise<{ roles: number; permissions: number; grants: number }>`

- [ ] **Step 1: Write the failing test**

`packages/db/src/seed.integration.spec.ts`:
```ts
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
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm vitest run --project integration packages/db/src/seed
```
Expected: FAIL — `Cannot find module './seed.js'`.

- [ ] **Step 3: Implement the seed**

`packages/db/src/seed.ts`:
```ts
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
```

Add `@sentinel/contracts` to `packages/db` dependencies. Add `packages/db/src/seed.ts` to the
`no-restricted-properties: off` override in `eslint.config.js` — seeds are one of the three
exemptions named in `coding-standards.md` §6.

- [ ] **Step 4: Run the test and verify it passes**

```bash
pnpm vitest run --project integration packages/db/src/seed
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the seed against the live compose stack, twice**

```bash
pnpm db:seed
pnpm db:seed
```
Expected: identical counts both times, and no error on the second run.

- [ ] **Step 6: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(db): idempotent seed for system roles and permissions

Reference data only: the seven system roles, every permission string, and
the grants between them, driven by ROLE_PERMISSIONS in packages/contracts so
the seed cannot disagree with the matrix.

No organisations, users, findings, or scans are ever created. An empty
product must look empty; seeding fake tenants is the specific illusion this
codebase avoids. CWE, OWASP, plans, and the engine registry wait for the
phases that create their tables.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

