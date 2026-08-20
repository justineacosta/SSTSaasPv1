// Prisma CLI commands that talk to a database (migrate, studio, reset) load
// environment variables from a `.env` file located next to `schema.prisma`,
// not from the workspace root — a `pnpm --filter` invocation runs with this
// package as its cwd, and Prisma never walks up to find the root `.env`.
//
// Rather than keeping a second, hand-maintained `.env` here (which would
// drift from the root file the rest of the workspace reads), this script
// copies the root `.env` into `prisma/.env` immediately before any db:*
// script that needs a live connection runs. `prisma/.env` is gitignored, so
// the root file stays the single source of truth developers edit.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(here, '../../../.env');
const targetEnvPath = resolve(here, '../prisma/.env');

if (existsSync(rootEnvPath)) {
  copyFileSync(rootEnvPath, targetEnvPath);
} else {
  process.stderr.write(
    'sync-env: no root .env found — run `cp .env.example .env` from the repo root first.\n',
  );
  process.exit(1);
}
