import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
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
    // execSync always runs through a shell, which is what lets `pnpm`
    // resolve on Windows (it is a .cmd/.ps1 shim there, not directly
    // spawnable). The command is a fixed literal — no interpolated input —
    // so shell execution carries no injection risk here.
    const output = execSync('pnpm exec prisma migrate deploy', {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(output).toMatch(/migrations? (have been )?(successfully )?applied|No pending migrations/i);
  });
});
