### Task 6: Tenant-scoped Prisma client, RLS, resource registry, isolation harness

**This is the task Phase 1 exists for.** Exit criterion 5.

**Files:**
- Create: `packages/db/src/tenant-resources.ts`, `packages/db/src/tenant-context.ts`, `packages/db/src/tenant-client.ts`, `packages/db/src/tenant-transaction.ts`, `packages/db/src/errors.ts`
- Create: `packages/db/prisma/migrations/<timestamp>_row_level_security/migration.sql`
- Create: `packages/db/src/testing/postgres-harness.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/tenant-client.integration.spec.ts`, `packages/db/src/rls.integration.spec.ts`

**Interfaces:**
- Consumes: `createUnscopedPrismaClient` (Task 4), `newId` (Task 4)
- Produces:
  - `TENANT_OWNED_MODELS: readonly string[]` — the registry
  - `interface TenantContext { readonly organizationId: string }`
  - `class MissingTenantContextError extends Error`
  - `createTenantClient(base: PrismaClient, context: TenantContext): TenantPrismaClient`
  - `withTenantTransaction<T>(base, organizationId, fn: (tx) => Promise<T>): Promise<T>` — sets `app.organization_id` for RLS
  - `startPostgresHarness(): Promise<{ url: string; stop(): Promise<void> }>` — Testcontainers helper reused by every later integration test

- [ ] **Step 1: Write the registry and the shared Testcontainers harness**

`packages/db/src/tenant-resources.ts`:
```ts
/**
 * THE TENANT RESOURCE REGISTRY.
 *
 * Every Prisma model carrying an `organizationId` column must appear here.
 * A CI check reads the Prisma DMMF and fails the build if one does not, which
 * is what stops isolation coverage rotting as the schema grows — isolation bugs
 * do not appear in the code that was reviewed for isolation, they appear in the
 * table someone added six months later.
 *
 * See security/tenant-isolation.md §4 and development/migrations.md §5.
 */
export const TENANT_OWNED_MODELS = ['Membership', 'Invitation', 'AuditEvent'] as const;

export type TenantOwnedModel = (typeof TENANT_OWNED_MODELS)[number];

const TENANT_OWNED_SET: ReadonlySet<string> = new Set(TENANT_OWNED_MODELS);

export function isTenantOwnedModel(model: string | undefined): model is TenantOwnedModel {
  return model !== undefined && TENANT_OWNED_SET.has(model);
}
```

`packages/db/src/testing/postgres-harness.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const initSql = resolve(packageRoot, '../../infra/docker/postgres/init/01-app-role.sql');

export interface PostgresHarness {
  /** Owner connection — schema owner, used by migrations. */
  readonly ownerUrl: string;
  /** Least-privileged application connection — subject to RLS. */
  readonly appUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts a real Postgres 16, applies the same init SQL Compose uses, and runs
 * the migrations. Shared by every integration test so the test environment and
 * the development environment cannot drift.
 */
export async function startPostgresHarness(): Promise<PostgresHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sentinel')
    .withUsername('sentinel')
    .withPassword('sentinel_local')
    .withCopyFilesToContainer([{ source: initSql, target: '/docker-entrypoint-initdb.d/01.sql' }])
    .start();

  const ownerUrl = container.getConnectionUri();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUrl = `postgresql://sentinel_app:sentinel_app_local@${host}:${port}/sentinel?schema=public`;

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: ownerUrl, DIRECT_DATABASE_URL: ownerUrl },
    stdio: 'pipe',
  });

  return { ownerUrl, appUrl, stop: () => container.stop() };
}
```

- [ ] **Step 2: Write the failing tenant-client test**

`packages/db/src/tenant-client.integration.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnscopedPrismaClient, type PrismaClient } from './unscoped.js';
import { startPostgresHarness, type PostgresHarness } from './testing/postgres-harness.js';
import { createTenantClient } from './tenant-client.js';
import { MissingTenantContextError } from './errors.js';
import { newId } from './id.js';

let harness: PostgresHarness;
let root: PrismaClient;

const orgA = newId('org');
const orgB = newId('org');
const userA = newId('usr');
const userB = newId('usr');
const roleId = newId('rol');
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
  await root.membership.create({
    data: { id: newId('mbr'), organizationId: orgA, userId: userA, roleId },
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
    // another tenant's rows returns nothing rather than returning them.
    for (const result of rows) expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

```bash
pnpm vitest run --project integration packages/db/src/tenant-client
```
Expected: FAIL — `Cannot find module './tenant-client.js'`.

- [ ] **Step 4: Implement the tenant client**

`packages/db/src/errors.ts`:
```ts
export class MissingTenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `No organisation in context for ${model}.${operation}. ` +
        'Tenant-owned models must be queried through a tenant-scoped client.',
    );
    this.name = 'MissingTenantContextError';
  }
}
```

`packages/db/src/tenant-context.ts`:
```ts
export interface TenantContext {
  readonly organizationId: string;
}
```

`packages/db/src/tenant-client.ts`:
```ts
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
// Justification: Prisma's client-extension callbacks are typed as `unknown` for
// `args`, and rewriting one operation into another requires indexing the client
// by model name. Both are unavoidable here. The unsafe surface is confined to
// this file, and every behaviour it implements is covered by
// tenant-client.integration.spec.ts.

import type { PrismaClient } from './unscoped.js';
import { MissingTenantContextError } from './errors.js';
import type { TenantContext } from './tenant-context.js';
import { isTenantOwnedModel } from './tenant-resources.js';

export type TenantPrismaClient = PrismaClient;

/** Operations whose `where` must carry the tenant predicate. */
const SCOPED_WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/** Operations whose `data` must carry the tenant column. */
const SCOPED_DATA_OPERATIONS = new Set(['create', 'createMany']);

function modelDelegate(client: PrismaClient, model: string): Record<string, Function> {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (client as unknown as Record<string, Record<string, Function>>)[key] ?? {};
}

function withTenantData(data: unknown, organizationId: string): unknown {
  if (Array.isArray(data)) return data.map((row) => ({ ...(row as object), organizationId }));
  return { ...(data as object), organizationId };
}

/**
 * Binds a Prisma client to one organisation.
 *
 * Handlers only ever receive this client. It injects the tenant predicate into
 * every read and write on tenant-owned models and throws if no organisation is
 * present, so a handler cannot query another tenant's rows even if its author
 * forgets to filter. See ADR-0006 and security/tenant-isolation.md §2.
 */
export function createTenantClient(
  base: PrismaClient,
  context: TenantContext,
): TenantPrismaClient {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantOwnedModel(model)) return query(args);

          const { organizationId } = context;
          if (organizationId === '' || organizationId === undefined) {
            throw new MissingTenantContextError(model, operation);
          }

          // findUnique accepts only unique fields in `where`, so the predicate
          // cannot simply be added. It is rewritten into findFirst instead.
          // Without this, findUnique({ where: { id } }) would bypass isolation
          // entirely — the single most common multi-tenant Prisma bug.
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            const next = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            const call = modelDelegate(base, model)[next];
            const typed = args as { where?: Record<string, unknown> };
            return call?.({ ...typed, where: { ...(typed.where ?? {}), organizationId } });
          }

          if (SCOPED_WHERE_OPERATIONS.has(operation)) {
            const typed = args as { where?: Record<string, unknown> };
            return query({ ...typed, where: { ...(typed.where ?? {}), organizationId } } as never);
          }

          if (SCOPED_DATA_OPERATIONS.has(operation)) {
            const typed = args as { data?: unknown };
            return query({ ...typed, data: withTenantData(typed.data, organizationId) } as never);
          }

          if (operation === 'upsert') {
            const typed = args as { where?: Record<string, unknown>; create?: unknown };
            return query({
              ...typed,
              where: { ...(typed.where ?? {}), organizationId },
              create: withTenantData(typed.create, organizationId),
            } as never);
          }

          // Any operation not enumerated above is refused rather than passed
          // through unscoped. Failing closed is the only safe default here.
          throw new MissingTenantContextError(model, operation);
        },
      },
    },
  }) as unknown as TenantPrismaClient;
}
```

`packages/db/src/tenant-transaction.ts`:
```ts
import type { PrismaClient } from './unscoped.js';

/**
 * Runs `fn` inside a transaction whose `app.organization_id` setting is set,
 * which is what activates the row-level security policies.
 *
 * SET LOCAL is used deliberately: the setting is scoped to the transaction, so
 * a pooled connection handed to the next request cannot inherit it. A
 * session-level SET on a pooled connection is a real and well-documented way to
 * leak one tenant's context into another's request.
 *
 * Phase 1 provides this mechanism and tests it. Phase 2 wires it into the
 * request pipeline, once there are tenant-owned routes to wire it into.
 */
export async function withTenantTransaction<T>(
  base: PrismaClient,
  organizationId: string,
  fn: (tx: Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    // Parameterised: set_config is a function call, not string interpolation
    // into DDL, so a hostile organizationId cannot escape it.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
```

Extend `packages/db/src/index.ts`:
```ts
export { ID_PREFIXES, newId, parseIdPrefix } from './id.js';
export type { IdPrefix } from './id.js';
export { MissingTenantContextError } from './errors.js';
export { createTenantClient } from './tenant-client.js';
export type { TenantPrismaClient } from './tenant-client.js';
export type { TenantContext } from './tenant-context.js';
export { withTenantTransaction } from './tenant-transaction.js';
export { isTenantOwnedModel, TENANT_OWNED_MODELS } from './tenant-resources.js';
export type { TenantOwnedModel } from './tenant-resources.js';
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
pnpm vitest run --project integration packages/db/src/tenant-client
```
Expected: PASS, 10 tests.

- [ ] **Step 6: Write the failing RLS test**

`packages/db/src/rls.integration.spec.ts`:
```ts
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
```

- [ ] **Step 7: Run it and verify it fails**

```bash
pnpm vitest run --project integration packages/db/src/rls
```
Expected: FAIL — RLS is not enabled yet, so tenant B's row is visible and the `pg_class` assertions fail.

- [ ] **Step 8: Write the RLS migration**

```bash
pnpm --filter @sentinel/db db:migrate:create --name row_level_security
```

Then replace the generated (empty) `migration.sql` with:

```sql
-- Row-level security: the second, independent isolation layer (ADR-0006).
--
-- The mandatory tenant-scoped Prisma client is layer 1. This is layer 2, and it
-- catches what layer 1 cannot: hand-written SQL, raw analytics queries, future
-- ORM changes, and any bug in the extension itself. Two independent mechanisms
-- must both be wrong for a tenant to see another tenant's rows.

-- FORCE is required: without it the table owner bypasses its own policy, which
-- would make the whole thing decorative in any environment where the app and
-- the owner are the same role.

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Membership"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Invitation"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditEvent"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

-- The audit log is append-only. Tamper-resistance is enforced at the database
-- privilege level rather than by convention, because a convention does not
-- survive an attacker who already has application-level access.
-- See security/audit.md §2 and development/migrations.md §6.
REVOKE UPDATE, DELETE ON "AuditEvent" FROM sentinel_app;

CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
```

- [ ] **Step 9: Apply and re-run**

```bash
pnpm --filter @sentinel/db db:migrate
pnpm vitest run --project integration packages/db
```
Expected: PASS, 16 integration tests across the three db spec files.

- [ ] **Step 10: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
security(db): mandatory tenant scoping, row-level security, resource registry

Layer 1: a Prisma client extension that injects organizationId into every
read and write on tenant-owned models, rewrites findUnique into a scoped
findFirst, throws when no organisation is in context, and refuses any
operation it does not explicitly know how to scope.

Layer 2: PostgreSQL row-level security with FORCE on every tenant table,
keyed to a per-transaction app.organization_id set via SET LOCAL so a pooled
connection cannot inherit the previous request's tenant.

Plus: AuditEvent UPDATE and DELETE revoked from the application role and
blocked by a trigger, and the tenant resource registry that CI will check.

Proven, not asserted: 16 integration tests against a real Postgres 16,
including that the application role has neither BYPASSRLS nor superuser.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

