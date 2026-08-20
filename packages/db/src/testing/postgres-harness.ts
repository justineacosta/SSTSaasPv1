import { execSync } from 'node:child_process';
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

  // execSync (not execFileSync) deliberately: it always runs through a shell,
  // which is what lets `pnpm` resolve on Windows (it is a .cmd/.ps1 shim there,
  // not directly spawnable — execFileSync('pnpm', …) fails ENOENT). The command
  // is a fixed literal with no interpolated input, so shell execution carries
  // no injection risk here. Mirrors migration.integration.spec.ts.
  execSync('pnpm exec prisma migrate deploy', {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: ownerUrl, DIRECT_DATABASE_URL: ownerUrl },
    stdio: 'pipe',
  });

  return {
    ownerUrl,
    appUrl,
    // container.stop() resolves with a StoppedTestContainer; the harness
    // contract only promises completion, so the value is discarded.
    stop: async () => {
      await container.stop();
    },
  };
}
