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
    // Uses User rather than Organization deliberately: this probe checks the
    // *raw* GRANT-level privileges from 01-app-role.sql, independent of any
    // row-level security policy. Organization (the tenant root, since Task
    // 6's review round) now carries an RLS policy requiring
    // app.organization_id to be set, and sentinel_app additionally has
    // DELETE revoked on it outright — so it can no longer serve as a
    // generic "any migrated table" probe. User is global (not tenant-owned,
    // not the tenant root) and carries no RLS, so it isolates what this
    // test is actually about.
    const app = createUnscopedPrismaClient(sentinelAppUrl(container));
    try {
      const id = newId('usr');
      const created = await app.user.create({
        data: { id, email: `privilege-probe-${id}@example.test` },
      });
      expect(created.id).toBe(id);

      const updated = await app.user.update({
        where: { id },
        data: { name: 'Privilege probe (updated)' },
      });
      expect(updated.name).toBe('Privilege probe (updated)');

      const found = await app.user.findUnique({ where: { id } });
      expect(found?.id).toBe(id);

      await app.user.delete({ where: { id } });
      const afterDelete = await app.user.findUnique({ where: { id } });
      expect(afterDelete).toBeNull();
    } finally {
      await app.$disconnect();
    }
  });

  // Phase 2 Task 1 adds four user-owned tables. They get no RLS policy — they
  // carry no organizationId and are not tenant-owned — but sentinel_app still
  // has to be able to read and write them, and NOTHING IN THE MIGRATION GRANTS
  // THAT. The privileges arrive implicitly, from the ALTER DEFAULT PRIVILEGES
  // statement at the end of infra/docker/postgres/init/01-app-role.sql, which
  // covers tables created afterwards by the owner role that runs migrations.
  //
  // An implicit privilege is one nobody notices is missing until a runtime
  // permission error in a flow nobody expected to fail, so this asserts it
  // rather than assuming it — that assertion is the whole of the plan's
  // "extend the grant block" bullet that is real (Task 1 brief, Ruling 2).
  // Writing an explicit GRANT instead would create a second, divergent source
  // of truth for the same privileges, and would mean editing an already-applied
  // migration.
  //
  // On that last point, precisely, because an earlier version of this comment
  // got it wrong: editing an applied migration changes its checksum, and on
  // Prisma 6.19 that breaks `prisma migrate dev` — NOT `prisma migrate deploy`,
  // which does not verify checksums and was measured to exit 0 against an edited
  // history. So the blast radius is local development only. CI and fresh clones
  // replay from an empty database, where there is no recorded checksum to
  // disagree with, and are unaffected.
  //
  // The table list is written out rather than derived from the registry: this
  // test is about what THIS task created, and a derived list would quietly
  // start passing on an empty set if the derivation ever broke.
  it('sentinel_app holds SELECT, INSERT, UPDATE and DELETE on every table this phase adds', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      // Fixed literal, no interpolated input — same reasoning as the
      // $executeRawUnsafe probes elsewhere in this file. format('%I.%I', …)
      // quotes the identifiers, which matters because every table here is
      // PascalCase and would otherwise fold to lowercase and not resolve.
      const rows = await admin.$queryRawUnsafe<
        { table: string; privilege: string; granted: boolean }[]
      >(`
        SELECT t.name AS "table",
               p.name AS "privilege",
               has_table_privilege('sentinel_app', format('%I.%I', 'public', t.name), p.name)
                 AS "granted"
        FROM unnest(ARRAY['MfaFactor', 'RecoveryCode', 'VerificationToken',
                          'IdentityProviderLink']) AS t(name)
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(name)
      `);

      // Four tables x four privileges. Asserted before the loop so a query that
      // returned nothing — a renamed table, a broken ARRAY — fails here rather
      // than passing a `for` loop over zero rows.
      expect(rows).toHaveLength(16);
      for (const row of rows) {
        expect(row.granted, `sentinel_app lacks ${row.privilege} on "${row.table}"`).toBe(true);
      }
    } finally {
      await admin.$disconnect();
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
