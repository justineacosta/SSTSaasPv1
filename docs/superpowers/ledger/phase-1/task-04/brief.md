### Task 4: Compose stack, database schema, prefixed UUIDv7 IDs, first migration

The riskiest assumption in the plan — Prisma's native engine on Node 26 — is checked here, deliberately early, before six packages depend on the runtime choice.

**Files:**
- Create: `infra/docker/docker-compose.yml`, `infra/docker/postgres/init/01-app-role.sql`, `docker-compose.yml`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`, `packages/db/src/id.ts`, `packages/db/src/unscoped.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/id.spec.ts`, `packages/db/src/migration.integration.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/config`
- Produces:
  - `newId(prefix: IdPrefix): string` — e.g. `newId('org')` → `org_01J8XK...` (26 base32 chars)
  - `const ID_PREFIXES` — the prefix registry
  - `type IdPrefix = keyof typeof ID_PREFIXES`
  - `createUnscopedPrismaClient(databaseUrl: string): PrismaClient` from `@sentinel/db/unscoped`
  - Prisma models `Organization`, `User`, `Credential`, `Session`, `Membership`, `Role`, `Permission`, `RolePermission`, `Invitation`, `AuditEvent`

- [ ] **Step 1: Write the Compose stack**

`infra/docker/postgres/init/01-app-role.sql` — this file is consumed by **both** Compose and Testcontainers, so the two environments cannot drift:
```sql
-- The application connects as a least-privileged role. It is not a superuser
-- and does not have BYPASSRLS, which is the only thing that makes row-level
-- security a real second layer rather than decoration. See ADR-0006.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE sentinel_app LOGIN PASSWORD 'sentinel_app_local';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sentinel TO sentinel_app;
GRANT USAGE ON SCHEMA public TO sentinel_app;

-- Existing objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sentinel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;

-- Future objects created by the owner. Without this, every new table would be
-- invisible to the application until someone remembered to grant on it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sentinel_app;
```

`infra/docker/docker-compose.yml`:
```yaml
name: sentinel

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: sentinel
      POSTGRES_PASSWORD: sentinel_local
      POSTGRES_DB: sentinel
    ports: ['5432:5432']
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U sentinel -d sentinel']
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports: ['6379:6379']
    volumes: [redis-data:/data]
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: sentinel_local
      MINIO_ROOT_PASSWORD: sentinel_local_secret
    ports: ['9000:9000', '9001:9001']
    volumes: [minio-data:/data]
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 5s
      retries: 20

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 sentinel_local sentinel_local_secret &&
      for b in evidence reports uploads exports; do
        mc mb --ignore-existing local/$$b &&
        mc anonymous set none local/$$b;
      done
      "
    restart: 'no'

  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    ports: ['1025:1025', '8025:8025']
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:8025/readyz']
      interval: 5s
      timeout: 5s
      retries: 20

  # Deliberately vulnerable target for engine tests. Local only, and safe to
  # scan because we own it. Started with: docker compose --profile testing up -d
  vulnerable-target:
    image: bkimminich/juice-shop:latest
    profiles: [testing]
    restart: unless-stopped
    ports: ['8080:3000']

volumes:
  postgres-data:
  redis-data:
  minio-data:
```

Root `docker-compose.yml`:
```yaml
include:
  - infra/docker/docker-compose.yml
```

- [ ] **Step 2: Start the stack and verify every service is healthy**

```bash
docker compose up -d
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
```
Expected: `postgres`, `redis`, `minio`, `mailpit` all show `(healthy)`; `minio-init` shows `Exited (0)`.

Do not proceed until this is true. Exit criterion 2 is this command.

- [ ] **Step 3: Write the failing ID test**

`packages/db/src/id.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, newId, parseIdPrefix } from './id.js';

describe('newId', () => {
  it('produces a prefixed, 26-character Crockford base32 identifier', () => {
    const id = newId('org');
    expect(id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique identifiers under a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('fnd')));
    expect(ids.size).toBe(10_000);
  });

  it('sorts chronologically as a string, which is what gives index locality', async () => {
    const first = newId('scn');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId('scn');
    expect(first < second).toBe(true);
  });

  it('exposes a prefix for every entity type the API returns', () => {
    expect(ID_PREFIXES.org).toBe('org');
    expect(ID_PREFIXES.usr).toBe('usr');
    expect(ID_PREFIXES.aud).toBe('aud');
  });

  it('round-trips the prefix', () => {
    expect(parseIdPrefix(newId('mbr'))).toBe('mbr');
  });

  it('returns undefined for a string that is not one of our identifiers', () => {
    expect(parseIdPrefix('not-an-id')).toBeUndefined();
    expect(parseIdPrefix('xyz_01J8XK2P9V3QWERTYUIOPASDF')).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run it and verify it fails**

```bash
pnpm vitest run --project unit packages/db
```
Expected: FAIL — `Cannot find module './id.js'`.

- [ ] **Step 5: Implement identifiers**

`packages/db/src/id.ts`:
```ts
import { uuidv7obj } from 'uuidv7';

/**
 * Entity prefixes. IDs are opaque to clients (api/conventions.md §1) but
 * self-describing in a log line, which is worth a great deal when correlating
 * an incident across the API, a queue payload, and a worker.
 */
export const ID_PREFIXES = {
  org: 'org',
  usr: 'usr',
  mbr: 'mbr',
  ses: 'ses',
  crd: 'crd',
  rol: 'rol',
  prm: 'prm',
  inv: 'inv',
  aud: 'aud',
  req: 'req',
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

/** Crockford base32 — excludes I, L, O, and U to avoid transcription errors. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_BODY_LENGTH = 26;

function encodeCrockford(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  for (let index = 0; index < ID_BODY_LENGTH; index += 1) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/**
 * Generates a prefixed UUIDv7 identifier, e.g. `org_01J8XK2P9V3QWERTYUIOPASDF`.
 *
 * UUIDv7 is time-ordered, so index locality is good on the leading edge of
 * every table — which matters because every hot query in this product sorts by
 * recency. Base32 keeps it URL-safe and case-insensitive to read aloud.
 *
 * See ADR-0011.
 */
export function newId(prefix: IdPrefix): string {
  return `${ID_PREFIXES[prefix]}_${encodeCrockford(uuidv7obj().bytes)}`;
}

const ID_PATTERN = new RegExp(`^([a-z]{3})_[${ALPHABET}]{${ID_BODY_LENGTH}}$`);

export function parseIdPrefix(id: string): IdPrefix | undefined {
  const match = ID_PATTERN.exec(id);
  const candidate = match?.[1];
  if (candidate === undefined) return undefined;
  return candidate in ID_PREFIXES ? (candidate as IdPrefix) : undefined;
}
```

`packages/db/package.json`:
```json
{
  "name": "@sentinel/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./unscoped": { "types": "./dist/unscoped.d.ts", "default": "./dist/unscoped.js" }
  },
  "scripts": {
    "build": "prisma generate && tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:migrate:create": "prisma migrate dev --create-only",
    "db:migrate:deploy": "prisma migrate deploy",
    "db:reset": "prisma migrate reset --force",
    "db:studio": "prisma studio",
    "db:seed": "node --experimental-strip-types src/seed.ts"
  },
  "dependencies": {
    "@prisma/client": "^6.3.0",
    "uuidv7": "^1.0.2"
  },
  "devDependencies": {
    "@sentinel/config": "workspace:*",
    "@testcontainers/postgresql": "^10.16.0",
    "prisma": "^6.3.0",
    "typescript": "^5.7.0"
  }
}
```

Add to the root `package.json` scripts so the contract in `setup.md` holds:
```json
"db:migrate": "pnpm --filter @sentinel/db db:migrate",
"db:migrate:create": "pnpm --filter @sentinel/db db:migrate:create",
"db:reset": "pnpm --filter @sentinel/db db:reset",
"db:studio": "pnpm --filter @sentinel/db db:studio",
"db:seed": "pnpm --filter @sentinel/db db:seed"
```

- [ ] **Step 6: Write the Prisma schema**

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/client"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum OrganizationStatus {
  ACTIVE
  SUSPENDED
  TERMINATED
}

enum UserStatus {
  ACTIVE
  LOCKED
  DISABLED
}

enum MembershipStatus {
  ACTIVE
  INVITED
  REMOVED
}

enum SystemRoleKey {
  OWNER
  ADMIN
  SECURITY_LEAD
  MEMBER
  VIEWER
  AUDITOR
  GUEST
}

enum ActorType {
  USER
  API_KEY
  SYSTEM
  PLATFORM_ADMIN
}

// ---------------------------------------------------------------------------
// Tenant root
// ---------------------------------------------------------------------------

model Organization {
  id        String             @id
  slug      String             @unique
  name      String
  status    OrganizationStatus @default(ACTIVE)
  createdAt DateTime           @default(now()) @db.Timestamptz(6)
  updatedAt DateTime           @updatedAt @db.Timestamptz(6)

  memberships Membership[]
  invitations Invitation[]
  auditEvents AuditEvent[]

  @@index([status])
}

// ---------------------------------------------------------------------------
// Global identity. A User is one human with one login and many organisations;
// Membership is what makes them a participant in a tenant. This is why
// authorization is always (user, organization, permission), never
// (user, permission). See architecture/database.md §2.
// ---------------------------------------------------------------------------

model User {
  id              String     @id
  email           String     @unique
  emailVerifiedAt DateTime?  @db.Timestamptz(6)
  name            String?
  status          UserStatus @default(ACTIVE)
  createdAt       DateTime   @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime   @updatedAt @db.Timestamptz(6)

  credential  Credential?
  sessions    Session[]
  memberships Membership[]
  invitesSent Invitation[] @relation("InvitationInvitedBy")
}

model Credential {
  id           String   @id
  userId       String   @unique
  passwordHash String
  algorithm    String   @default("argon2id")
  createdAt    DateTime @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Session {
  id        String    @id
  userId    String
  tokenHash String    @unique
  // The organisation the session is currently acting in. Nullable because a
  // user may be signed in before choosing one. A Session is user-owned, not
  // tenant-owned, so it is deliberately NOT in the tenant resource registry.
  activeOrganizationId String?
  ip        String?
  userAgent String?
  expiresAt DateTime  @db.Timestamptz(6)
  revokedAt DateTime? @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, expiresAt])
}

// ---------------------------------------------------------------------------
// Roles are system-wide reference data in Phase 1. Custom per-organisation
// roles arrive in Phase 11 and will add a nullable organizationId here.
// ---------------------------------------------------------------------------

model Role {
  id          String        @id
  key         SystemRoleKey @unique
  name        String
  description String
  isSystem    Boolean       @default(true)
  createdAt   DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime      @updatedAt @db.Timestamptz(6)

  permissions RolePermission[]
  memberships Membership[]
  invitations Invitation[]
}

model Permission {
  id          String   @id
  key         String   @unique
  description String
  createdAt   DateTime @default(now()) @db.Timestamptz(6)

  roles RolePermission[]
}

model RolePermission {
  roleId       String
  permissionId String

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
  @@index([permissionId])
}

// ---------------------------------------------------------------------------
// Tenant-owned. Every one of these carries organizationId DIRECTLY, with a
// leading index, and must be registered in src/tenant-resources.ts.
// ---------------------------------------------------------------------------

model Membership {
  id             String           @id
  organizationId String
  userId         String
  roleId         String
  status         MembershipStatus @default(ACTIVE)
  createdAt      DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime         @updatedAt @db.Timestamptz(6)
  deletedAt      DateTime?        @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  role         Role         @relation(fields: [roleId], references: [id], onDelete: Restrict)

  @@unique([organizationId, userId])
  @@index([organizationId, status])
  @@index([userId])
}

model Invitation {
  id              String    @id
  organizationId  String
  email           String
  roleId          String
  tokenHash       String    @unique
  invitedByUserId String
  expiresAt       DateTime  @db.Timestamptz(6)
  acceptedAt      DateTime? @db.Timestamptz(6)
  revokedAt       DateTime? @db.Timestamptz(6)
  createdAt       DateTime  @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  role         Role         @relation(fields: [roleId], references: [id], onDelete: Restrict)
  invitedBy    User         @relation("InvitationInvitedBy", fields: [invitedByUserId], references: [id], onDelete: Restrict)

  @@unique([organizationId, email])
  @@index([organizationId, createdAt(sort: Desc)])
}

/// Append-only. UPDATE and DELETE are revoked from the application role by
/// migration and blocked by a trigger. See security/audit.md §2.
model AuditEvent {
  id             String    @id
  organizationId String
  actorType      ActorType
  actorId        String?
  action         String
  resourceType   String
  resourceId     String?
  metadata       Json      @default("{}")
  ip             String?
  userAgent      String?
  requestId      String?
  createdAt      DateTime  @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt(sort: Desc)])
  @@index([organizationId, actorId, createdAt(sort: Desc)])
  @@index([organizationId, resourceType, resourceId])
}
```

`packages/db/src/unscoped.ts`:
```ts
/**
 * THE ONLY MODULE THAT EXPORTS AN UNSCOPED PRISMA CLIENT.
 *
 * Importing this outside migrations, seeds, the tenant client itself, and the
 * platform-admin module is a defect, and an ESLint rule fails the build for it.
 * A query made through this client has no tenant predicate and will happily
 * return every organisation's rows. See security/tenant-isolation.md §2.
 */
import { PrismaClient } from '../generated/client/index.js';

export { PrismaClient };
export type { Prisma } from '../generated/client/index.js';

export function createUnscopedPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
```

`packages/db/src/index.ts` (extended in later tasks):
```ts
export { ID_PREFIXES, newId, parseIdPrefix } from './id.js';
export type { IdPrefix } from './id.js';
```

Add `packages/db/generated/` to `.gitignore`.

- [ ] **Step 7: Generate the client and create the first migration — THE NODE 26 CHECK**

```bash
cp .env.example .env
pnpm --filter @sentinel/db db:generate
pnpm --filter @sentinel/db db:migrate --name init_identity_and_tenancy
```

Expected: `prisma generate` completes and `migrate dev` reports the migration applied.

**If `prisma generate` or the client fails to load on Node 26**, stop and do this in order:
1. Record the exact error.
2. Try Prisma's Rust-free query compiler: add `previewFeatures = ["queryCompiler", "driverAdapters"]` to the generator and the `@prisma/adapter-pg` driver adapter.
3. If that also fails, **revisit decision D4**: set `.nvmrc` to `24`, change CI's `node-version-file` accordingly, and record the reversal in ADR-0012 with the captured error. Tell the user — do not work around it silently.

- [ ] **Step 8: Write the migration integration test**

`packages/db/src/migration.integration.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sentinel')
    .withUsername('sentinel')
    .withPassword('sentinel_local')
    .withCopyFilesToContainer([
      {
        source: resolve(packageRoot, '../../infra/docker/postgres/init/01-app-role.sql'),
        target: '/docker-entrypoint-initdb.d/01-app-role.sql',
      },
    ])
    .start();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('migrations', () => {
  it('apply cleanly to an empty database', () => {
    const url = container.getConnectionUri();
    const output = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(output).toMatch(/migrations? (have been )?applied|No pending migrations/i);
  });
});
```

> Note for the implementer: this spec file reads `process.env` to build a child-process environment. That is legitimate — it is a test harness, not application code — and the ESLint override for `**/*.spec.ts` in Task 1 permits it. If `no-restricted-properties` still fires, add `'no-restricted-properties': 'off'` to the spec-file block in `eslint.config.js`.

- [ ] **Step 9: Run all tests**

```bash
pnpm vitest run --project unit packages/db
pnpm test:integration
```
Expected: unit 6 pass; integration 1 passes.

- [ ] **Step 10: Verify the workspace and commit**

```bash
pnpm lint && pnpm typecheck && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(db): identity and tenancy schema with prefixed UUIDv7 identifiers

Docker Compose stack (Postgres 16, Redis 7, MinIO, Mailpit, and a
deliberately vulnerable target behind --profile testing), every service
health-checked because `up -d` returning is not the same as usable.

Prisma schema covering Organization, User, Credential, Session, Membership,
Role, Permission, RolePermission, Invitation and AuditEvent. Three of these
are tenant-owned and carry organizationId directly with a leading index.

Identifiers are application-generated UUIDv7 rendered as prefixed Crockford
base32, reconciling database.md §1 with the opaque-prefixed-string rule in
api/conventions.md §1. Time-ordered for index locality, opaque to clients,
self-describing in a log line.

Postgres init SQL creates the least-privileged sentinel_app role and is
shared by Compose and Testcontainers so the two cannot drift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

