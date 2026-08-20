import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createUnscopedPrismaClient } from './unscoped.js';
import { newId } from './id.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let container: StartedPostgreSqlContainer;
let migrateOutput: string;

/**
 * `sentinel_app` is the same least-privileged role in every environment
 * (01-app-role.sql is shared with Compose), so its credentials are fixed —
 * only the host/port/database vary per Testcontainers instance.
 */
function sentinelAppUrl(started: StartedPostgreSqlContainer): string {
  return `postgresql://sentinel_app:sentinel_app_local@${started.getHost()}:${String(started.getPort())}/${started.getDatabase()}`;
}

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

  const url = container.getConnectionUri();
  // execSync always runs through a shell, which is what lets `pnpm`
  // resolve on Windows (it is a .cmd/.ps1 shim there, not directly
  // spawnable). The command is a fixed literal — no interpolated input —
  // so shell execution carries no injection risk here.
  migrateOutput = execSync('pnpm exec prisma migrate deploy', {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    encoding: 'utf8',
  });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('migrations', () => {
  it('apply cleanly to an empty database', () => {
    expect(migrateOutput).toMatch(
      /migrations? (have been )?(successfully )?applied|No pending migrations/i,
    );
  });

  // The three assertions below exercise 01-app-role.sql, the file shared
  // verbatim with Compose (infra/docker/postgres/init/01-app-role.sql) and
  // with Task 6's harness. Migrations themselves run as the container
  // superuser, so the "apply cleanly" test above says nothing about
  // sentinel_app's privileges — these do.

  it('sentinel_app is not a superuser and cannot bypass row-level security', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'sentinel_app'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rolsuper).toBe(false);
      expect(rows[0]?.rolbypassrls).toBe(false);
    } finally {
      await admin.$disconnect();
    }
  });

  it('sentinel_app can select, insert, update, and delete on a migrated table', async () => {
    const app = createUnscopedPrismaClient(sentinelAppUrl(container));
    try {
      const id = newId('org');
      const created = await app.organization.create({
        data: { id, slug: `privilege-probe-${id}`, name: 'Privilege probe' },
      });
      expect(created.id).toBe(id);

      const updated = await app.organization.update({
        where: { id },
        data: { name: 'Privilege probe (updated)' },
      });
      expect(updated.name).toBe('Privilege probe (updated)');

      const found = await app.organization.findUnique({ where: { id } });
      expect(found?.id).toBe(id);

      await app.organization.delete({ where: { id } });
      const afterDelete = await app.organization.findUnique({ where: { id } });
      expect(afterDelete).toBeNull();
    } finally {
      await app.$disconnect();
    }
  });

  it('sentinel_app cannot create objects in the public schema', async () => {
    const app = createUnscopedPrismaClient(sentinelAppUrl(container));
    try {
      await expect(
        app.$executeRawUnsafe('CREATE TABLE privilege_probe_should_fail (id int)'),
      ).rejects.toThrow();
    } finally {
      await app.$disconnect();
    }
  });
});
