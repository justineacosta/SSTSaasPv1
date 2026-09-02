import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createUnscopedPrismaClient } from './unscoped.js';
import { newId } from './id.js';
import { seedReferenceData } from './seed.js';

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

  /**
   * THE PRIVILEGE PHASE 1 REVOKED, AND THE DRIFT THAT HID IT FOR A WHOLE TASK.
   *
   * `20260820132520_tenant_root_and_audit_restrict` ends with
   * `REVOKE DELETE ON "Organization" FROM sentinel_app`, and says why:
   * "Deleting a tenant is a platform-admin operation (Phase 11), not something
   * request-path code should be able to do at all. Without DELETE, the
   * Organization -> AuditEvent cascade this migration just changed to RESTRICT
   * can never be triggered by the application role in the first place."
   *
   * **Nothing asserted it, and the compose database had drifted.** On
   * 2026-09-02 the local Postgres reported
   * `has_table_privilege('sentinel_app', 'Organization', 'DELETE') = t` while a
   * freshly replayed database reported `f` — so a probe run locally returned the
   * foreign-key error and looked like the whole story, and the endpoint built on
   * that probe answered 500 the first time it met a correctly migrated
   * database. Same shape as ADR-0020's own warning, on a different control: a
   * local role that is incidentally more privileged than the real one.
   *
   * `UPDATE` is asserted alongside it, in the other direction. The revoke is
   * deliberately narrow — renaming an organisation is an ordinary
   * `organization.update` operation — so a broader `REVOKE UPDATE, DELETE`
   * would break `PATCH /api/v1/organizations/:id` and this is what would say so.
   */
  it('sentinel_app cannot DELETE an Organization, and can still UPDATE one', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<{ del: boolean; upd: boolean; sel: boolean }[]>`
        SELECT has_table_privilege('sentinel_app', 'public."Organization"', 'DELETE') AS del,
               has_table_privilege('sentinel_app', 'public."Organization"', 'UPDATE') AS upd,
               has_table_privilege('sentinel_app', 'public."Organization"', 'SELECT') AS sel
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.del).toBe(false);
      expect(rows[0]?.upd).toBe(true);
      expect(rows[0]?.sel).toBe(true);
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

/**
 * ADR-0020's containment argument, asserted rather than described.
 *
 * The ADR's consequences say this in as many words: "the migration integration
 * spec must assert `rolbypassrls = true` and `rolcanlogin = false` on
 * `sentinel_org_lookup` and that `EXECUTE` is granted to `sentinel_app` and
 * revoked from `PUBLIC`. Without those assertions this ADR's whole argument
 * rests on a role attribute nothing checks."
 *
 * It is checked here rather than in `apps/api` because the properties are
 * properties of the migrated database, not of any code that calls it — and
 * because `20260902083622_organization_lookup_function` is the only place they
 * are established. The application-side proof that the *lookup* obeys them
 * lives in `apps/api/src/modules/organizations/organizations.integration.spec.ts`,
 * which drives the endpoint over `sentinel_app`.
 */
describe('ADR-0020: user_organizations(text)', () => {
  it('sentinel_org_lookup can bypass row-level security and cannot log in', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; rolinherit: boolean }[]
      >`
        SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit
        FROM pg_roles WHERE rolname = 'sentinel_org_lookup'
      `;
      // Asserted before the field reads so a role that does not exist fails
      // here rather than as four `undefined`s that are not `true`.
      expect(rows).toHaveLength(1);
      // THE ATTRIBUTE THE WHOLE DECISION RESTS ON. Without it the definer
      // function is still bound by FORCE ROW LEVEL SECURITY and returns zero
      // rows — measured, and recorded in the migration's own comment.
      expect(rows[0]?.rolbypassrls).toBe(true);
      // Nothing connects as it. The bypass is a property of one function, not
      // a credential anybody holds.
      expect(rows[0]?.rolcanlogin).toBe(false);
      // Not a superuser: BYPASSRLS is the only elevated attribute it carries.
      expect(rows[0]?.rolsuper).toBe(false);
      // NOINHERIT, so a role granted membership of it does not pick the bypass
      // up implicitly — only by an explicit SET ROLE.
      expect(rows[0]?.rolinherit).toBe(false);
    } finally {
      await admin.$disconnect();
    }
  });

  it('is a SECURITY DEFINER function owned by that role with a pinned search_path', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<
        { prosecdef: boolean; owner: string; proconfig: string[] | null }[]
      >`
        SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'user_organizations'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.prosecdef).toBe(true);
      expect(rows[0]?.owner).toBe('sentinel_org_lookup');
      // `pg_temp` MUST BE PRESENT AND MUST BE LAST, and the value this pinned
      // before Task 13's review did neither.
      //
      // Postgres searches the temporary schema FIRST for relation names unless
      // `pg_temp` is written explicitly, in which case it is searched where it
      // is written. So `search_path = public` — the value this assertion used
      // to pin, with a comment claiming it "closes the standard SECURITY
      // DEFINER hijack" — left `pg_temp` implicitly first, and a caller holding
      // TEMPORARY could shadow `Membership` with a temp table of their own.
      // Measured: the function returned a real `Organization` row for a user
      // with no membership, under `BYPASSRLS`, to a role whose direct reads of
      // both tables return zero rows. The transcript is in
      // `20260902130000_organization_lookup_search_path/migration.sql`.
      //
      // The pin was right; the value pinned was the vulnerable one, and the
      // comment beside it asserted the opposite. Both are corrected here.
      const searchPath = rows[0]?.proconfig ?? [];
      const entries = (searchPath[0] ?? '').replace(/^search_path=/, '').split(/\s*,\s*/);

      // THE RULE IS ASSERTED FIRST, AND THE ORDER OF THESE THREE LINES IS THE
      // WHOLE POINT.
      //
      // These two assertions used to sit BELOW the equality, with a comment
      // claiming they would catch a `pg_temp`-moved-earlier edit "with a message
      // naming the actual rule rather than an equality mismatch". The review of
      // the residual sweep proved that exactly inverted: `toEqual` runs first,
      // so any mutation that breaks the rule also breaks the equality, the test
      // stops there, and these lines never execute. **They could not fail.**
      // They were decoration presented as a defence — and ADR-0021 nominated
      // them as "the pattern to copy", which would have propagated the shape.
      //
      // Ordered this way, a `search_path = pg_temp, public` edit fails on the
      // last-entry assertion with a message about `pg_temp`, and the equality
      // below still pins the exact value for everything else.
      expect(entries, 'pg_temp must appear in the definer function search_path').toContain(
        'pg_temp',
      );
      expect(
        entries[entries.length - 1],
        'pg_temp must be LAST in the search_path. Postgres searches the temporary schema first ' +
          'for relation names when pg_temp is not listed explicitly, and anywhere but last it is ' +
          'searched before the schema that holds the real tables — which is ADR-0021 reopened.',
      ).toBe('pg_temp');
      expect(searchPath).toEqual(['search_path=public, pg_temp']);
    } finally {
      await admin.$disconnect();
    }
  });

  it('grants EXECUTE to sentinel_app and revokes it from PUBLIC', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<{ app: boolean; anyone: boolean }[]>`
        SELECT has_function_privilege('sentinel_app', 'public.user_organizations(text)', 'EXECUTE')
                 AS app,
               has_function_privilege('public', 'public.user_organizations(text)', 'EXECUTE')
                 AS anyone
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.app).toBe(true);
      // Postgres grants EXECUTE to PUBLIC on every new function by default, so
      // the REVOKE is what makes the grant above mean anything at all.
      expect(rows[0]?.anyone).toBe(false);
    } finally {
      await admin.$disconnect();
    }
  });

  /**
   * THE SECOND, INDEPENDENT DEFENCE AGAINST ADR-0021's ATTACK.
   *
   * Pinning `pg_temp` last protects `user_organizations(text)`. Revoking
   * TEMPORARY removes the *precondition* for the whole class: a caller who
   * cannot create a temporary relation cannot shadow `"Membership"` in the
   * first place, whatever a future definer function's `search_path` says.
   *
   * Both are asserted, separately, on the ADR-0006 argument that two
   * independent mechanisms must both be wrong before a tenant sees another
   * tenant's rows. Either one alone is recoverable: a superuser or a
   * deliberately-granted role can hold TEMPORARY again, and a future migration
   * can forget the `search_path` pin.
   *
   * PostgreSQL grants TEMPORARY to PUBLIC on every database by default, so —
   * exactly like the `REVOKE EXECUTE ... FROM PUBLIC` above — the revoke is
   * what makes this false rather than anything the schema does.
   */
  it('revokes TEMPORARY from PUBLIC, so sentinel_app cannot create the shadowing table', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    try {
      const rows = await admin.$queryRaw<{ app: boolean; anyone: boolean }[]>`
        SELECT has_database_privilege('sentinel_app', current_database(), 'TEMPORARY') AS app,
               has_database_privilege('public', current_database(), 'TEMPORARY')       AS anyone
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.anyone).toBe(false);
      // `sentinel_app` holds no TEMPORARY of its own either — it had this only
      // by way of the PUBLIC default, which is the point.
      expect(rows[0]?.app).toBe(false);
    } finally {
      await admin.$disconnect();
    }
  });

  it('returns a user’s organisations to sentinel_app across tenants, where a direct read returns none', async () => {
    const admin = createUnscopedPrismaClient(container.getConnectionUri());
    const app = createUnscopedPrismaClient(sentinelAppUrl(container));
    try {
      await seedReferenceData(admin);
      const role = await admin.role.findUniqueOrThrow({
        where: { key: 'OWNER' },
        select: { id: true },
      });
      const userId = newId('usr');
      await admin.user.create({ data: { id: userId, email: `adr20-${userId}@example.test` } });

      // Two organisations, and a third the user was REMOVED from.
      //
      // ARRANGED TO LOSE, per carry-forward ruling 100: the removed membership
      // is written FIRST and the live ones after, so a function body that had
      // dropped `deletedAt IS NULL` / `status = 'ACTIVE'` would return the
      // removed organisation at the head of the result rather than at the tail,
      // where an assertion on the first row would miss it. The assertion below
      // is on the whole set, which is stronger still.
      const removed = newId('org');
      const first = newId('org');
      const second = newId('org');
      for (const [id, slug] of [
        [removed, 'adr20-removed'],
        [first, 'adr20-first'],
        [second, 'adr20-second'],
      ] as const) {
        await admin.organization.create({
          data: { id, slug: `${slug}-${userId}`, name: slug },
        });
      }
      await admin.membership.create({
        data: {
          id: newId('mbr'),
          organizationId: removed,
          userId,
          roleId: role.id,
          // Ruling 10: `status` and `deletedAt` are one fact, and the CHECK
          // constraint refuses a `REMOVED` row that is not soft-deleted.
          status: 'REMOVED',
          deletedAt: new Date(),
        },
      });
      for (const organizationId of [first, second]) {
        await admin.membership.create({
          data: { id: newId('mbr'), organizationId, userId, roleId: role.id, status: 'ACTIVE' },
        });
      }

      // THE MEASUREMENT ADR-0020 TURNS ON, as the role the API really uses.
      // `sentinel_app` reading `Membership` directly, with no tenant context,
      // sees nothing — this is the naive implementation, and it is empty.
      const direct = await app.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM "Membership" m WHERE m."userId" = ${userId}
      `;
      expect(direct).toEqual([]);

      // The same role, through the function, sees both live memberships and
      // not the removed one.
      const viaFunction = await app.$queryRaw<{ id: string; slug: string }[]>`
        SELECT id, slug FROM user_organizations(${userId})
      `;
      expect(viaFunction.map((row) => row.id).sort()).toEqual([first, second].sort());
    } finally {
      await app.$disconnect();
      await admin.$disconnect();
    }
  });
});
