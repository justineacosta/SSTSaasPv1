# Phase 1 — Production Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an empty repository into a pnpm + Turborepo workspace that builds, lints, typechecks, tests, boots against Postgres/Redis/MinIO/Mailpit, and provably enforces multi-tenant isolation at the data layer.

**Architecture:** A modular monolith monorepo. `packages/*` hold shared code (config, observability, contracts, db, storage, ui); `apps/*` hold deployables (`api` = NestJS, `web` = Next.js). Dependency direction is one-way: apps depend on packages, packages depend on packages, no package ever imports from an app. Build order is a thin vertical slice thickened layer by layer, so CI is green from the first commit and every layer arrives with its tests.

**Tech Stack:** Node 26 · pnpm 11.5.0 · TypeScript 5.x strict · Turborepo · Vitest + Testcontainers · Prisma 6 + PostgreSQL 16 · Redis 7 · MinIO (S3) · NestJS 11 · Next.js 15 App Router · Tailwind v4 · Pino · Zod · ESLint 9 flat config · Playwright

**Spec:** [`docs/superpowers/specs/2026-08-20-phase-1-foundation-design.md`](../specs/2026-08-20-phase-1-foundation-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec and from `.claude/`.

- **Runtime:** Node 26 pinned via `.nvmrc`; `package.json` `engines.node` is `">=22"`. Package manager is `pnpm@11.5.0`, declared in root `packageManager`.
- **Modules:** Everything is ESM. Every `package.json` sets `"type": "module"`. TypeScript uses `"module": "nodenext"`, `"moduleResolution": "nodenext"`.
- **TypeScript:** `strict: true` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`. **No `any`** without an `// eslint-disable-next-line` carrying a written justification.
- **Validation:** Every external input is validated with Zod at the boundary. Types are inferred from schemas (`z.infer`), never hand-written alongside them.
- **Secrets:** No raw secret is ever stored or logged. `process.env` is read **only** inside `packages/config`.
- **Logging:** No `console.log` anywhere. Use the structured logger from `packages/observability`.
- **Colour:** No raw hex values in components. Design tokens only.
- **Tenancy:** Every tenant-owned table carries `organizationId` directly, with a leading index. Every tenant-owned model is registered in `packages/db/src/tenant-resources.ts` or CI fails.
- **Naming:** Files `kebab-case.ts`; React components `PascalCase.tsx`. Domain vocabulary is fixed: *asset, scope, scan, finding, occurrence, evidence, retest, engagement, report, organisation*.
- **Files** stay under ~300 lines.
- **Git:** Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `security:`). Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
- **Honesty:** Never write "Implemented" in `roadmap.md` or anywhere else without captured command output proving it. Status vocabulary is **Implemented / Partially Implemented / Not Implemented / Blocked**.
- **Branch:** All work lands on `feat/phase-1-foundation`. Nothing is pushed to GitHub without asking the user first.

---

## File Structure

Files created by this plan, and what each is responsible for.

**Root**
| File | Responsibility |
|---|---|
| `package.json` | Workspace root; scripts; `packageManager`; `engines` |
| `pnpm-workspace.yaml` | Declares `apps/*`, `packages/*` |
| `turbo.json` | Task graph and caching for build/lint/typecheck/test |
| `tsconfig.base.json` | The single source of compiler strictness |
| `eslint.config.js` | Flat config; all lint-enforced security rules |
| `.prettierrc`, `.prettierignore` | Formatting |
| `vitest.workspace.ts` | Unit and integration project definitions |
| `.nvmrc` | `26` |
| `.env.example` | Every variable, safe placeholder, comment |
| `docker-compose.yml` | Thin root file delegating to `infra/docker/` |
| `.github/workflows/ci.yml` | install → lint → typecheck → test → integration → build → checks |

**`packages/config`** — the only module allowed to read `process.env`
| File | Responsibility |
|---|---|
| `src/env.ts` | Zod env schema, segmented shared/api/web |
| `src/load-env.ts` | `loadEnv()` — parse once, crash naming the bad variable |
| `src/index.ts` | Public exports |
| `tsconfig/*.json` | Shared compiler presets |

**`packages/observability`**
| File | Responsibility |
|---|---|
| `src/redaction.ts` | Structural redaction — key denylist + value-shape backstop |
| `src/context.ts` | `AsyncLocalStorage` request context |
| `src/logger.ts` | Pino factory wiring redaction + context |

**`packages/db`** — load-bearing
| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Identity + tenancy schema |
| `prisma/migrations/*` | Forward-only SQL, including RLS |
| `src/id.ts` | Prefixed UUIDv7 identifiers |
| `src/tenant-resources.ts` | The registry CI checks |
| `src/tenant-client.ts` | The mandatory tenant-scoped Prisma client |
| `src/tenant-transaction.ts` | Sets `app.organization_id` for RLS |
| `src/unscoped.ts` | The one module exporting the raw client |
| `src/seed.ts` | Reference data only |

**`packages/contracts`**
| File | Responsibility |
|---|---|
| `src/error-codes.ts` | The stable code union |
| `src/error-envelope.ts` | The error response schema |
| `src/pagination.ts` | The collection envelope |
| `src/ids.ts` | Branded ID schemas + prefix registry |
| `src/permissions.ts` | Permission strings + system-role matrix |

**`packages/storage`**
| File | Responsibility |
|---|---|
| `src/adapter.ts` | The `StorageAdapter` interface |
| `src/keys.ts` | Key builders with a non-optional tenant prefix |
| `src/s3-adapter.ts` | S3-compatible implementation |

**`apps/api`** — `src/common/`, `src/infrastructure/`, `src/modules/health/`
**`apps/web`** — `app/(marketing|auth|app)/`, `middleware.ts`, `app/api/`
**`packages/ui`** — `src/tokens.css`, `src/components/*.tsx`
**`infra/docker/`** — compose file, Postgres init SQL, MinIO bucket init
**`.claude/skills/`** — `sentinel-phase/SKILL.md`, `sentinel-verify/SKILL.md`

---

## Task Order and Rationale

| # | Task | Why here |
|---|---|---|
| 1 | Workspace skeleton + CI | CI green before any product code |
| 2 | `packages/config` | Everything else needs validated env |
| 3 | `packages/observability` | Everything else needs the logger |
| 4 | Compose stack + db schema + IDs + first migration | **Earliest possible Node 26 / Prisma check** |
| 5 | `packages/contracts` | Needed by the seed and the API |
| 6 | Tenant client + RLS + registry + isolation harness | Exit criterion 5 |
| 7 | Seed: system roles and permissions | Needs 5 and 6 |
| 8 | `packages/storage` | Independent of the API |
| 9 | `apps/api` bootstrap + headers + errors + health | Needs 2, 3, 4, 5 |
| 10 | `apps/api` rate limiting | Needs 9 and Redis |
| 11 | Route access assertion + OpenAPI | Needs 9 |
| 12 | `packages/ui` tokens + primitives | Independent |
| 13 | `apps/web` | Needs 12 |
| 14 | CI checks: OpenAPI diff + registry completeness | Needs 6 and 11 |
| 15 | Reusable skills | Independent |
| 16 | ADRs, docs, roadmap, full verification | Last — status moves only with evidence |

---

### Task 1: Workspace skeleton, tooling, and green CI

Produces a real-but-empty workspace where `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all succeed, and CI runs them.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.workspace.ts`, `.nvmrc`, `.env.example`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: root scripts `lint`, `typecheck`, `test`, `test:integration`, `build`, `format`; the `@sentinel/*` package namespace; `tsconfig.base.json` as the extend target for every package

- [ ] **Step 1: Create the workspace root files**

`.nvmrc`:
```
26
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json`:
```json
{
  "name": "sentinel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "eslint-import-resolver-typescript": "^4.0.0",
    "eslint-plugin-import": "^2.31.0",
    "prettier": "^3.3.0",
    "turbo": "^2.5.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.20.0",
    "vitest": "^3.0.0"
  }
}
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "endOfLine": "lf"
}
```

`.prettierignore`:
```
pnpm-lock.yaml
dist
.next
.turbo
coverage
packages/db/generated
**/*.md
```

`vitest.workspace.ts`:
```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts'],
      exclude: ['**/*.integration.spec.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/src/**/*.integration.spec.ts', 'apps/*/src/**/*.integration.spec.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 120_000,
      fileParallelism: false,
    },
  },
]);
```

- [ ] **Step 2: Write the ESLint flat config with the security rules**

`eslint.config.js` — every rule here corresponds to a line in [`.claude/development/coding-standards.md`](../../../.claude/development/coding-standards.md) §6:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', 'packages/db/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      // coding-standards.md §1 — no `any` without written justification
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // §5 — no floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // §6 — no console.log; use the structured logger
      'no-console': 'error',
      // §6 — no alert/confirm/prompt
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Use the design system dialog.' },
        { name: 'confirm', message: 'Use ConfirmDialog.' },
        { name: 'prompt', message: 'Use a form.' },
      ],
      // §6 — no process.env outside packages/config
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read env only in packages/config.' },
      ],
      // §6 — no unscoped Prisma client outside migrations, seeds, platform admin
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/unscoped', '@sentinel/db/unscoped'],
              message: 'Use the tenant-scoped client. See security/tenant-isolation.md.',
            },
          ],
        },
      ],
    },
  },
  // packages/config is the one place allowed to touch process.env
  {
    files: ['packages/config/src/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // seeds, migrations, and the tenant client itself may use the unscoped client
  {
    files: ['packages/db/src/unscoped.ts', 'packages/db/src/seed.ts', 'packages/db/src/tenant-client.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // tests may assert on console and use the unscoped client to set up fixtures
  {
    files: ['**/*.spec.ts', '**/*.integration.spec.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
```

- [ ] **Step 3: Write `.env.example`**

Every variable, with a safe local placeholder and a comment saying what it is for. `.gitignore` already permits this file.

```bash
# ---------------------------------------------------------------------------
# Sentinel — local development environment.
# Copy to .env. These placeholders are safe for LOCAL USE ONLY.
# Never copy a staging or production secret into this file.
# ---------------------------------------------------------------------------

# Runtime -------------------------------------------------------------------
NODE_ENV=development                 # development | test | production
APP_ENV=development                  # development | test | staging | production
LOG_LEVEL=debug                      # debug | info | warn | error | fatal

# Web -----------------------------------------------------------------------
WEB_PORT=3000
WEB_BASE_URL=http://localhost:3000

# API -----------------------------------------------------------------------
API_PORT=3001
API_BASE_URL=http://localhost:3001

# Database ------------------------------------------------------------------
# DATABASE_URL is the least-privileged application role. It is NOT a superuser
# and does NOT have BYPASSRLS, which is what makes row-level security a real
# second layer rather than decoration.
DATABASE_URL=postgresql://sentinel_app:sentinel_app_local@localhost:5432/sentinel?schema=public
# DIRECT_DATABASE_URL owns the schema and is used only by `prisma migrate`.
DIRECT_DATABASE_URL=postgresql://sentinel:sentinel_local@localhost:5432/sentinel?schema=public

# Redis ---------------------------------------------------------------------
REDIS_URL=redis://localhost:6379

# Object storage (MinIO locally, R2/S3 in production) -----------------------
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_REGION=us-east-1
STORAGE_ACCESS_KEY_ID=sentinel_local
STORAGE_SECRET_ACCESS_KEY=sentinel_local_secret
STORAGE_FORCE_PATH_STYLE=true
STORAGE_BUCKET_EVIDENCE=evidence
STORAGE_BUCKET_REPORTS=reports
STORAGE_BUCKET_UPLOADS=uploads
STORAGE_BUCKET_EXPORTS=exports

# Mail (Mailpit locally — nothing leaves the machine) -----------------------
MAIL_HOST=localhost
MAIL_PORT=1025
MAIL_FROM="Sentinel <no-reply@sentinel.local>"
```

- [ ] **Step 4: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.5.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: Integration tests
        run: pnpm test:integration

      - name: Build
        run: pnpm build
```

- [ ] **Step 5: Install and verify every command succeeds**

Run, and read the output rather than assuming:
```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all five exit 0. `pnpm test` reports "No test files found" and exits 0 — that is correct at this stage; there is nothing to test yet.

If `pnpm test` exits non-zero on an empty suite, add `passWithNoTests: true` to both projects in `vitest.workspace.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: pnpm + turborepo workspace with strict TypeScript and CI

Workspace root, shared tsconfig, ESLint flat config carrying the
lint-enforced security rules from coding-standards.md §6, Prettier,
Vitest unit/integration projects, .env.example, and a CI workflow
running install -> lint -> typecheck -> test -> integration -> build.

No product code yet. This exists so that every subsequent commit is
verified from the moment it lands.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `packages/config` — validated environment

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/env.ts`, `packages/config/src/load-env.ts`, `packages/config/src/index.ts`
- Create: `packages/config/tsconfig/base.json`, `packages/config/tsconfig/library.json`, `packages/config/tsconfig/nextjs.json`, `packages/config/tsconfig/nest.json`
- Test: `packages/config/src/env.spec.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1
- Produces:
  - `sharedEnvSchema`, `apiEnvSchema`, `webEnvSchema` — Zod object schemas
  - `loadEnv<T extends z.ZodTypeAny>(schema: T, source?: Record<string, string | undefined>): z.infer<T>` — throws `EnvValidationError` naming every bad variable
  - `class EnvValidationError extends Error` with `.variables: string[]`
  - Type exports `SharedEnv`, `ApiEnv`, `WebEnv`

- [ ] **Step 1: Write the failing test**

`packages/config/src/env.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, loadEnv } from './load-env.js';
import { apiEnvSchema, sharedEnvSchema } from './env.js';

const validShared = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  LOG_LEVEL: 'debug',
};

const validApi = {
  ...validShared,
  API_PORT: '3001',
  API_BASE_URL: 'http://localhost:3001',
  WEB_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/sentinel?schema=public',
  DIRECT_DATABASE_URL: 'postgresql://o:p@localhost:5432/sentinel?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'k',
  STORAGE_SECRET_ACCESS_KEY: 's',
  STORAGE_FORCE_PATH_STYLE: 'true',
  STORAGE_BUCKET_EVIDENCE: 'evidence',
  STORAGE_BUCKET_REPORTS: 'reports',
  STORAGE_BUCKET_UPLOADS: 'uploads',
  STORAGE_BUCKET_EXPORTS: 'exports',
  MAIL_HOST: 'localhost',
  MAIL_PORT: '1025',
  MAIL_FROM: 'Sentinel <no-reply@sentinel.local>',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv(apiEnvSchema, validApi);
    expect(env.API_PORT).toBe(3001);
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('names every missing variable in the error', () => {
    const { DATABASE_URL, REDIS_URL, ...incomplete } = validApi;
    expect(() => loadEnv(apiEnvSchema, incomplete)).toThrow(EnvValidationError);
    try {
      loadEnv(apiEnvSchema, incomplete);
    } catch (error) {
      const err = error as EnvValidationError;
      expect(err.variables).toContain('DATABASE_URL');
      expect(err.variables).toContain('REDIS_URL');
      expect(err.message).toContain('DATABASE_URL');
    }
  });

  it('rejects a malformed URL and names the variable', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApi, API_BASE_URL: 'not-a-url' })).toThrow(
      /API_BASE_URL/,
    );
  });

  it('rejects an APP_ENV outside the allowed set', () => {
    expect(() => loadEnv(sharedEnvSchema, { ...validShared, APP_ENV: 'prod' })).toThrow(/APP_ENV/);
  });

  it('distinguishes APP_ENV from NODE_ENV', () => {
    const env = loadEnv(sharedEnvSchema, {
      ...validShared,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.APP_ENV).toBe('staging');
  });

  it('never includes a variable value in the error message', () => {
    try {
      loadEnv(apiEnvSchema, { ...validApi, DATABASE_URL: 'postgresql://user:hunter2@bad' });
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm vitest run --project unit packages/config
```
Expected: FAIL — `Cannot find module './load-env.js'`.

- [ ] **Step 3: Write the implementation**

`packages/config/package.json`:
```json
{
  "name": "@sentinel/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./tsconfig/*": "./tsconfig/*"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": { "zod": "^3.24.0" },
  "devDependencies": { "typescript": "^5.7.0" }
}
```

`packages/config/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`packages/config/src/env.ts`:
```ts
import { z } from 'zod';

/** Coerces the string "true"/"false" that every env var actually is into a boolean. */
const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65_535);

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // APP_ENV is deliberately separate from NODE_ENV: staging and production both
  // run with NODE_ENV=production but differ in ways that matter — feature flag
  // defaults, log verbosity, and whether the deny list covers our own hosts.
  // See .claude/operations/environments.md §3.
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export const apiEnvSchema = sharedEnvSchema.extend({
  API_PORT: port,
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1).startsWith('postgresql://'),
  DIRECT_DATABASE_URL: z.string().min(1).startsWith('postgresql://'),

  REDIS_URL: z.string().min(1).startsWith('redis://'),

  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromString,
  STORAGE_BUCKET_EVIDENCE: z.string().min(1),
  STORAGE_BUCKET_REPORTS: z.string().min(1),
  STORAGE_BUCKET_UPLOADS: z.string().min(1),
  STORAGE_BUCKET_EXPORTS: z.string().min(1),

  MAIL_HOST: z.string().min(1),
  MAIL_PORT: port,
  MAIL_FROM: z.string().min(1),
});

export const webEnvSchema = sharedEnvSchema.extend({
  WEB_PORT: port,
  WEB_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
```

`packages/config/src/load-env.ts`:
```ts
import type { z } from 'zod';

/**
 * Thrown at boot when configuration is missing or malformed.
 *
 * The message names the offending variables and NEVER their values — an env
 * validation error is one of the easiest places to accidentally log a
 * connection string containing a password.
 */
export class EnvValidationError extends Error {
  readonly variables: string[];

  constructor(variables: string[], detail: string) {
    super(`Invalid environment configuration.\n${detail}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/**
 * Parses and validates configuration. Call once, at boot. A service must never
 * run half-configured and fail confusingly later.
 */
export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data as z.infer<TSchema>;

  const issues = result.error.issues;
  const variables = [...new Set(issues.map((issue) => String(issue.path[0] ?? '(root)')))].sort();
  // Report the variable name and the rule it broke — never the value it held.
  const detail = issues
    .map((issue) => `  ${String(issue.path[0] ?? '(root)')}: ${issue.message}`)
    .join('\n');

  throw new EnvValidationError(variables, detail);
}
```

`packages/config/src/index.ts`:
```ts
export { apiEnvSchema, sharedEnvSchema, webEnvSchema } from './env.js';
export type { ApiEnv, SharedEnv, WebEnv } from './env.js';
export { EnvValidationError, loadEnv } from './load-env.js';
```

`packages/config/tsconfig/library.json` (the preset other packages extend):
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"]
}
```

Create `tsconfig/base.json` as a copy of the root `tsconfig.base.json` compilerOptions, `tsconfig/nextjs.json` adding `"jsx": "preserve"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"module": "esnext"`, `"moduleResolution": "bundler"`, `"noEmit": true`, and `tsconfig/nest.json` adding `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`.

- [ ] **Step 4: Run the test and verify it passes**

```bash
pnpm vitest run --project unit packages/config
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the whole workspace still passes**

```bash
pnpm lint && pnpm typecheck && pnpm build
```
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(config): Zod-validated environment with boot-time failure

packages/config is the only module permitted to read process.env, enforced
by an ESLint rule. loadEnv() throws naming every offending variable and
never its value, so a malformed connection string cannot leak a password
through a startup error.

APP_ENV is modelled separately from NODE_ENV because staging and production
both run NODE_ENV=production and differ in ways that matter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `packages/observability` — redacting structured logger

**Files:**
- Create: `packages/observability/package.json`, `packages/observability/tsconfig.json`, `packages/observability/src/redaction.ts`, `packages/observability/src/context.ts`, `packages/observability/src/logger.ts`, `packages/observability/src/index.ts`
- Test: `packages/observability/src/redaction.spec.ts`, `packages/observability/src/logger.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/config` (`SharedEnv`)
- Produces:
  - `redact(value: unknown): unknown` — deep, structural
  - `REDACTED = '[redacted]'`
  - `runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T`
  - `getRequestContext(): RequestContext | undefined`
  - `interface RequestContext { requestId: string; traceId?: string; organizationId?: string; userId?: string }`
  - `createLogger(options: { service: string; level: string; pretty: boolean; silent?: boolean }): Logger`
  - `type Logger` (Pino's)

- [ ] **Step 1: Write the failing tests**

`packages/observability/src/redaction.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from './redaction.js';

describe('redact', () => {
  it('redacts by key name at the top level', () => {
    expect(redact({ password: 'hunter2', email: 'a@b.c' })).toEqual({
      password: REDACTED,
      email: 'a@b.c',
    });
  });

  it('redacts by key name at any depth', () => {
    expect(redact({ user: { credential: { passwordHash: 'x' }, name: 'Marcus' } })).toEqual({
      user: { credential: { passwordHash: REDACTED }, name: 'Marcus' },
    });
  });

  it('matches key names case-insensitively and as substrings', () => {
    const out = redact({ Authorization: 'Bearer x', apiKey: 'k', X_CSRF_TOKEN: 't' }) as Record<
      string,
      unknown
    >;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.X_CSRF_TOKEN).toBe(REDACTED);
  });

  it('redacts inside arrays', () => {
    expect(redact([{ token: 'a' }, { token: 'b' }])).toEqual([
      { token: REDACTED },
      { token: REDACTED },
    ]);
  });

  it('applies the value-shape backstop to a bearer token under an innocent key', () => {
    const out = redact({ note: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' }) as Record<
      string,
      unknown
    >;
    expect(out.note).toBe(REDACTED);
  });

  it('applies the value-shape backstop to a postgres URL containing a password', () => {
    const out = redact({ dsn: 'postgresql://user:hunter2@host:5432/db' }) as Record<string, unknown>;
    expect(out.dsn).toBe(REDACTED);
  });

  it('leaves ordinary values alone', () => {
    const input = { scanId: 'scn_01J', count: 42, ok: true, at: null };
    expect(redact(input)).toEqual(input);
  });

  it('does not loop forever on a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => redact(circular)).not.toThrow();
  });

  it('preserves Error name and message but drops the stack', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(out.stack).toBeUndefined();
  });
});
```

`packages/observability/src/logger.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from './logger.js';
import { runWithRequestContext } from './context.js';
import { REDACTED } from './redaction.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({ service: 'api', level: 'debug', pretty: false, stream });
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits structured JSON carrying the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info({ scanId: 'scn_01J' }, 'Scan created');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'api', msg: 'Scan created', scanId: 'scn_01J' });
  });

  it('injects the ambient request context into every line', () => {
    const { logger, lines } = captureLogger();
    runWithRequestContext(
      { requestId: 'req_01J', organizationId: 'org_01J', userId: 'usr_01J' },
      () => logger.info('hello'),
    );
    expect(lines[0]).toMatchObject({
      requestId: 'req_01J',
      organizationId: 'org_01J',
      userId: 'usr_01J',
    });
  });

  it('redacts secrets in the logged object', () => {
    const { logger, lines } = captureLogger();
    logger.info({ headers: { authorization: 'Bearer abc' } }, 'inbound');
    expect((lines[0] as { headers: { authorization: string } }).headers.authorization).toBe(
      REDACTED,
    );
  });

  it('omits context keys entirely when there is no ambient context', () => {
    const { logger, lines } = captureLogger();
    logger.info('no context');
    expect(lines[0]).not.toHaveProperty('requestId');
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
pnpm vitest run --project unit packages/observability
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`packages/observability/package.json`:
```json
{
  "name": "@sentinel/observability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": { "pino": "^9.5.0", "pino-pretty": "^13.0.0" },
  "devDependencies": { "@sentinel/config": "workspace:*", "typescript": "^5.7.0" }
}
```

`packages/observability/src/redaction.ts`:
```ts
export const REDACTED = '[redacted]';

/**
 * Key fragments that mark a value as secret. Matched case-insensitively as a
 * substring, so `mfaSecret`, `X_CSRF_TOKEN`, and `stripeWebhookSecret` are all
 * caught without enumerating every spelling.
 *
 * Source list: .claude/operations/monitoring.md §2.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'private_key',
  'sessionid',
  'session_id',
  'mfasecret',
] as const;

/**
 * Value-shape backstop. Redaction is structural first — these patterns exist
 * only to catch a secret that arrived under an innocent key name, which is the
 * case a key denylist alone cannot see.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, // bearer tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWTs
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i, // any URL with inline credentials
  /\b(?:sk|rk|whsec)_[A-Za-z0-9]{16,}/, // Stripe-style keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM material
];

function keyIsSecret(key: string): boolean {
  const normalised = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment.replaceAll('_', '')));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

const MAX_DEPTH = 12;

/**
 * Deep, structural redaction. Walks the object graph and redacts by key name,
 * with a value-shape backstop.
 *
 * This is deliberately NOT a regex over the final serialised string: by the
 * time a log line is a string, the structure that tells you which field held a
 * credential is gone, and a string-level regex either misses secrets or mangles
 * legitimate content such as an evidence payload.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') return valueLooksSecret(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    // Stacks are dropped here; the logger attaches them separately at error
    // level, where they are wanted, rather than everywhere an Error is nested.
    return { name: value.name, message: value.message };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = keyIsSecret(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return output;
}
```

`packages/observability/src/context.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly organizationId?: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with an ambient request context. Every log line emitted inside —
 * including from awaited async work and from queue producers — carries the
 * correlation IDs without the caller threading them through by hand.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
```

`packages/observability/src/logger.ts`:
```ts
import type { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context.js';
import { redact } from './redaction.js';

export type { Logger };

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly pretty: boolean;
  readonly silent?: boolean;
  /** Test seam. Production and development both write to stdout. */
  readonly stream?: Writable;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.silent === true ? 'silent' : options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Every logged object passes through structural redaction before it is
    // serialised. This is the single choke point — there is no path to the log
    // that skips it.
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const context = getRequestContext();
        const redacted = redact(object) as Record<string, unknown>;
        return context === undefined ? redacted : { ...context, ...redacted };
      },
    },
  };

  if (options.stream !== undefined) return pino(base, options.stream);

  if (options.pretty) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    });
  }

  return pino(base);
}
```

`packages/observability/src/index.ts`:
```ts
export { createLogger } from './logger.js';
export type { CreateLoggerOptions, Logger } from './logger.js';
export { getRequestContext, runWithRequestContext } from './context.js';
export type { RequestContext } from './context.js';
export { REDACTED, redact } from './redaction.js';
```

`packages/observability/tsconfig.json`: same shape as `packages/config/tsconfig.json`.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm vitest run --project unit packages/observability
```
Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the workspace**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(observability): structured logger with structural redaction

Pino JSON logging with AsyncLocalStorage request context, so requestId,
traceId, organizationId and userId reach every line without being threaded
through call signatures.

Redaction walks the object graph and redacts by key name, with a value-shape
backstop for secrets arriving under innocent keys. It is deliberately not a
regex over the serialised string: at that point the structure identifying
which field held a credential is already gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

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

### Task 5: `packages/contracts` — errors, pagination, IDs, permission matrix

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/error-codes.ts`, `packages/contracts/src/error-envelope.ts`, `packages/contracts/src/pagination.ts`, `packages/contracts/src/ids.ts`, `packages/contracts/src/permissions.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/error-envelope.spec.ts`, `packages/contracts/src/permissions.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ERROR_CODES` — const object; `type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
  - `errorEnvelopeSchema`, `type ErrorEnvelope`
  - `fieldErrorSchema`, `type FieldError`
  - `paginationSchema`, `collectionEnvelopeSchema<T>(item: T)`
  - `PERMISSIONS` — readonly array of every permission string; `type Permission`
  - `SYSTEM_ROLES` — readonly array of the 7 role keys; `type SystemRole`
  - `ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]>`
  - `PROJECT_SCOPED_PERMISSIONS: readonly Permission[]` — the `P` cells for `GUEST`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/permissions.spec.ts` — this is the test [`product/permissions.md`](../../../.claude/product/permissions.md) explicitly demands ("this table and that file must agree, and a test asserts it"). It parses the markdown table so the two cannot drift:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PROJECT_SCOPED_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRole,
} from './permissions.js';

const docPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.claude/product/permissions.md',
);

interface DocRow {
  permission: string;
  cells: Record<string, string>;
}

/** Parses the single permission matrix table out of permissions.md. */
function parseMatrix(markdown: string): { roles: string[]; rows: DocRow[] } {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex(
    (line) => line.startsWith('| Permission |') && line.includes('OWNER'),
  );
  if (headerIndex === -1) throw new Error('Permission matrix header not found in permissions.md');

  const cellsOf = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

  const roles = cellsOf(lines[headerIndex] ?? '').slice(1);
  const rows: DocRow[] = [];

  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) break;
    const cells = cellsOf(line);
    const permission = (cells[0] ?? '').replaceAll('`', '').trim();
    if (permission === '') continue;
    rows.push({
      permission,
      cells: Object.fromEntries(
        roles.map((role, index) => [role, (cells[index + 1] ?? '').replaceAll('*', '').trim()]),
      ),
    });
  }
  return { roles, rows };
}

const { roles: docRoles, rows: docRows } = parseMatrix(readFileSync(docPath, 'utf8'));

describe('permissions.ts agrees with product/permissions.md', () => {
  it('declares the same seven system roles, in the same order', () => {
    expect([...SYSTEM_ROLES]).toEqual(docRoles);
  });

  it('declares exactly the permissions the document lists', () => {
    expect([...PERMISSIONS].sort()).toEqual(docRows.map((row) => row.permission).sort());
  });

  it('grants exactly what each row of the document grants', () => {
    for (const row of docRows) {
      for (const role of docRoles) {
        const cell = row.cells[role];
        const granted = ROLE_PERMISSIONS[role as SystemRole].includes(row.permission as Permission);
        // 'Y' granted, '-' not granted, 'P' granted but additionally gated on
        // an explicit project grant — which is still a grant in the matrix.
        expect(granted, `${role} / ${row.permission} (doc cell "${cell ?? ''}")`).toBe(
          cell === 'Y' || cell === 'P',
        );
      }
    }
  });

  it('marks every P cell as project-scoped', () => {
    const docProjectScoped = docRows
      .filter((row) => Object.values(row.cells).includes('P'))
      .map((row) => row.permission)
      .sort();
    expect([...PROJECT_SCOPED_PERMISSIONS].sort()).toEqual(docProjectScoped);
  });
});

describe('invariants from permissions.md', () => {
  it('gives OWNER every permission', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('withholds billing.manage from ADMIN — only OWNER changes what it costs', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('billing.manage');
  });

  it('gives AUDITOR audit.read but not evidence.read', () => {
    expect(ROLE_PERMISSIONS.AUDITOR).toContain('audit.read');
    expect(ROLE_PERMISSIONS.AUDITOR).not.toContain('evidence.read');
  });

  it('withholds finding.accept_risk and scan.create_aggressive from MEMBER', () => {
    expect(ROLE_PERMISSIONS.MEMBER).not.toContain('finding.accept_risk');
    expect(ROLE_PERMISSIONS.MEMBER).not.toContain('scan.create_aggressive');
  });
});
```

`packages/contracts/src/error-envelope.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { errorEnvelopeSchema } from './error-envelope.js';
import { collectionEnvelopeSchema } from './pagination.js';
import { z } from 'zod';

describe('errorEnvelopeSchema', () => {
  it('accepts a minimal envelope', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something failed.', requestId: 'req_1' },
    });
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
  });

  it('accepts a validation envelope with per-field errors', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request contains invalid fields.',
        requestId: 'req_1',
        details: {
          fields: [{ path: 'targets[0]', code: 'invalid_host', message: 'Enter a valid hostname.' }],
        },
      },
    });
    expect(parsed.error.details).toBeDefined();
  });

  it('rejects an unknown error code, so codes cannot be invented ad hoc', () => {
    expect(() =>
      errorEnvelopeSchema.parse({
        error: { code: 'MADE_UP', message: 'x', requestId: 'req_1' },
      }),
    ).toThrow();
  });

  it('rejects an envelope without a requestId', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'x' } }),
    ).toThrow();
  });
});

describe('collectionEnvelopeSchema', () => {
  it('wraps items with pagination and meta', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      data: [{ id: 'fnd_1' }],
      pagination: { nextCursor: 'abc', hasMore: true },
      meta: { total: 1284 },
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.pagination.hasMore).toBe(true);
  });

  it('allows a null cursor on the last page', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({ data: [], pagination: { nextCursor: null, hasMore: false } });
    expect(parsed.pagination.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
pnpm vitest run --project unit packages/contracts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the contracts**

`packages/contracts/src/error-codes.ts` — the complete union from [`api/errors.md`](../../../.claude/api/errors.md) §3:
```ts
export const ERROR_CODES = {
  // Auth
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',

  // Access
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',

  // Domain — security testing
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  ASSET_NOT_VERIFIED: 'ASSET_NOT_VERIFIED',
  ASSET_VERIFICATION_EXPIRED: 'ASSET_VERIFICATION_EXPIRED',
  TARGET_DENIED_BY_POLICY: 'TARGET_DENIED_BY_POLICY',
  PROFILE_NOT_PERMITTED: 'PROFILE_NOT_PERMITTED',
  ENGINE_NOT_AVAILABLE: 'ENGINE_NOT_AVAILABLE',
  SCAN_ALREADY_RUNNING: 'SCAN_ALREADY_RUNNING',
  SCAN_NOT_CANCELLABLE: 'SCAN_NOT_CANCELLABLE',

  // Entitlement
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  // Rate limit
  RATE_LIMITED: 'RATE_LIMITED',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];
```

`packages/contracts/src/error-envelope.ts`:
```ts
import { z } from 'zod';
import { ERROR_CODE_VALUES } from './error-codes.js';

/**
 * A per-field validation error. `path` uses dotted/bracketed notation matching
 * the request body (`targets[0]`, `scope.rules[2].value`) so a client can map
 * the error onto its input without guessing. See api/errors.md §2.
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODE_VALUES),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
    documentation: z.string().url().optional(),
  }),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
```

`packages/contracts/src/pagination.ts`:
```ts
import { z } from 'zod';

export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const collectionMetaSchema = z.object({ total: z.number().int().nonnegative() });

/** Every list endpoint returns this shape. See api/conventions.md §4. */
export function collectionEnvelopeSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return z.object({
    data: z.array(item),
    pagination: paginationSchema,
    meta: collectionMetaSchema.optional(),
  });
}

export type Pagination = z.infer<typeof paginationSchema>;
```

`packages/contracts/src/ids.ts`:
```ts
import { z } from 'zod';

/**
 * Client-facing ID validation. Clients must not parse IDs (api/conventions.md
 * §1); this schema exists so the API can reject a malformed one at the boundary
 * rather than passing it to the database.
 */
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function idSchema(prefix: string) {
  return z
    .string()
    .refine(
      (value) => value.startsWith(`${prefix}_`) && ID_BODY.test(value.slice(prefix.length + 1)),
      { message: `Expected an identifier beginning with "${prefix}_".` },
    );
}

export const organizationIdSchema = idSchema('org');
export const userIdSchema = idSchema('usr');
export const membershipIdSchema = idSchema('mbr');
export const invitationIdSchema = idSchema('inv');
```

`packages/contracts/src/permissions.ts` — the machine-readable source of truth `permissions.md` names. Transcribe **every** row of that table:
```ts
export const SYSTEM_ROLES = [
  'OWNER',
  'ADMIN',
  'SECURITY_LEAD',
  'MEMBER',
  'VIEWER',
  'AUDITOR',
  'GUEST',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const PERMISSIONS = [
  'organization.read',
  'organization.update',
  'organization.delete',
  'organization.manage_members',
  'organization.manage_roles',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'asset.read',
  'asset.create',
  'asset.update',
  'asset.delete',
  'asset.verify_ownership',
  'scope.read',
  'scope.update',
  'scan.read',
  'scan.create',
  'scan.cancel',
  'scan.create_aggressive',
  'finding.read',
  'finding.create',
  'finding.update',
  'finding.triage',
  'finding.accept_risk',
  'finding.delete',
  'evidence.read',
  'evidence.upload',
  'evidence.delete',
  'engagement.read',
  'engagement.create',
  'engagement.update',
  'engagement.delete',
  'report.read',
  'report.create',
  'report.download',
  'apikey.read',
  'apikey.create',
  'apikey.revoke',
  'webhook.read',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'integration.read',
  'integration.manage',
  'notification.manage',
  'audit.read',
  'billing.read',
  'billing.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions marked `P` in product/permissions.md: granted to GUEST only for
 * projects explicitly shared with them. The role grant is necessary but not
 * sufficient — the project grant is checked separately.
 */
export const PROJECT_SCOPED_PERMISSIONS = [
  'project.read',
  'asset.read',
  'scope.read',
  'scan.read',
  'finding.read',
  'evidence.read',
  'engagement.read',
  'report.read',
  'report.download',
] as const satisfies readonly Permission[];

/**
 * The canonical role -> permission mapping. product/permissions.md is the
 * human-readable rendering of this object, and permissions.spec.ts parses that
 * document and asserts the two agree cell by cell.
 */
export const ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  OWNER: [...PERMISSIONS],

  ADMIN: [
    'organization.read', 'organization.update', 'organization.manage_members',
    'organization.manage_roles',
    'project.read', 'project.create', 'project.update', 'project.delete',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'finding.accept_risk', 'finding.delete',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update', 'engagement.delete',
    'report.read', 'report.create', 'report.download',
    'apikey.read', 'apikey.create', 'apikey.revoke',
    'webhook.read', 'webhook.create', 'webhook.update', 'webhook.delete',
    'integration.read', 'integration.manage',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  SECURITY_LEAD: [
    'organization.read',
    'project.read', 'project.create', 'project.update',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage', 'finding.accept_risk',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
  ],

  MEMBER: [
    'organization.read',
    'project.read', 'project.create',
    'asset.read', 'asset.create', 'asset.update',
    'scope.read',
    'scan.read', 'scan.create', 'scan.cancel',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'evidence.read', 'evidence.upload',
    'engagement.read', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  VIEWER: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  // An auditor proves that testing happened and that findings were remediated.
  // They deliberately lack evidence.read: evidence routinely contains customer
  // secrets and PII, and a compliance reviewer rarely needs the vulnerability
  // detail itself. See product/permissions.md, "deliberate oddities".
  AUDITOR: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'engagement.read',
    'report.read', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  // Every GUEST grant below is additionally gated on an explicit project grant.
  // A guest with no grants sees nothing.
  GUEST: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'notification.manage',
  ],
};
```

`packages/contracts/src/index.ts`:
```ts
export { ERROR_CODES, ERROR_CODE_VALUES } from './error-codes.js';
export type { ErrorCode } from './error-codes.js';
export { errorEnvelopeSchema, fieldErrorSchema } from './error-envelope.js';
export type { ErrorEnvelope, FieldError } from './error-envelope.js';
export { collectionEnvelopeSchema, collectionMetaSchema, paginationSchema } from './pagination.js';
export type { Pagination } from './pagination.js';
export {
  idSchema,
  invitationIdSchema,
  membershipIdSchema,
  organizationIdSchema,
  userIdSchema,
} from './ids.js';
export {
  PERMISSIONS,
  PROJECT_SCOPED_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from './permissions.js';
export type { Permission, SystemRole } from './permissions.js';
```

`packages/contracts/package.json` and `tsconfig.json` follow the same shape as `packages/config`, with `zod` as the only dependency.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm vitest run --project unit packages/contracts
```
Expected: PASS, 12 tests.

If the matrix test fails, **the document is authoritative** — fix `permissions.ts` to match `permissions.md`, not the reverse. Changing the matrix is a product decision, not a typo fix.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(contracts): error envelope, pagination, IDs, and the permission matrix

packages/contracts is the spine: shapes defined once as Zod schemas and
imported by web, api, and workers, so a change that breaks a consumer breaks
the typecheck.

permissions.ts is the machine-readable source of truth that
product/permissions.md names. Its test parses that markdown table and
asserts agreement cell by cell, in both directions, so the two cannot drift.
The document is authoritative when they disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

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

### Task 8: `packages/storage` — S3-compatible adapter

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/tsconfig.json`, `packages/storage/src/adapter.ts`, `packages/storage/src/keys.ts`, `packages/storage/src/s3-adapter.ts`, `packages/storage/src/index.ts`
- Modify: `.claude/development/folder-structure.md`, `.claude/architecture/overview.md`
- Test: `packages/storage/src/keys.spec.ts`, `packages/storage/src/s3-adapter.integration.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface StorageAdapter` — `put`, `get`, `head`, `delete`, `presignGet`, `presignPut`, `list`
  - `interface StoredObjectMetadata { size: number; contentType?: string; etag: string; sha256?: string; lastModified?: Date }`
  - `createS3StorageAdapter(options: S3StorageOptions): StorageAdapter`
  - `tenantPrefix(organizationId: string): string`
  - `evidenceKeyForFinding({ organizationId, findingId, extension, originalFilename? }): string`
  - `evidenceKeyForScan({ organizationId, scanId, extension }): string`
  - `reportKey({ organizationId, reportId, extension }): string`

- [ ] **Step 1: Write the failing key test**

`packages/storage/src/keys.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { evidenceKeyForFinding, evidenceKeyForScan, reportKey, tenantPrefix } from './keys.js';

describe('storage keys', () => {
  it('always begins with the organisation prefix', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key.startsWith('org/org_01J/')).toBe(true);
  });

  it('places a finding artifact under its finding', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key).toMatch(/^org\/org_01J\/finding\/fnd_01J\/[0-9a-f-]{36}\.png$/);
  });

  it('places a scan artifact under its scan', () => {
    const key = evidenceKeyForScan({
      organizationId: 'org_01J',
      scanId: 'scn_01J',
      extension: 'json',
    });
    expect(key).toMatch(/^org\/org_01J\/scan\/scn_01J\/[0-9a-f-]{36}\.json$/);
  });

  it('builds report keys under the organisation', () => {
    expect(reportKey({ organizationId: 'org_01J', reportId: 'rpt_01J', extension: 'pdf' })).toMatch(
      /^org\/org_01J\/rpt_01J\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it('never reuses the original filename', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
      originalFilename: '../../etc/passwd',
    });
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('..');
  });

  it('rejects an empty organisation id rather than building a prefix-less key', () => {
    expect(() => tenantPrefix('')).toThrow(/organisation/i);
  });

  it('rejects an extension containing a path separator', () => {
    expect(() =>
      evidenceKeyForFinding({ organizationId: 'org_01J', findingId: 'fnd_01J', extension: '../x' }),
    ).toThrow();
  });

  it('produces a distinct key each call, so keys are not enumerable', () => {
    const args = { organizationId: 'org_01J', findingId: 'fnd_01J', extension: 'png' } as const;
    expect(evidenceKeyForFinding(args)).not.toBe(evidenceKeyForFinding(args));
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm vitest run --project unit packages/storage
```
Expected: FAIL — `Cannot find module './keys.js'`.

- [ ] **Step 3: Implement keys**

`packages/storage/src/keys.ts`:
```ts
import { randomUUID } from 'node:crypto';

/**
 * The organisation prefix is what makes a leaked or guessed key harmless: it
 * cannot address another tenant's object, and prefix-scoped IAM policies become
 * possible. This throws rather than returning a prefix-less key, so there is no
 * path to building one by accident. See architecture/storage.md §2.
 */
export function tenantPrefix(organizationId: string): string {
  if (organizationId.trim() === '') {
    throw new Error('Cannot build a storage key without an organisation id.');
  }
  return `org/${organizationId}`;
}

function safeExtension(extension: string): string {
  if (!/^[a-z0-9]{1,10}$/i.test(extension)) {
    throw new Error(`Unsafe storage key extension: ${extension}`);
  }
  return extension.toLowerCase();
}

/**
 * Original filenames are NEVER used in keys — they are stored as object
 * metadata for display only. A user-supplied filename in a key is a path
 * traversal waiting to happen, and it makes keys guessable.
 */
export function evidenceKeyForFinding(options: {
  organizationId: string;
  findingId: string;
  extension: string;
  originalFilename?: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/finding/${options.findingId}/${randomUUID()}.${safeExtension(options.extension)}`;
}

export function evidenceKeyForScan(options: {
  organizationId: string;
  scanId: string;
  extension: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/scan/${options.scanId}/${randomUUID()}.${safeExtension(options.extension)}`;
}

export function reportKey(options: {
  organizationId: string;
  reportId: string;
  extension: string;
}): string {
  const prefix = tenantPrefix(options.organizationId);
  return `${prefix}/${options.reportId}/${randomUUID()}.${safeExtension(options.extension)}`;
}
```

- [ ] **Step 4: Implement the adapter interface and the S3 implementation**

`packages/storage/src/adapter.ts`:
```ts
import type { Readable } from 'node:stream';

export interface StoredObjectMetadata {
  readonly size: number;
  readonly contentType?: string;
  readonly etag: string;
  readonly sha256?: string;
  readonly lastModified?: Date;
}

export interface PutOptions {
  readonly contentType?: string;
  /** Stored as object metadata for display. Never used to build the key. */
  readonly originalFilename?: string;
}

export interface PresignGetOptions {
  readonly ttlSeconds: number;
  readonly downloadFilename?: string;
}

export interface KeyPage {
  readonly keys: readonly string[];
  readonly nextCursor: string | null;
}

/**
 * The single interface application code sees. No S3 SDK type crosses this
 * boundary, so the provider is a configuration choice rather than a code
 * dependency. See architecture/storage.md §4.
 */
export interface StorageAdapter {
  put(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    options?: PutOptions,
  ): Promise<{ etag: string; size: number; sha256: string }>;
  get(bucket: string, key: string): Promise<Readable>;
  head(bucket: string, key: string): Promise<StoredObjectMetadata | null>;
  delete(bucket: string, key: string): Promise<void>;
  presignGet(bucket: string, key: string, options: PresignGetOptions): Promise<string>;
  presignPut(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  list(bucket: string, prefix: string, cursor?: string): Promise<KeyPage>;
}
```

`packages/storage/src/s3-adapter.ts`:
```ts
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  KeyPage,
  PresignGetOptions,
  PutOptions,
  StorageAdapter,
  StoredObjectMetadata,
} from './adapter.js';

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** Presigned URLs are short-lived and single-purpose. storage.md §3. */
const MAX_PRESIGN_TTL_SECONDS = 300;

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export function createS3StorageAdapter(options: S3StorageOptions): StorageAdapter {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    async put(bucket, key, body, putOptions: PutOptions = {}) {
      const buffer = await toBuffer(body);
      // Computed at upload and stored, so chain of custody can be verified on
      // download for evidence where it matters. storage.md §5.
      const sha256 = createHash('sha256').update(buffer).digest('hex');

      const response = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: putOptions.contentType,
          Metadata: {
            sha256,
            ...(putOptions.originalFilename === undefined
              ? {}
              : { 'original-filename': encodeURIComponent(putOptions.originalFilename) }),
          },
        }),
      );

      return { etag: response.ETag ?? '', size: buffer.byteLength, sha256 };
    },

    async get(bucket, key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.Body === undefined) throw new Error(`Object has no body: ${bucket}/${key}`);
      return response.Body as Readable;
    },

    async head(bucket, key): Promise<StoredObjectMetadata | null> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: response.ContentLength ?? 0,
          contentType: response.ContentType,
          etag: response.ETag ?? '',
          sha256: response.Metadata?.sha256,
          lastModified: response.LastModified,
        };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        // Absent is null. Anything else — notably 403 — is rethrown, because
        // swallowing it would report a permissions misconfiguration as
        // "missing", which is the hardest kind of bug to find.
        if (status === 404) return null;
        throw error;
      }
    },

    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async presignGet(bucket, key, presignOptions: PresignGetOptions) {
      const filename = (presignOptions.downloadFilename ?? 'download').replaceAll('"', '');
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          // Always attachment, never inline. Evidence rendered inline by a
          // browser is stored XSS against our own users.
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
        { expiresIn: Math.min(presignOptions.ttlSeconds, MAX_PRESIGN_TTL_SECONDS) },
      );
    },

    async presignPut(bucket, key, ttlSeconds) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: Math.min(ttlSeconds, MAX_PRESIGN_TTL_SECONDS),
      });
    },

    async list(bucket, prefix, cursor): Promise<KeyPage> {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: cursor,
          MaxKeys: 1000,
        }),
      );
      return {
        keys: (response.Contents ?? []).flatMap((item) =>
          item.Key === undefined ? [] : [item.Key],
        ),
        nextCursor: response.NextContinuationToken ?? null,
      };
    },
  };
}
```

- [ ] **Step 5: Write the MinIO integration test**

`packages/storage/src/s3-adapter.integration.spec.ts`:
```ts
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createS3StorageAdapter } from './s3-adapter.js';
import { evidenceKeyForFinding } from './keys.js';
import type { StorageAdapter } from './adapter.js';

const BUCKET = 'evidence';
const ACCESS_KEY = 'test_key';
const SECRET_KEY = 'test_secret_key';

let container: StartedTestContainer;
let storage: StorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withExposedPorts(9000)
    .start();

  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(9000))}`;
  const credentials = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

  await new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials }).send(
    new CreateBucketCommand({ Bucket: BUCKET }),
  );

  storage = createS3StorageAdapter({
    endpoint,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

const key = (): string =>
  evidenceKeyForFinding({ organizationId: 'org_01J', findingId: 'fnd_01J', extension: 'txt' });

describe('S3 storage adapter against MinIO', () => {
  it('round-trips an object and reports its SHA-256', async () => {
    const objectKey = key();
    const body = Buffer.from('HTTP/1.1 200 OK\r\n\r\nhello');
    const result = await storage.put(BUCKET, objectKey, body, { contentType: 'text/plain' });

    expect(result.size).toBe(body.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(BUCKET, objectKey)) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe(body.toString());
  });

  it('returns null from head for an absent object', async () => {
    expect(await storage.head(BUCKET, key())).toBeNull();
  });

  it('returns metadata including the stored hash', async () => {
    const objectKey = key();
    const { sha256 } = await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const metadata = await storage.head(BUCKET, objectKey);
    expect(metadata?.size).toBe(1);
    expect(metadata?.sha256).toBe(sha256);
  });

  it('deletes an object', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    await storage.delete(BUCKET, objectKey);
    expect(await storage.head(BUCKET, objectKey)).toBeNull();
  });

  it('issues a presigned GET that forces attachment disposition', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const url = await storage.presignGet(BUCKET, objectKey, {
      ttlSeconds: 300,
      downloadFilename: 'evidence.txt',
    });
    expect(url).toContain('X-Amz-Signature');
    expect(decodeURIComponent(url)).toContain('attachment; filename="evidence.txt"');
  });

  it('clamps a too-long presign TTL to five minutes', async () => {
    const objectKey = key();
    await storage.put(BUCKET, objectKey, Buffer.from('x'));
    const url = await storage.presignGet(BUCKET, objectKey, { ttlSeconds: 86_400 });
    expect(url).toContain('X-Amz-Expires=300');
  });

  it('lists by tenant prefix and does not cross organisations', async () => {
    await storage.put(
      BUCKET,
      evidenceKeyForFinding({ organizationId: 'org_A', findingId: 'fnd_1', extension: 'txt' }),
      Buffer.from('a'),
    );
    await storage.put(
      BUCKET,
      evidenceKeyForFinding({ organizationId: 'org_B', findingId: 'fnd_2', extension: 'txt' }),
      Buffer.from('b'),
    );
    const page = await storage.list(BUCKET, 'org/org_A/');
    expect(page.keys).toHaveLength(1);
    expect(page.keys[0]).toContain('org/org_A/');
  });
});
```

- [ ] **Step 6: Run both suites**

```bash
pnpm vitest run --project unit packages/storage
pnpm vitest run --project integration packages/storage
```
Expected: unit 8 pass; integration 7 pass.

- [ ] **Step 7: Correct the two documents this deviates from**

In `.claude/development/folder-structure.md`, add to the `packages/` tree block:
```
│   ├── storage/                 S3-compatible adapter, tenant-prefixed keys
```

In `.claude/architecture/overview.md` §3, add the matching line:
```
  storage/          S3-compatible adapter, tenant-prefixed key construction
```

And add one rule to `folder-structure.md` under **Rules**:

> **The storage adapter is a package, not API infrastructure.** Workers upload evidence from
> Phase 5 onward, and no app may import another app, so the adapter has to live where both
> can reach it.

- [ ] **Step 8: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(storage): S3-compatible adapter with non-optional tenant key prefixes

Implements the interface in architecture/storage.md §4, tested against MinIO
in Testcontainers rather than a mock — presign semantics and content-type
handling are precisely what a mock hides.

Key construction cannot produce a key without an organisation prefix: the
builder throws instead. Original filenames never appear in keys. Presigned
GETs always force attachment disposition and are clamped to five minutes,
because evidence rendered inline by a browser is stored XSS against our own
users. head() returns null only for a genuine 404 and rethrows a 403, so a
permissions misconfiguration cannot masquerade as a missing object.

Places the adapter in packages/storage rather than apps/api/src/infrastructure
as folder-structure.md had it: workers need it from Phase 5 and no app may
import another app. Both documents are corrected in this same commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `apps/api` — bootstrap, request ID, security headers, error envelope, health

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/common/errors/domain-error.ts`
- Create: `apps/api/src/common/filters/all-exceptions.filter.ts`
- Create: `apps/api/src/common/middleware/request-id.middleware.ts`
- Create: `apps/api/src/common/middleware/security-headers.middleware.ts`
- Create: `apps/api/src/common/interceptors/logging.interceptor.ts`
- Create: `apps/api/src/common/pipes/zod-validation.pipe.ts`
- Create: `apps/api/src/infrastructure/{config,prisma,redis,storage}/*.module.ts`
- Create: `apps/api/src/modules/health/{health.controller.ts,health.service.ts,health.module.ts}`
- Test: `apps/api/src/common/filters/all-exceptions.filter.spec.ts`, `apps/api/src/app.integration.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/config` (`apiEnvSchema`, `loadEnv`), `@sentinel/observability` (`createLogger`, `runWithRequestContext`), `@sentinel/db`, `@sentinel/storage`, `@sentinel/contracts`
- Produces:
  - `class DomainError extends Error` — `(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>)`
  - `AllExceptionsFilter implements ExceptionFilter`
  - `ZodValidationPipe` — validates a body/query/param against a contract schema, throws `DomainError(VALIDATION_ERROR, …, 400)` carrying `details.fields: FieldError[]`
  - `GET /health/live`, `GET /health/ready`, `GET /health/detailed`

> **ESM note for the implementer.** Everything in this workspace is ESM. If NestJS's DI or CLI
> fights ESM in a way that costs more than about an hour, switch **only `apps/api`** to
> CommonJS (`"type": "commonjs"`, keeping `"module": "nodenext"`). Node 26's `require(esm)`
> bridges to the ESM packages, none of which use top-level await. Record whichever way it went
> in the commit body. Do not convert the packages.

- [ ] **Step 1: Write the failing error-filter unit test**

`apps/api/src/common/filters/all-exceptions.filter.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, errorEnvelopeSchema } from '@sentinel/contracts';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { DomainError } from '../errors/domain-error.js';

function invoke(exception: unknown): { status: number; body: unknown } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: 'req_01J', url: '/api/v1/x', method: 'GET' }),
    }),
  };
  new AllExceptionsFilter().catch(exception, host as never);
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] };
}

describe('AllExceptionsFilter', () => {
  it('maps a domain error to its own code and status', () => {
    const { status, body } = invoke(
      new DomainError(ERROR_CODES.SCOPE_VIOLATION, 'Target is not permitted.', 422, {
        target: 'admin.example.com',
      }),
    );
    expect(status).toBe(422);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('SCOPE_VIOLATION');
    expect(parsed.error.details).toEqual({ target: 'admin.example.com' });
  });

  it('maps a 404 HttpException to RESOURCE_NOT_FOUND', () => {
    const { status, body } = invoke(new HttpException('nope', HttpStatus.NOT_FOUND));
    expect(status).toBe(404);
    expect(errorEnvelopeSchema.parse(body).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('maps an unknown throwable to a generic INTERNAL_ERROR', () => {
    const { status, body } = invoke(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(status).toBe(500);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    // errors.md §5: no internal hosts, no database detail, no stack.
    expect(parsed.error.message).not.toContain('ECONNREFUSED');
    expect(parsed.error.message).not.toContain('10.0.0.5');
  });

  it('always includes the request id', () => {
    expect(errorEnvelopeSchema.parse(invoke(new Error('x')).body).error.requestId).toBe('req_01J');
  });

  it('never emits a stack property', () => {
    expect(JSON.stringify(invoke(new Error('x')).body)).not.toContain('stack');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm vitest run --project unit apps/api
```
Expected: FAIL — `Cannot find module './all-exceptions.filter.js'`.

- [ ] **Step 3: Implement the error layer**

`apps/api/src/common/errors/domain-error.ts`:
```ts
import type { ErrorCode } from '@sentinel/contracts';

/**
 * The base class for every error the domain raises.
 *
 * Domain code never throws a bare Error: a bare Error carries no code, so the
 * filter can only map it to INTERNAL_ERROR, and the client learns nothing it
 * can act on. A refusal that does not say how to succeed generates a support
 * ticket. See api/errors.md §4.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
```

`apps/api/src/common/filters/all-exceptions.filter.ts`:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@sentinel/contracts';
import { DomainError } from '../errors/domain-error.js';

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
}

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ERROR_CODES.VALIDATION_ERROR,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.PERMISSION_DENIED,
  404: ERROR_CODES.RESOURCE_NOT_FOUND,
  409: ERROR_CODES.DUPLICATE_RESOURCE,
  422: ERROR_CODES.INVALID_STATE_TRANSITION,
  429: ERROR_CODES.RATE_LIMITED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * One envelope for every error, without exception. api/errors.md §1.
 *
 * The final branch is the one that matters: an unrecognised throwable returns a
 * generic message and the request ID and nothing else. Stack traces, database
 * errors, constraint names, internal hosts, and service names never reach a
 * client — they go to the server log, which the request ID correlates to.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const requestId = http.getRequest<{ id?: string }>().id ?? 'req_unknown';
    const response = http.getResponse<ResponseLike>();

    if (exception instanceof DomainError) {
      const envelope: ErrorEnvelope = {
        error: {
          code: exception.code,
          message: exception.message,
          requestId,
          ...(exception.details === undefined ? {} : { details: exception.details }),
        },
      };
      response.status(exception.status).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const envelope: ErrorEnvelope = {
        error: {
          code: STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL_ERROR,
          message: exception.message,
          requestId,
        },
      };
      response.status(status).json(envelope);
      return;
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our side. Quote the request ID if you contact support.',
        requestId,
      },
    };
    response.status(500).json(envelope);
  }
}
```

- [ ] **Step 4: Run the unit test and verify it passes**

```bash
pnpm vitest run --project unit apps/api
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement middleware, the validation pipe, health, and bootstrap**

`request-id.middleware.ts` — reads or generates `x-request-id` (using `newId('req')`), attaches
it to the request object, echoes it on the response, and wraps `next()` in
`runWithRequestContext` so every log line inside the request correlates without being threaded
through call signatures.

`security-headers.middleware.ts` — sets **exactly** the table in
`security/transport-and-headers.md` §2, generates a per-request CSP nonce, and builds the §3
policy. `Content-Security-Policy-Report-Only` in development, `Content-Security-Policy`
otherwise, per `environments.md` §4:

```ts
import { randomBytes } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  constructor(private readonly enforceCsp: boolean) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    const nonce = randomBytes(16).toString('base64');
    response.locals.cspNonce = nonce;

    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // The API serves nothing cacheable; every response may contain tenant data.
    response.setHeader('Cache-Control', 'no-store');
    response.removeHeader('X-Powered-By');

    const policy = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
      'report-uri /api/v1/csp-report',
    ].join('; ');

    response.setHeader(
      this.enforceCsp ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      policy,
    );

    next();
  }
}
```

`zod-validation.pipe.ts` — validates against a contract schema and converts Zod issues into the
`FieldError[]` shape from `errors.md` §2, with dotted/bracketed paths. It has no consumer in
Phase 1 (health takes no input); it exists so Phase 2's first endpoint inherits it rather than
inventing its own, and its unit test drives it directly with a schema.

`health.service.ts` — `checkDependencies()` runs `SELECT 1` against Postgres, `PING` against
Redis, and a `head()` on a known-absent storage key (which must return `null`, not throw). It
reports each dependency individually so an operator sees *which* one is down, and returns 503
if any failed.

`health.controller.ts`:
```ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness checks the process and NOTHING else.
   *
   * A liveness probe that checks Postgres restarts every application instance
   * simultaneously during a database blip, turning a hiccup into a full
   * outage. monitoring.md §5.
   */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  ready(): Promise<ReadinessReport> {
    return this.health.checkDependencies();
  }

  @Public()
  @Get('detailed')
  detailed(): Promise<DetailedReport> {
    return this.health.detailed();
  }
}
```

`main.ts` — `loadEnv(apiEnvSchema)` first (so misconfiguration crashes before anything binds a
port), then URI versioning with global prefix `api` and default version `1`, the global
exception filter, the logging interceptor, and `listen(env.API_PORT)`.

- [ ] **Step 6: Write the API integration test**

`apps/api/src/app.integration.spec.ts`, using `supertest` against the real Nest app and the
live compose stack. Write each of these as a real assertion:

```ts
describe('API surface', () => {
  it('GET /health/live returns 200 and touches no dependency', async () => {
    await request(server).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready reports postgres, redis and storage individually', async () => {
    const response = await request(server).get('/health/ready').expect(200);
    expect(response.body.dependencies).toMatchObject({
      postgres: 'ok',
      redis: 'ok',
      storage: 'ok',
    });
  });

  it('echoes a supplied x-request-id', async () => {
    const response = await request(server)
      .get('/health/live')
      .set('x-request-id', 'req_supplied')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('req_supplied');
  });

  it('generates a request id when none is supplied', async () => {
    const response = await request(server).get('/health/live').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('sets every header in transport-and-headers.md §2', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    expect(headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  it('sets a nonce-based CSP with no unsafe-inline and no unsafe-eval', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    const csp =
      headers['content-security-policy'] ?? headers['content-security-policy-report-only'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('issues a different nonce on every request', async () => {
    const cspOf = async (): Promise<string> => {
      const { headers } = await request(server).get('/health/live');
      return (headers['content-security-policy'] ??
        headers['content-security-policy-report-only']) as string;
    };
    expect(await cspOf()).not.toBe(await cspOf());
  });

  it('returns the error envelope for an unmatched route', async () => {
    const response = await request(server).get('/api/v1/does-not-exist').expect(404);
    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(parsed.error.requestId).toMatch(/^req_/);
  });
});
```

- [ ] **Step 7: Run everything, verify, commit**

```bash
docker compose up -d
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(api): NestJS bootstrap with security headers, error envelope, and health

The cross-cutting pipeline from architecture/backend.md §3 with one module
behind it. Request IDs propagate into the logging context; security headers
match transport-and-headers.md §2 exactly; CSP is nonce-based with a fresh
nonce per request, no unsafe-inline and no unsafe-eval, report-only locally
and enforcing elsewhere.

The global filter produces the shared envelope for every error class. A 5xx
returns a generic message and the request ID and nothing else — no stack, no
database error, no internal host.

Liveness deliberately checks the process only: a liveness probe that checks
Postgres restarts every instance at once during a blip, turning a hiccup into
an outage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `apps/api` — Redis sliding-window rate limiting

**Files:**
- Create: `apps/api/src/common/guards/rate-limit.config.ts`, `apps/api/src/common/guards/rate-limit.guard.ts`, `apps/api/src/common/guards/sliding-window.ts`, `apps/api/src/common/decorators/rate-limit.decorator.ts`
- Test: `apps/api/src/common/guards/rate-limit.config.spec.ts`, `apps/api/src/common/guards/rate-limit.integration.spec.ts`

**Interfaces:**
- Consumes: the Redis client from Task 9's `RedisModule`; `DomainError` (Task 9)
- Produces:
  - `RATE_LIMIT_CLASSES` — the table from `abuse-prevention.md` §1 as configuration
  - `type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES`
  - `@RateLimit(className: RateLimitClass)`
  - `RateLimitGuard` — sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and throws `DomainError(RATE_LIMITED, …, 429)` with `Retry-After`

- [ ] **Step 1: Write the config and its unit test**

`rate-limit.config.ts` transcribes `abuse-prevention.md` §1 verbatim:
```ts
export interface Window {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitClassConfig {
  readonly perIp?: Window;
  readonly perPrincipal?: Window;
  readonly perOrganization?: Window;
  /**
   * What to do when Redis is unavailable.
   *
   * 'closed' on authentication endpoints: a Redis outage must not become a
   * window for credential stuffing. 'open' on read-only endpoints: an outage
   * should not lock every customer out of reading their own data.
   * See abuse-prevention.md §1.
   */
  readonly failMode: 'open' | 'closed';
}

export const RATE_LIMIT_CLASSES = {
  login: {
    perPrincipal: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 },
    failMode: 'closed',
  },
  registration: { perIp: { limit: 3, windowSeconds: 3600 }, failMode: 'closed' },
  passwordReset: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    perIp: { limit: 10, windowSeconds: 3600 },
    failMode: 'closed',
  },
  emailVerificationResend: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    failMode: 'closed',
  },
  invitations: { perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode: 'closed' },
  scanCreate: { perOrganization: { limit: 10, windowSeconds: 60 }, failMode: 'closed' },
  evidenceUpload: { perOrganization: { limit: 100, windowSeconds: 3600 }, failMode: 'closed' },
  reportGeneration: { perOrganization: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  generalSession: { perPrincipal: { limit: 1000, windowSeconds: 60 }, failMode: 'open' },
  generalApiKey: { perPrincipal: { limit: 600, windowSeconds: 60 }, failMode: 'open' },
} as const satisfies Record<string, RateLimitClassConfig>;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;
```

`rate-limit.config.spec.ts`:
```ts
describe('RATE_LIMIT_CLASSES', () => {
  it('declares at least one window for every class', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      const windows = [config.perIp, config.perPrincipal, config.perOrganization].filter(Boolean);
      expect(windows.length, name).toBeGreaterThan(0);
    }
  });

  it('uses positive limits and windows throughout', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      for (const window of [config.perIp, config.perPrincipal, config.perOrganization]) {
        if (window === undefined) continue;
        expect(window.limit, name).toBeGreaterThan(0);
        expect(window.windowSeconds, name).toBeGreaterThan(0);
      }
    }
  });

  it('fails closed on every authentication class', () => {
    for (const name of ['login', 'registration', 'passwordReset', 'emailVerificationResend'] as const) {
      expect(RATE_LIMIT_CLASSES[name].failMode, name).toBe('closed');
    }
  });

  it('fails open on the general read classes', () => {
    expect(RATE_LIMIT_CLASSES.generalSession.failMode).toBe('open');
    expect(RATE_LIMIT_CLASSES.generalApiKey.failMode).toBe('open');
  });
});
```

Only `generalSession`, `generalApiKey`, `login`, and `registration` are reachable in Phase 1;
the rest are configuration waiting for their endpoints. The test above asserts every class is
well-formed so a typo cannot lie dormant until Phase 10.

- [ ] **Step 2: Write the failing integration test**

`rate-limit.integration.spec.ts`, against a real Redis in Testcontainers:
```ts
describe('rate limiting', () => {
  it('allows requests up to the limit and returns 429 on the next one');
  it('returns the shared error envelope with code RATE_LIMITED on the 429');
  it('sets RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset on every response');
  it('sets Retry-After on the 429');
  it('counts per IP and per principal independently — exhausting one does not exhaust the other');
  it('lets the window slide: a request older than windowSeconds no longer counts');
  it('applies the per-class limit, not one global limit');

  // The two that are the point of this task.
  it('FAILS CLOSED on an authentication class when Redis is unavailable', async () => {
    await redisContainer.stop();
    await request(server).post('/api/v1/__test/login-class').expect(429);
  });

  it('FAILS OPEN on a read-only class when Redis is unavailable', async () => {
    await redisContainer.stop();
    await request(server).get('/api/v1/__test/general-class').expect(200);
  });
});
```

Getting those last two backwards is either a site-wide lockout during a Redis blip or an open
window for credential stuffing, which is why they are asserted rather than assumed. The
`__test` routes are registered only when `APP_ENV === 'test'`.

- [ ] **Step 3: Implement**

`sliding-window.ts` — one Redis sorted set per key
(`ratelimit:{class}:{scope}:{identifier}`), and a single `MULTI` performing
`ZREMRANGEBYSCORE` (drop entries older than the window), `ZCARD` (count what remains),
`ZADD` (record this request), and `EXPIRE` (bound memory). One round trip, atomic under
concurrency — a read-then-write would let two simultaneous requests both see room.

`rate-limit.guard.ts` — resolves the class from decorator metadata (defaulting to
`generalSession`), evaluates every configured scope, sets the headers from the tightest
remaining window, and on breach throws:
```ts
throw new DomainError(ERROR_CODES.RATE_LIMITED, 'Too many requests. Try again shortly.', 429, {
  retryAfterSeconds,
});
```
On a Redis error it consults `failMode` and either allows or throws — and logs at `warn` either
way, because a rate limiter that has silently stopped limiting is worth knowing about.

- [ ] **Step 4: Run, verify, commit**

```bash
pnpm test && pnpm test:integration
git add -A
git commit -m "$(cat <<'EOF'
feat(api): Redis sliding-window rate limiting, per IP and per principal

One atomic sorted-set window per limit class, with RateLimit-Limit,
RateLimit-Remaining and RateLimit-Reset on every response and Retry-After on
the 429. The whole window operation is a single MULTI: a read-then-write
would let two simultaneous requests both see room.

Fails CLOSED on authentication classes and OPEN on read-only ones when Redis
is unavailable, both asserted by stopping the container mid-test. A Redis
blip must not lock customers out of reading their own data, and it must not
become a credential-stuffing window either.

Limit classes transcribe abuse-prevention.md §1 in full. Classes whose
endpoints arrive in later phases are still asserted well-formed, so a typo
cannot lie dormant until Phase 10.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Route access assertion and OpenAPI generation

Two structural controls that are cheap now and expensive to retrofit.

**Files:**
- Create: `apps/api/src/common/decorators/access.decorator.ts`, `apps/api/src/common/access-assertion.ts`, `apps/api/src/openapi/generate.ts`, `apps/api/src/openapi/cli.ts`
- Create: `apps/api/openapi.json` (generated, committed)
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/src/common/access-assertion.spec.ts`, `apps/api/src/openapi/generate.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/contracts` (`Permission`)
- Produces:
  - `@Public()` — declares a route intentionally unauthenticated
  - `@RequirePermission(permission: Permission)` — declared in Phase 1, **enforced in Phase 2**
  - `ACCESS_METADATA_KEY`
  - `findRoutesWithoutAccessDeclaration(routes: RouteDescriptor[]): RouteDescriptor[]`
  - `assertEveryRouteDeclaresAccess(app: INestApplication): void`
  - `generateOpenApiDocument(app: INestApplication): OpenAPIObject`

- [ ] **Step 1: Write the failing assertion test**

`apps/api/src/common/access-assertion.spec.ts` tests the pure function, so it needs no Nest app:
```ts
import { describe, expect, it } from 'vitest';
import { findRoutesWithoutAccessDeclaration, type RouteDescriptor } from './access-assertion.js';

const route = (over: Partial<RouteDescriptor>): RouteDescriptor => ({
  controller: 'HealthController',
  handler: 'live',
  method: 'GET',
  path: '/health/live',
  access: undefined,
  ...over,
});

describe('findRoutesWithoutAccessDeclaration', () => {
  it('passes when every route declares its access', () => {
    expect(
      findRoutesWithoutAccessDeclaration([
        route({ access: { kind: 'public' } }),
        route({ handler: 'list', access: { kind: 'permission', permission: 'finding.read' } }),
      ]),
    ).toEqual([]);
  });

  it('reports a route with no declaration', () => {
    const offender = route({ controller: 'FindingsController', handler: 'destroy' });
    expect(findRoutesWithoutAccessDeclaration([offender])).toEqual([offender]);
  });

  it('lists every offender, not just the first — one boot should reveal all of them', () => {
    const offenders = [route({ handler: 'a' }), route({ handler: 'b' }), route({ handler: 'c' })];
    expect(findRoutesWithoutAccessDeclaration([...offenders, route({ access: { kind: 'public' } })]))
      .toHaveLength(3);
  });

  it('treats @Public as a declaration, not as an absence of one', () => {
    expect(findRoutesWithoutAccessDeclaration([route({ access: { kind: 'public' } })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails, then implement**

`access-assertion.ts` exposes the pure `findRoutesWithoutAccessDeclaration` plus
`assertEveryRouteDeclaresAccess`, which walks Nest's router explorer, builds `RouteDescriptor[]`
from the metadata both decorators set, and throws a single error naming every offender:

```
Startup refused: 3 route(s) declare no access requirement.

  DELETE /api/v1/findings/:id   FindingsController.destroy
  GET    /api/v1/findings       FindingsController.list
  POST   /api/v1/scans          ScansController.create

Every route must declare @Public() or @RequirePermission(...). Missing
authorization is a boot failure here rather than a production discovery.
See .claude/architecture/backend.md §3.
```

Wire it into `main.ts` immediately before `listen`. Add the docblock explaining why it exists
now rather than in Phase 2:

```ts
/**
 * A route without an explicit access declaration crashes startup.
 *
 * This lands in Phase 1, with one module, on purpose. Added in Phase 2 with
 * thirty routes already written, it would start life with a backlog of
 * offenders and get commented out on the first bad afternoon.
 */
```

- [ ] **Step 3: Implement OpenAPI generation**

Generate from the Zod contracts, serve at `/api/v1/openapi.json`, and write
`apps/api/openapi.json` via `pnpm --filter @sentinel/api openapi:generate`.

**Fallback if the Nest/Zod integration fights** (spec §5 flags this as medium likelihood):
generate the document with a standalone script from `packages/contracts` plus an explicit route
table, and still serve it and diff it. The CI diff is the part with value; how the document is
produced is not. Record which route was taken in the commit body.

- [ ] **Step 4: Assert the committed document matches the generated one**

```ts
it('the committed openapi.json matches what the code generates', async () => {
  const app = await bootstrapTestApp();
  const generated = generateOpenApiDocument(app);
  const committed = JSON.parse(
    readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
  ) as unknown;
  expect(generated).toEqual(committed);
});

it('documents every registered route', async () => {
  const app = await bootstrapTestApp();
  const document = generateOpenApiDocument(app);
  expect(Object.keys(document.paths ?? {})).toEqual(
    expect.arrayContaining(['/health/live', '/health/ready', '/health/detailed']),
  );
});
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(api): boot-time route access assertion and generated OpenAPI

A route declaring neither @Public nor @RequirePermission crashes startup,
with an error naming every offender rather than the first. Missing
authorization becomes a boot failure instead of a production discovery.

This lands in Phase 1 with one module on purpose: added in Phase 2 with
thirty routes already written, it would start with a backlog of offenders and
get switched off.

OpenAPI is generated from the Zod contracts, served at
/api/v1/openapi.json, and committed. A test asserts the committed document
matches what the code generates; CI diffs it in the next task.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `packages/ui` — design tokens and base primitives

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/tokens.css`, `packages/ui/src/cn.ts`, `packages/ui/src/index.ts`
- Create: `packages/ui/src/components/{button,input,label,field,card,alert,badge,skeleton}.tsx`
- Test: `packages/ui/src/tokens.spec.ts`, `packages/ui/src/components/button.spec.tsx`, `packages/ui/src/components/field.spec.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `cn(...classes)`, and `Button`, `Input`, `Label`, `Field`, `Card`, `Alert`, `Badge`, `Skeleton` — each forwarding refs and accepting `className`

- [ ] **Step 1: Write the tokens**

`packages/ui/src/tokens.css`, transcribing `ui-ux/design-system.md` §2–3 and §5–6 exactly. Light
on bare `:root`; dark redefined under **both** guards, so the explicit toggle wins in both
directions and the system default works without one:

```css
@import 'tailwindcss';

:root {
  /* Neutrals — cool ink, not grey. Blue-shifted so the warm severity colours
     sit forward off the surface instead of merging into it. */
  --color-bg: #fbfcfd;
  --color-surface: #ffffff;
  --color-surface-raised: #f5f7f9;
  --color-border: #e3e8ee;
  --color-border-strong: #cbd3dd;
  --color-text: #0e1620;
  --color-text-muted: #5a6774;
  --color-text-subtle: #8494a3;

  /* Severity — the one place this product spends its colour budget.
     Critical is magenta-red, not pure red: pure red is spoken for by
     destructive actions, and a magenta-shifted critical stays distinguishable
     from high-orange under the common forms of colour vision deficiency,
     where red and orange collapse toward each other. */
  --color-severity-critical: #b4126b;
  --color-severity-critical-surface: #fdf0f6;
  --color-severity-high: #c2410c;
  --color-severity-high-surface: #fef3ec;
  --color-severity-medium: #a16207;
  --color-severity-medium-surface: #fdf7e7;
  --color-severity-low: #3d6e9e;
  --color-severity-low-surface: #eff5fa;
  --color-severity-info: #5a6774;
  --color-severity-info-surface: #f3f5f7;

  /* Status and intent. `accent` is deliberately the least interesting colour
     in the system: primary actions need to be findable, not loud. */
  --color-success: #0f7b4f;
  --color-warning: #a16207;
  --color-danger: #c0173a;
  --color-running: #3d6e9e;
  --color-accent: #1f4e7a;

  /* Type — a 1.2 ratio, tight, because density is the point. */
  --text-display: 30px;  --leading-display: 36px;
  --text-title: 24px;    --leading-title: 32px;
  --text-heading: 18px;  --leading-heading: 26px;
  --text-subhead: 15px;  --leading-subhead: 22px;
  --text-body: 14px;     --leading-body: 22px;
  --text-sm: 13px;       --leading-sm: 20px;
  --text-caption: 12px;  --leading-caption: 16px;
  --text-micro: 11px;    --leading-micro: 14px;

  /* Density. Row height, padding and font size move together; a dense table
     with body-size text is harder to scan, not easier. */
  --row-height-comfortable: 44px;
  --row-height-compact: 36px;
  --row-height-dense: 28px;

  /* Restrained radius; elevation carried by borders and background steps. */
  --radius-control: 4px;
  --radius-card: 6px;

  --duration-hover: 120ms;
  --duration-popover: 180ms;
  --duration-drawer: 240ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --color-bg: #0b0f14;
    --color-surface: #121820;
    --color-surface-raised: #1a222c;
    --color-border: #232d39;
    --color-border-strong: #33404f;
    --color-text: #e8edf3;
    --color-text-muted: #94a2b2;
    --color-text-subtle: #6b7987;

    --color-severity-critical: #f2569f;
    --color-severity-critical-surface: #2a0e1e;
    --color-severity-high: #fb923c;
    --color-severity-high-surface: #2a1408;
    --color-severity-medium: #e9b949;
    --color-severity-medium-surface: #251c06;
    --color-severity-low: #7daed6;
    --color-severity-low-surface: #0f1c27;
    --color-severity-info: #94a2b2;
    --color-severity-info-surface: #161c24;

    --color-success: #3fbe86;
    --color-warning: #e9b949;
    --color-danger: #f26b85;
    --color-running: #7daed6;
    --color-accent: #6fa3ce;
  }
}

/* Repeated verbatim so an explicit toggle wins over the system preference in
   both directions. CSS offers no way to alias one declaration block to two
   selectors, and a preprocessor is not worth adding for one duplication. */
:root[data-theme='dark'] {
  --color-bg: #0b0f14;
  --color-surface: #121820;
  --color-surface-raised: #1a222c;
  --color-border: #232d39;
  --color-border-strong: #33404f;
  --color-text: #e8edf3;
  --color-text-muted: #94a2b2;
  --color-text-subtle: #6b7987;

  --color-severity-critical: #f2569f;
  --color-severity-critical-surface: #2a0e1e;
  --color-severity-high: #fb923c;
  --color-severity-high-surface: #2a1408;
  --color-severity-medium: #e9b949;
  --color-severity-medium-surface: #251c06;
  --color-severity-low: #7daed6;
  --color-severity-low-surface: #0f1c27;
  --color-severity-info: #94a2b2;
  --color-severity-info-surface: #161c24;

  --color-success: #3fbe86;
  --color-warning: #e9b949;
  --color-danger: #f26b85;
  --color-running: #7daed6;
  --color-accent: #6fa3ce;
}

/* Tabular numerals everywhere: columns of scores, counts, durations and
   timestamps must align, or scanning down a column stops working. */
html { font-variant-numeric: tabular-nums; }

body {
  background-color: var(--color-bg);
  color: var(--color-text);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: Write the token test**

`packages/ui/src/tokens.spec.ts` parses the CSS and compares declared custom-property names per
block. This is a real test: a token defined only inside a media query is invisible to a viewer
on the system default, which is the most common way a theme silently breaks.

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return [...css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '').sort();
}

describe('design tokens', () => {
  const light = tokensIn(':root {');

  it('defines the full palette on bare :root, so nothing is dark-mode-only', () => {
    expect(light).toContain('--color-bg');
    expect(light).toContain('--color-text');
    expect(light).toContain('--color-accent');
  });

  it('defines all five severity accents and all five severity surfaces', () => {
    for (const level of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(light).toContain(`--color-severity-${level}`);
      expect(light).toContain(`--color-severity-${level}-surface`);
    }
  });

  it('redefines the dark palette under the system media query', () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('redefines the dark palette under the explicit toggle too', () => {
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('defines identical token sets in both dark blocks — a drift here is a theme bug', () => {
    expect(tokensIn(":root:not([data-theme='light'])")).toEqual(
      tokensIn(":root[data-theme='dark']"),
    );
  });

  it('defines every dark token in light as well, so no token exists in only one theme', () => {
    for (const token of tokensIn(":root[data-theme='dark']")) {
      expect(light, token).toContain(token);
    }
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('gives body an explicit background rather than inheriting the host', () => {
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*var\(--color-bg\)/);
  });
});
```

- [ ] **Step 3: Run the token test and verify it passes**

```bash
pnpm vitest run --project unit packages/ui
```
Expected: PASS, 8 tests. If the "identical token sets" assertion fails, one of the two dark
blocks is missing a token — fix the CSS, not the test.

- [ ] **Step 4: Write the primitives**

Each is a thin, `forwardRef`'d wrapper using tokens through Tailwind classes and **no raw hex**
(the lint rule from Task 1 enforces it). Two carry real behaviour:

`button.tsx` — variants `primary`, `secondary`, `ghost`, `danger`; sizes `sm`, `md`. Disabled
while pending, with a visible focus ring on `--color-accent`. Buttons name the outcome, so the
component takes children rather than a `label` prop, and the docblock says so:

```tsx
/**
 * Buttons name the outcome: "Start scan", "Generate report", "Revoke key" —
 * never "Submit", "OK", or "Confirm". The verb stays constant through the
 * flow, so the button that says "Start scan" produces a toast that says
 * "Scan started". See ui-ux/design-system.md §8.
 */
```

`field.tsx` — wires label, control, description, and error together with `aria-describedby` and
`aria-invalid`. A form error not programmatically tied to its input is invisible to a screen
reader, which is why this is a component rather than a convention.

`field.spec.tsx`:
```tsx
describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Organisation name"><input id="name" /></Field>);
    expect(screen.getByLabelText('Organisation name')).toBeInTheDocument();
  });

  it('ties the error message to the control with aria-describedby', () => {
    render(
      <Field label="Email" error="Enter a valid email address.">
        <input id="email" />
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Enter a valid email address.',
    );
  });

  it('marks the control invalid when there is an error', () => {
    render(<Field label="Email" error="Bad."><input id="email" /></Field>);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not mark the control invalid without an error', () => {
    render(<Field label="Email"><input id="email" /></Field>);
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
```

`button.spec.tsx`:
```tsx
describe('Button', () => {
  it('renders its children as the accessible name', () => {
    render(<Button>Start scan</Button>);
    expect(screen.getByRole('button', { name: 'Start scan' })).toBeInTheDocument();
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Start scan</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards a ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Start scan</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('uses no raw hex colour in its class output', () => {
    const { container } = render(<Button variant="danger">Revoke key</Button>);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
```

Add `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom`
as dev dependencies, and give `packages/ui` a `vitest.config.ts` setting
`environment: 'jsdom'` — the workspace default is `node`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): design tokens and base primitives

The full token set from ui-ux/design-system.md: the cool-ink neutral ramp,
the five-step severity ramp, status and intent, the 1.2 type scale, the three
density modes, and the motion durations.

Light is defined on bare :root; dark is redefined under both the
prefers-color-scheme media query and [data-theme="dark"], so the explicit
toggle wins in both directions and the system default works without one. A
test asserts the two dark blocks declare identical token sets and that no
token exists in only one theme — a token defined only inside a media query is
invisible to a viewer on the system default, which is how themes usually
break.

Eight primitives, no raw hex anywhere. Field ties label, description and
error together with aria-describedby, because an error not programmatically
tied to its input is invisible to a screen reader.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `apps/web` — Next.js shell

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/middleware.ts`, `apps/web/playwright.config.ts`
- Create: `apps/web/app/{layout.tsx,globals.css,fonts.ts,providers.tsx}`
- Create: `apps/web/app/(marketing)/page.tsx`, `apps/web/app/(auth)/layout.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/page.tsx`
- Create: `apps/web/app/api/csp-report/route.ts`, `apps/web/app/api/health/route.ts`
- Create: `apps/web/e2e/smoke.spec.ts`
- Test: `apps/web/src/security-headers.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/ui` (tokens and primitives), `@sentinel/config` (`webEnvSchema`)
- Produces: a Next.js app on `WEB_PORT` with the three route groups from `frontend.md` §1
- Produces: `buildSecurityHeaders(nonce: string, enforceCsp: boolean): Record<string, string>` — pure, shared by middleware and its test

- [ ] **Step 1: Write the failing header test**

Extract header construction into a pure function so it is testable without booting Next.

`apps/web/src/security-headers.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers.js';

describe('buildSecurityHeaders', () => {
  it('emits a CSP carrying the supplied nonce', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Content-Security-Policy']).toContain("'nonce-abc123'");
  });

  it('never allows unsafe-inline or unsafe-eval', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('sets frame-ancestors none and object-src none', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('restricts fonts to self, which is what next/font self-hosting buys', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("font-src 'self'");
  });

  it('reports rather than enforces when enforcement is off', () => {
    const headers = buildSecurityHeaders('abc123', false);
    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeDefined();
  });

  it('sets the full header table from transport-and-headers.md §2', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
});
```

- [ ] **Step 2: Run it, verify it fails, then implement `security-headers.ts` and `middleware.ts`**

`middleware.ts` generates a nonce per request with `crypto.randomUUID()`, applies
`buildSecurityHeaders`, and forwards the nonce on a request header so `layout.tsx` can read it
for any `next/script` tag.

- [ ] **Step 3: Self-hosted fonts**

`apps/web/app/fonts.ts` uses `next/font/google` for IBM Plex Sans, IBM Plex Sans Condensed, and
IBM Plex Mono, each with an explicit `fallback` stack:

```ts
/**
 * next/font self-hosts these at build time, which is what keeps
 * `font-src 'self'` true rather than aspirational. A Google Fonts <link> would
 * silently require a CSP exception, and a CSP with exceptions nobody
 * remembers is how a strict policy erodes.
 */
```

Fallbacks per `design-system.md` §2: `ui-sans-serif, system-ui` for the sans faces,
`ui-monospace, SFMono-Regular, Menlo` for the mono.

- [ ] **Step 4: Route groups and placeholder pages**

Three groups per `frontend.md` §1, each with its own layout, and pages that say plainly what is
not built yet. `(marketing)/page.tsx` describes what Sentinel is. `(app)/page.tsx` says the
product is not built and names the current phase. **No mock product UI** — a convincing
screenshot of something that does not exist is the specific illusion this codebase avoids.

`app/api/csp-report/route.ts` accepts violation reports and logs them at `warn`. Wired from day
one, and the reports actually get read; a CSP nobody monitors is decoration
(`transport-and-headers.md` §3).

`app/providers.tsx` sets up TanStack Query plus theme and density context.

- [ ] **Step 5: Write the Playwright smoke spec**

`apps/web/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('the marketing page renders with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('renders in both colour schemes', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  }
});

test('the page does not scroll horizontally at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
```

Add `"test:e2e": "playwright test"` to the root `package.json`. The full E2E suite waits for
Phase 2, when there are journeys to walk.

- [ ] **Step 6: Run it for real, not just in tests**

```bash
pnpm --filter @sentinel/web dev
# Open http://localhost:3000. Confirm by eye: the page renders, the type is
# IBM Plex, and toggling the OS colour scheme changes the theme.
pnpm --filter @sentinel/web build
pnpm test:e2e
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(web): Next.js App Router shell with tokens, fonts, and CSP

Three route groups — (marketing), (auth), (app) — holding placeholder pages
that say plainly what is not built yet. No mock product UI: a convincing
screenshot of something that does not exist is the specific illusion this
codebase avoids.

IBM Plex Sans, Sans Condensed and Mono self-hosted through next/font, which
keeps font-src 'self' true rather than aspirational. Per-request CSP nonce in
middleware, the same header table the API sets, and a /api/csp-report route
wired from day one.

One Playwright smoke spec: renders in both colour schemes, no console errors,
no horizontal overflow at 375px. The full E2E suite waits for Phase 2, when
there are journeys to walk.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: CI checks — OpenAPI diff and tenant registry completeness

The two checks that keep Phase 1's guarantees alive as the product grows.

**Files:**
- Create: `scripts/check-tenant-registry.ts`, `scripts/check-openapi-diff.ts`
- Modify: `.github/workflows/ci.yml`, root `package.json`
- Test: `scripts/check-tenant-registry.spec.ts`

**Interfaces:**
- Consumes: `TENANT_OWNED_MODELS` (Task 6); `generateOpenApiDocument` (Task 11)
- Produces:
  - `pnpm check:registry`, `pnpm check:openapi`
  - `findUnregisteredTenantModels(models: ModelInfo[], registry: readonly string[]): string[]`
  - `findStaleRegistryEntries(models: ModelInfo[], registry: readonly string[]): string[]`
  - `interface ModelInfo { name: string; fields: string[] }`

- [ ] **Step 1: Write the failing registry-check test**

`scripts/check-tenant-registry.spec.ts` — the functions are pure, so no database is needed:
```ts
import { describe, expect, it } from 'vitest';
import {
  findStaleRegistryEntries,
  findUnregisteredTenantModels,
  type ModelInfo,
} from './check-tenant-registry.js';

const membership: ModelInfo = { name: 'Membership', fields: ['id', 'organizationId', 'userId'] };
const asset: ModelInfo = { name: 'Asset', fields: ['id', 'organizationId', 'name'] };
const user: ModelInfo = { name: 'User', fields: ['id', 'email'] };

describe('findUnregisteredTenantModels', () => {
  it('returns nothing when every organizationId model is registered', () => {
    expect(findUnregisteredTenantModels([membership], ['Membership'])).toEqual([]);
  });

  it('reports a model carrying organizationId that is not registered', () => {
    expect(findUnregisteredTenantModels([membership, asset], ['Membership'])).toEqual(['Asset']);
  });

  it('ignores global models', () => {
    expect(findUnregisteredTenantModels([user], [])).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const another: ModelInfo = { name: 'Finding', fields: ['id', 'organizationId'] };
    expect(findUnregisteredTenantModels([asset, another], [])).toEqual(['Asset', 'Finding']);
  });
});

describe('findStaleRegistryEntries', () => {
  it('reports a registered model that no longer carries organizationId', () => {
    expect(findStaleRegistryEntries([{ name: 'Membership', fields: ['id'] }], ['Membership'])).toEqual(
      ['Membership'],
    );
  });

  it('reports a registered model that no longer exists at all', () => {
    expect(findStaleRegistryEntries([], ['Membership'])).toEqual(['Membership']);
  });

  it('returns nothing when the registry is accurate', () => {
    expect(findStaleRegistryEntries([membership], ['Membership'])).toEqual([]);
  });
});
```

Checking both directions matters. A registry that lists a model which lost its `organizationId`
gives false confidence that something is covered when it no longer needs to be — and hides the
fact that a table stopped being tenant-owned, which is itself worth a second look.

- [ ] **Step 2: Run, verify failure, implement**

`scripts/check-tenant-registry.ts` reads model info from the generated Prisma DMMF
(`Prisma.dmmf.datamodel.models`), runs both pure functions, and exits 1 with a message that
tells the reader what to do:

```
Model "Asset" carries organizationId but is not in TENANT_OWNED_MODELS.

A tenant-owned table that is not registered will not be covered by the
cross-tenant isolation harness. Add it to
packages/db/src/tenant-resources.ts, enable RLS on it in a migration, and add
its cross-tenant assertions.

See .claude/development/migrations.md §5.
```

`scripts/check-openapi-diff.ts` regenerates the document, compares it to
`apps/api/openapi.json`, prints a readable diff, and exits 1 on mismatch with:

```
The committed OpenAPI schema does not match what the contracts generate.
Run `pnpm --filter @sentinel/api openapi:generate` and commit the result.
If this diff removes or renames a field, it is a BREAKING change and needs
/api/v2 — see .claude/api/conventions.md §8.
```

- [ ] **Step 3: Prove the check actually fails**

Do not trust a check you have not watched fail.

```bash
# Temporarily remove 'Invitation' from TENANT_OWNED_MODELS
pnpm check:registry
# Expected: exit 1, naming Invitation. Then restore it.
pnpm check:registry
# Expected: exit 0.
```

Do the same for `check:openapi` by hand-editing one field in `apps/api/openapi.json`, running
the check, confirming exit 1, then restoring.

- [ ] **Step 4: Wire both into CI**

Add to `.github/workflows/ci.yml` after the build step:
```yaml
      - name: OpenAPI contract diff
        run: pnpm check:openapi

      - name: Tenant resource registry completeness
        run: pnpm check:registry
```

Add to root `package.json`:
```json
"check:openapi": "node --experimental-strip-types scripts/check-openapi-diff.ts",
"check:registry": "node --experimental-strip-types scripts/check-tenant-registry.ts"
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm check:openapi && pnpm check:registry
git add -A
git commit -m "$(cat <<'EOF'
ci: OpenAPI contract diff and tenant registry completeness checks

check:registry reads the Prisma DMMF and fails the build if any model
carrying organizationId is missing from TENANT_OWNED_MODELS — and also if a
registered model has lost the column, so the registry cannot go stale in
either direction. This is what stops isolation coverage rotting: isolation
bugs do not appear in the code that was reviewed for isolation, they appear
in the table added six months later.

check:openapi fails if the committed schema drifts from what the contracts
generate, so an accidental breaking change is caught in review rather than by
a customer's pipeline.

Both were verified by making them fail before making them pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Reusable skills — `sentinel-phase` and `sentinel-verify`

**Files:**
- Create: `.claude/skills/sentinel-phase/SKILL.md`, `.claude/skills/sentinel-verify/SKILL.md`
- Modify: `.claude/README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing
- Produces: two skills invocable in every future session, Phase 1 through 12 and beyond

- [ ] **Step 1: Write `sentinel-verify`**

`.claude/skills/sentinel-verify/SKILL.md`:
```markdown
---
name: sentinel-verify
description: Use before claiming any work is complete, implemented, working, or passing, and before moving a status in roadmap.md — runs the verification commands, captures their real output, and maps the result onto the Implemented / Partially Implemented / Not Implemented / Blocked vocabulary. Evidence before assertions.
---
```

Body specifies:

1. **Run these, and read the output.** `pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `pnpm test:integration`, `pnpm build`; plus `docker compose ps` when the change touches a
   backing service, and `pnpm check:openapi` / `pnpm check:registry` when it touches the API or
   the schema.
2. **Build the evidence table** — command, exit code, and what that specific command proves.
   A command that was not run has no row.
3. **Map to a status** using specification §79's vocabulary. **Implemented** requires a zero
   exit for every command covering the claim. Anything else is **Partially Implemented** with
   the specific gap named, or **Blocked** with the blocker and its owner.
4. **Write the status.** Never write "Implemented" for a row with no evidence behind it.

Include a red-flags table:

| Thought | Reality |
|---|---|
| "The code looks right" | Not evidence. Run it. |
| "It worked last time" | Not evidence. The tree has changed. |
| "The test file exists" | A test that has not run has proven nothing. |
| "It's just a docs change" | Then `pnpm lint` costs eight seconds. Run it. |
| "CI will catch it" | CI catching it is you shipping a red branch. |
| "It's obviously fine" | Then the command will obviously pass. Run it. |

- [ ] **Step 2: Write `sentinel-phase`**

`.claude/skills/sentinel-phase/SKILL.md`:
```markdown
---
name: sentinel-phase
description: Use when starting, resuming, or finishing a numbered Sentinel build phase — encodes the resuming-work protocol, including verifying a claimed status before building on it and updating roadmap.md in the same change that moves the status.
---
```

Body encodes `.claude/development/resuming-work.md` as an ordered checklist, one todo per item:

1. **Read, in this order:** `CLAUDE.md`, `.claude/product/roadmap.md`,
   `.claude/architecture/overview.md`, the phase's own documents (listed in `overview.md` §8),
   and any relevant ADR. Then `git log --oneline -20` and `git status`.
2. **Verify, do not trust.** For every earlier phase this one builds on that the roadmap calls
   Implemented, run its exit criteria. A status is a claim until a command proves it. Use
   `sentinel-verify`.
3. **Check the Blocked table.** If a blocker has cleared — as the Docker daemon did before
   Phase 1 — correct the roadmap before building on the assumption.
4. **Build** on a `feat/` branch, test-first, committing frequently. Never commit to `main`.
5. **Update `roadmap.md` in the same change that moves the status.** Not afterwards. A stale
   roadmap makes the next session rebuild what exists or skip what does not.
6. **Update every `.claude/` document the change invalidated**, in the same change.
7. **Write an ADR** for any decision expensive to reverse, and add its row to
   `decisions/README.md`. An ADR is immutable once accepted.
8. **End cleanly.** Commit even if the phase is incomplete, and note anything half-finished in
   the roadmap in plain words — "auth done except MFA enrolment; the TOTP secret is generated
   but not persisted" is worth more than any amount of inferred context.

Include the anti-patterns table:

| Anti-pattern | Why it hurts |
|---|---|
| Starting two phases at once | Exit criteria stop being answerable; a half-finished Phase 3 under a half-finished Phase 4 makes both unverifiable. |
| Updating the roadmap at the end | The window between building and recording is exactly when a session ends unexpectedly. |
| Trusting a status without running it | The roadmap is the most-edited file in the repository and therefore the most likely to be wrong. |
| Writing the ADR after the fact | An ADR written to justify what was built records a rationalisation, not a decision. |
| Marking a phase Implemented with one criterion unmet | Partially Implemented is a real, useful status. Use it. |

- [ ] **Step 3: Register the skills in the documentation**

Add a row to the documentation map in `.claude/README.md`:
```markdown
| [`skills/`](skills/) | Project skills: `sentinel-phase`, `sentinel-verify` |
```

Add to `CLAUDE.md` under "Resuming work in a new session":
```markdown
Two project skills automate this protocol: **`sentinel-phase`** for starting, resuming, and
finishing a phase, and **`sentinel-verify`** for turning a completion claim into captured
evidence. Invoke them by name.
```

- [ ] **Step 4: Verify the skills are discoverable**

Start a fresh session in the repository and confirm both appear in the available-skills list and
that invoking `sentinel-verify` loads its body. A skill that is not discovered is a file, not a
skill — and this step is the only way to tell the difference.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: sentinel-phase and sentinel-verify project skills

Two skills usable from Phase 1 through 12.

sentinel-phase encodes development/resuming-work.md as an ordered checklist,
including the rule that makes the protocol work: verify a claimed status by
running it before building on it, and update roadmap.md in the same change
that moves the status.

sentinel-verify turns the honesty rule into a runnable gate. It runs the
verification commands, captures real output, and refuses to write
"Implemented" for anything without a zero exit behind it.

Both were confirmed discoverable in a fresh session — an undiscovered skill
is a file, not a skill.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: ADRs, documentation, roadmap, and the full verification pass

The status moves **last**, and only with evidence behind it.

**Files:**
- Create: `.claude/decisions/ADR-0011-prefixed-uuidv7-identifiers.md`, `.claude/decisions/ADR-0012-node-26-runtime-pin.md`
- Modify: `.claude/decisions/README.md`, `.claude/product/roadmap.md`, `.claude/architecture/repository-audit.md`, `.claude/development/setup.md`

- [ ] **Step 1: Write ADR-0011**

Title states the decision, not the topic: `Prefixed UUIDv7 identifiers, generated in application code`.

- **Context.** Two Phase 0 documents pull in different directions. `database.md` §1 wants
  UUIDv7 for index locality; `api/conventions.md` §1 wants opaque prefixed strings clients must
  not parse.
- **Decision.** UUIDv7, generated in application code, encoded to 26-character Crockford base32,
  with a three-letter entity prefix: `org_01J8XK2P9V3QWERTYUIOPASDF`.
- **Alternatives considered**, each with why it lost: auto-increment integers (enumerable, and
  they leak business volume to anyone who signs up twice); UUIDv4 (random, so every insert lands
  in a different index page and write amplification climbs with table size); bare UUIDv7 (no
  entity information in a log line, so correlating an incident across API, queue, and worker
  means guessing what kind of thing an ID names); database-generated (a round trip before the
  application knows the ID it just created, and awkward for multi-row inserts).
- **Consequences.** 30 bytes per key rather than 16. A `TEXT` primary key rather than `UUID`,
  which costs a little index size and buys the prefix. **And, honestly:** the illustrative IDs
  in the Phase 0 documents are 18 characters where the real ones are 26 — those examples were
  abbreviated for readability and are not normative. The documents are not edited to match,
  because they are illustrations, not specifications.

- [ ] **Step 2: Write ADR-0012**

Title: `Node 26 pinned for development and CI, engines >= 22`.

- **Context.** The host runs v26.7.0. The documents require ≥ 22 LTS. Node 26 reaches LTS in
  October 2026 — before this product serves traffic.
- **Decision.** `.nvmrc` pins 26; CI reads `.nvmrc`; `engines.node` stays `">=22"` so the
  packages remain consumable on the current LTS.
- **Alternatives.** CI on 24 LTS (every dependency officially supports it today, but developing
  on 26 and verifying on 24 means Node 26 failures reach CI rather than the terminal); a 24+26
  matrix (catches both directions, doubles CI minutes, and can wedge on one dependency that is
  not yet Node 26-ready).
- **Consequences**, and an explicit **revisit trigger**: if any dependency lacks Node 26 support,
  or Node 26 LTS slips past October 2026, drop CI to 24 and supersede this ADR.

**If the Task 4 Prisma check forced a fallback**, this ADR records *that* decision instead, with
the captured error, and the status line reads accordingly.

- [ ] **Step 3: Add both index rows to `.claude/decisions/README.md`**

```markdown
| [0011](ADR-0011-prefixed-uuidv7-identifiers.md) | Prefixed UUIDv7 identifiers, generated in application code | Accepted |
| [0012](ADR-0012-node-26-runtime-pin.md) | Node 26 pinned for development and CI, engines >= 22 | Accepted |
```

- [ ] **Step 4: Append the audit addendum**

Append to `.claude/architecture/repository-audit.md`. **Append — do not rewrite.** The audit
recorded what was true on the day it was written; editing it to match today destroys the only
thing it is for.

```markdown
## 7. Addendum — 2026-08-20, Phase 1

Two facts recorded in §3 have changed since the audit. Verified by direct invocation, not
assumed:

| Item | At audit | Now |
|---|---|---|
| Docker **daemon** | **Not running** | **Running** — Docker Desktop, server 29.7.2, `docker compose` v5.4.0 |
| Node.js | v26.2.0 | v26.7.0 |

The Docker change clears risk 1 in §4, which was the single blocking prerequisite for Phase 1
verification. Go and Terraform remain absent; both are still deferred (ADR-0010 and Phase 11
respectively) and neither blocks Phase 1.
```

- [ ] **Step 5: Run the complete verification pass and capture the output**

This is exit criteria 1–5. Run every command and **record its actual output** — the roadmap edit
in Step 6 cites this run, and a citation without a run is the thing the honesty rule exists to
prevent.

```bash
# 1 — clean-clone build
git clean -xdf -e .env
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test

# 2 — compose stack
docker compose up -d
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

# 3 — migration applies, seed is idempotent
pnpm --filter @sentinel/db db:migrate:deploy
pnpm db:seed
pnpm db:seed

# 5 — isolation proven
pnpm test:integration

# build and the CI-only checks
pnpm build
pnpm check:openapi
pnpm check:registry
```

If any command fails, **stop**. Fix it, or record the phase as **Partially Implemented** or
**Blocked** with the specific reason. Do not proceed to Step 6 with a red command.

- [ ] **Step 6: Update `roadmap.md` — with evidence, and only for what passed**

- Update the `## Current state` date.
- Move Phase 1's row to the status the evidence supports.
- Remove the Docker row from the **Blocked items** table.
- Replace the "**No application code exists.**" paragraph with an accurate one.
- Under **Phase 1 — Production foundation**, add a short verification note listing the commands
  that were run and what each proved, then a plain-words list of what was deliberately deferred:

```markdown
*Verified 2026-08-20:* `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`,
`test:integration`, `build`, `check:openapi`, `check:registry` all green from a clean tree;
`docker compose up -d` brings postgres, redis, minio and mailpit to healthy; migrations apply
to an empty database; the seed is idempotent across two runs; the tenant-isolation harness and
the RLS backstop both pass against a real Postgres 16.

*Deliberately deferred, with the phase that picks it up:* workers, scheduler and engine SDKs
(Phase 4); production Dockerfiles and container scanning (Phase 11); the full E2E suite
(Phase 2, when journeys exist — a single smoke spec runs today); authentication, authorization
enforcement and entitlements (Phase 2 — the pipeline slots and the boot-time route access
assertion exist and are empty); CWE, OWASP, plan and engine seed data (the phases that create
those tables).
```

- [ ] **Step 7: Update `setup.md`**

Remove the "**Status: Not Implemented** … Do not follow these steps expecting them to work
today" banner **only if** the steps in it were actually run in Step 5 and worked. Update the
Docker row of the prerequisites table. Where a documented command still does not exist —
`pnpm dev:worker`, the full `pnpm test:e2e` suite, `pnpm test:security` — say so explicitly and
name the phase, rather than leaving the reader to discover it.

- [ ] **Step 8: Final verification and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
docs: Phase 1 ADRs, corrected audit, and verified roadmap status

ADR-0011 records prefixed UUIDv7 identifiers, reconciling the index-locality
requirement in database.md §1 with the opaque-identifier requirement in
conventions.md §1, and notes honestly that the illustrative IDs in the
Phase 0 documents are shorter than the real ones.

ADR-0012 records the Node 26 pin with an explicit revisit trigger.

repository-audit.md gains a dated addendum rather than an edit: the Docker
daemon is now running and Node is v26.7.0. The audit recorded what was true
on the day it was written and is not rewritten to match today.

roadmap.md moves Phase 1 to the status the evidence supports, cites the
commands actually run, and names what was deferred and to which phase.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Run against the spec after the plan was complete.

**1. Spec coverage.** Every spec section maps to at least one task:

| Spec § | Covered by |
|---|---|
| 3.1 Workspace and tooling | Task 1 |
| 3.2 `packages/config` | Task 2 |
| 3.3 `packages/observability` | Task 3 |
| 3.4 `packages/contracts` | Task 5 |
| 3.5 `packages/db` — schema, IDs, tenant client, RLS, registry, seed | Tasks 4, 6, 7 |
| 3.6 `packages/storage` + the two document corrections | Task 8 |
| 3.7 `apps/api` — pipeline, headers, CSP, errors, health, rate limit, route assertion, OpenAPI | Tasks 9, 10, 11 |
| 3.8 `apps/web` and `packages/ui` | Tasks 12, 13 |
| 3.9 Infrastructure — compose, healthchecks, vulnerable target | Task 4 |
| 3.10 CI | Tasks 1, 14 |
| 3.11 Reusable skills | Task 15 |
| §4 Build sequence — Prisma/Node 26 checked early | Task 4 Step 7, with the fallback written out |
| §5 Risks | Task 4 (Prisma), Task 9 (Nest ESM), Task 11 (Zod→OpenAPI) — each with a stated fallback |
| §6 Documentation changed by this phase | Tasks 8, 15, 16 |
| §7 Definition of done | Task 16 Step 5 |

Two gaps found and closed while reviewing:

- **The Zod validation pipe** (spec §3.7) had no task. Folded into Task 9 Step 5, with its unit
  test driving it directly against a schema — there is no request body in Phase 1, so a
  dedicated task would have produced an untestable deliverable.
- **The `/api/csp-report` endpoint** referenced by the CSP `report-uri` had no implementation.
  Added to Task 13 Step 4 on the web side. The spec calls for the report URI to be "wired from
  day one", and a `report-uri` pointing at a 404 is exactly the decorative CSP the document
  warns about.

**2. Placeholder scan.** No "TBD", no "implement later", no "add appropriate error handling".
Tasks 9–13 give some test bodies as named `it(...)` cases with the assertion stated rather than
fully written out; each names the specific condition asserted, which is what an implementer
needs. The load-bearing tasks — 2, 3, 4, 5, 6, 7, 8, 12, 14 — carry complete test and
implementation code.

**3. Type consistency.** Checked across task boundaries:

- `newId(prefix: IdPrefix)` — defined Task 4, used Tasks 6, 7. Consistent.
- `TENANT_OWNED_MODELS` — defined Task 6, consumed Task 14. Consistent.
- `TenantContext { readonly organizationId: string }` — defined Task 6, consumed Task 9. Consistent.
- `PERMISSIONS` / `SYSTEM_ROLES` / `ROLE_PERMISSIONS` — defined Task 5, consumed Task 7. Consistent.
- `startPostgresHarness()` → `{ ownerUrl, appUrl, stop }` — defined Task 6, used Tasks 6, 7.
  Task 4's `migration.integration.spec.ts` predates it and builds its own container; that is
  intentional, since Task 4 is where the harness's own dependencies are first proven to work.
- `DomainError(code, message, status, details?)` — defined Task 9, used Task 10. Consistent.
- `StorageAdapter.head` → `StoredObjectMetadata | null` — defined and used in Task 8. Consistent.
- `buildSecurityHeaders(nonce, enforceCsp)` — defined and used in Task 13. Consistent.
- **One inconsistency found and fixed:** Task 9's `SecurityHeadersMiddleware` constructor
  parameter was named `isProduction` in one draft and `enforceCsp` in another. Settled on
  `enforceCsp`, which says what it controls rather than when it happens to be true.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-phase-1-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
